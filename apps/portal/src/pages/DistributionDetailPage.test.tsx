import type { UpdateDistributionRequest } from "@drm/contracts";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ApiProvider } from "../api/context.js";
import {
  DIST_ID,
  RECIPIENT_ID,
  loggedInClient,
  sampleDistribution,
  sampleDocument,
} from "../test/fake-server.js";
import { DistributionDetailPage } from "./DistributionDetailPage.js";

const renderPage = async (routes: Parameters<typeof loggedInClient>[0]) => {
  const { client, fetchMock } = await loggedInClient(routes);
  render(
    <ApiProvider client={client}>
      <DistributionDetailPage id={DIST_ID} />
    </ApiProvider>,
  );
  return { client, fetchMock };
};

describe("배포 관리 화면 (T1-19)", () => {
  it("문서 상태·실패 사유·수신자를 보여준다", async () => {
    await renderPage({
      [`GET /distributions/${DIST_ID}`]: () => ({
        status: 200,
        body: sampleDistribution({
          documents: [
            sampleDocument(),
            sampleDocument({
              id: "7b1c2a3b-4d5e-4f60-8a7b-1c2d3e4f5a6b",
              fileName: "깨진.docx",
              status: "FAILED",
              failureReason: "문서를 PDF로 변환할 수 없습니다.",
            }),
          ],
        }),
      }),
    });
    expect(await screen.findByText("A사 도면 송부")).toBeInTheDocument();
    expect(screen.getByText("배포 완료")).toBeInTheDocument();
    expect(screen.getByText("문서를 PDF로 변환할 수 없습니다.")).toBeInTheDocument();
    expect(screen.getByText("kim@customer.co.kr")).toBeInTheDocument();
  });

  it("처리 중인 문서가 있으면 상태를 다시 조회한다", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let calls = 0;
      await renderPage({
        [`GET /distributions/${DIST_ID}`]: () => {
          calls += 1;
          const status = calls < 2 ? "CONVERTING" : "PACKAGED";
          return {
            status: 200,
            body: sampleDistribution({ documents: [sampleDocument({ status })] }),
          };
        },
      });
      expect(await screen.findByText("변환·암호화 중")).toBeInTheDocument();
      await vi.advanceTimersByTimeAsync(3500);
      expect(await screen.findByText("배포 완료")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("수신자 권한 회수는 확인 후 요청하고 화면을 갱신한다", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const { fetchMock } = await renderPage({
      [`GET /distributions/${DIST_ID}`]: () => ({ status: 200, body: sampleDistribution() }),
      [`POST /distributions/${DIST_ID}/recipients/${RECIPIENT_ID}/revoke`]: () => ({
        status: 200,
        body: sampleDistribution({
          recipients: [
            {
              recipientId: RECIPIENT_ID,
              email: "kim@customer.co.kr",
              revokedAt: "2026-10-22T00:00:00.000Z",
              addedAt: "2026-10-21T00:00:00.000Z",
            },
          ],
        }),
      }),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "권한 회수" }));
    const row = screen.getByText("kim@customer.co.kr").closest("tr")!;
    await waitFor(() => expect(within(row).getByText("회수됨")).toBeInTheDocument());
    expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith("/revoke"))).toBe(true);
  });

  it("확인을 취소하면 회수하지 않는다", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const { fetchMock } = await renderPage({
      [`GET /distributions/${DIST_ID}`]: () => ({ status: 200, body: sampleDistribution() }),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "배포 전체 회수" }));
    expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith("/revoke"))).toBe(false);
  });

  it("수신자를 추가하고 만료일을 바꾼다", async () => {
    const patches: UpdateDistributionRequest[] = [];
    await renderPage({
      [`GET /distributions/${DIST_ID}`]: () => ({ status: 200, body: sampleDistribution() }),
      [`PATCH /distributions/${DIST_ID}`]: (body) => {
        patches.push(body as UpdateDistributionRequest);
        return { status: 200, body: sampleDistribution() };
      },
    });
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText("수신자 추가"), "new@customer.co.kr");
    await user.click(screen.getByRole("button", { name: "수신자 추가" }));
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toEqual({ addRecipients: ["new@customer.co.kr"] });

    const until = screen.getByLabelText("만료일 변경 (연장·단축)");
    await user.clear(until);
    await user.type(until, "2026-12-31T18:00");
    await user.click(screen.getByRole("button", { name: "기간 변경" }));
    await waitFor(() => expect(patches).toHaveLength(2));
    expect(patches[1]?.policy?.validUntil).toBe(new Date("2026-12-31T18:00").toISOString());
  });

  it("회수된 배포 건은 변경 버튼을 숨긴다", async () => {
    await renderPage({
      [`GET /distributions/${DIST_ID}`]: () => ({
        status: 200,
        body: sampleDistribution({ state: "REVOKED", revokedAt: "2026-10-22T00:00:00.000Z" }),
      }),
    });
    expect(await screen.findByText("회수됨", { selector: ".badge" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "배포 전체 회수" })).toBeNull();
    expect(screen.queryByRole("button", { name: "회수" })).toBeNull();
    expect(screen.queryByLabelText("문서 추가")).toBeNull();
  });
});
