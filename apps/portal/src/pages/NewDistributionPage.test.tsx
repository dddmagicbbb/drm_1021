import type { CreateDistributionRequest } from "@drm/contracts";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ApiProvider } from "../api/context.js";
import {
  DIST_ID,
  loggedInClient,
  sampleDistribution,
  sampleDocument,
} from "../test/fake-server.js";
import { NewDistributionPage } from "./NewDistributionPage.js";

describe("배포 등록 화면 (T1-18)", () => {
  it("수신자·기간·파일을 입력하면 배포를 만들고 파일을 차례로 올린 뒤 상세로 이동한다", async () => {
    let created: CreateDistributionRequest | null = null;
    const { client } = await loggedInClient({
      "POST /distributions": (body) => {
        created = body as CreateDistributionRequest;
        return { status: 201, body: sampleDistribution() };
      },
    });
    const upload = vi
      .spyOn(client, "uploadDocument")
      .mockImplementation(async (_id, file, onProgress) => {
        onProgress?.(1);
        return sampleDocument({ fileName: file.name });
      });

    const user = userEvent.setup();
    render(
      <ApiProvider client={client}>
        <NewDistributionPage />
      </ApiProvider>,
    );

    await user.type(screen.getByLabelText("배포 제목"), "A사 도면 송부");
    await user.type(
      screen.getByLabelText(/수신자 이메일/),
      "Kim@Customer.co.kr, lee@customer.co.kr",
    );
    expect(screen.getByText(/유효한 수신자 2명/)).toBeInTheDocument();

    const files = [
      new File(["%PDF-1.7"], "도면1.pdf", { type: "application/pdf" }),
      new File(["PK"], "사양서.docx"),
    ];
    await user.upload(screen.getByLabelText(/^문서/), files);
    await user.click(screen.getByRole("button", { name: "배포 등록" }));

    await waitFor(() => expect(window.location.hash).toBe(`#/d/${DIST_ID}`));
    expect(created).toMatchObject({
      title: "A사 도면 송부",
      recipients: ["kim@customer.co.kr", "lee@customer.co.kr"],
      policy: { maxDevices: 2, allowWeb: true },
    });
    expect(Date.parse(created!.policy.validUntil)).toBeGreaterThan(
      Date.parse(created!.policy.validFrom),
    );
    expect(upload.mock.calls.map(([id, file]) => [id, file.name])).toEqual([
      [DIST_ID, "도면1.pdf"],
      [DIST_ID, "사양서.docx"],
    ]);
  });

  it("수신자·파일이 없거나 잘못되면 서버를 호출하지 않고 안내한다", async () => {
    const { client, fetchMock } = await loggedInClient({});
    const user = userEvent.setup();
    render(
      <ApiProvider client={client}>
        <NewDistributionPage />
      </ApiProvider>,
    );
    await user.type(screen.getByLabelText("배포 제목"), "제목");
    await user.click(screen.getByRole("button", { name: "배포 등록" }));
    expect(screen.getByRole("alert")).toHaveTextContent("수신자를 1명 이상");

    await user.type(screen.getByLabelText(/수신자 이메일/), "ok@customer.co.kr bad@");
    await user.click(screen.getByRole("button", { name: "배포 등록" }));
    expect(screen.getByRole("alert")).toHaveTextContent("잘못된 수신자");

    await user.clear(screen.getByLabelText(/수신자 이메일/));
    await user.type(screen.getByLabelText(/수신자 이메일/), "ok@customer.co.kr");
    await user.click(screen.getByRole("button", { name: "배포 등록" }));
    expect(screen.getByRole("alert")).toHaveTextContent("문서를 1개 이상");

    // 로그인 호출 외에는 서버 요청 없음
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual(["/api/v1/auth/login"]);
  });
});
