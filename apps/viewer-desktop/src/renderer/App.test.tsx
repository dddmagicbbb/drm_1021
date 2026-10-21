// @vitest-environment jsdom
import type { RecipientDocument } from "@drm/contracts";
import type { PdfLoader } from "@drm/renderer";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DocumentClosedEvent, DrmBridge, OpenedDocument } from "../shared/ipc.js";
import { App } from "./App.js";
import { BridgeProvider } from "./bridge.js";

afterEach(() => cleanup());

const DOC: RecipientDocument = {
  docId: "6f1c2a3b-4d5e-4f60-8a7b-1c2d3e4f5a6b",
  fileName: "도면.pdf",
  contentType: "application/pdf",
  distributionTitle: "A사 도면 송부",
  validUntil: "2026-11-20T00:00:00.000Z",
  sender: { name: "김발신", email: "kim@company.com" },
};

const opened = (): OpenedDocument => ({
  docId: DOC.docId,
  fileName: "도면.pdf",
  contentType: "application/pdf",
  watermark: "lee@customer.co.kr · 2026-10-21 09:00 · 6f1c2a3b",
  data: new Uint8Array([37, 80, 68, 70, 45, 49]),
});

const fakeLoader: PdfLoader = async () => ({
  numPages: 2,
  getPage: async () => ({ width: 100, height: 100, render: async () => undefined }),
  destroy: async () => undefined,
});

/** 가짜 브리지 (main 프로세스 역할) */
const fakeBridge = (overrides: Partial<DrmBridge> = {}) => {
  let closedListener: ((e: DocumentClosedEvent) => void) | null = null;
  const bridge: DrmBridge = {
    authStatus: vi.fn(async () => ({ ok: true as const, value: { loggedIn: false, email: null } })),
    requestOtp: vi.fn(async () => ({ ok: true as const, value: undefined })),
    verifyOtp: vi.fn(async (email: string) => ({
      ok: true as const,
      value: { loggedIn: true, email },
    })),
    logout: vi.fn(async () => ({ ok: true as const, value: undefined })),
    listDocuments: vi.fn(async () => ({ ok: true as const, value: [DOC] })),
    openRemote: vi.fn(async () => ({ ok: true as const, value: opened() })),
    openPendingFile: vi.fn(async () => ({ ok: true as const, value: null })),
    closeDocument: vi.fn(async () => ({ ok: true as const, value: undefined })),
    onDocumentClosed: (listener) => {
      closedListener = listener;
      return () => {
        closedListener = null;
      };
    },
    onPendingFile: () => () => undefined,
    ...overrides,
  };
  return { bridge, fireClosed: (e: DocumentClosedEvent) => closedListener?.(e) };
};

const renderApp = (bridge: DrmBridge) =>
  render(
    <BridgeProvider bridge={bridge}>
      <App pdfLoader={fakeLoader} />
    </BridgeProvider>,
  );

describe("뷰어 화면 (T1-21~26)", () => {
  it("OTP 로그인 → 문서 목록 → 열기 → 워터마크와 함께 표시 → 닫기", async () => {
    const { bridge } = fakeBridge();
    const user = userEvent.setup();
    renderApp(bridge);

    await user.type(await screen.findByLabelText("이메일"), "lee@customer.co.kr");
    await user.click(screen.getByRole("button", { name: "인증 코드 받기" }));
    await user.type(await screen.findByLabelText("인증 코드"), "12a3456");
    await user.click(screen.getByRole("button", { name: "로그인" }));
    expect(bridge.verifyOtp).toHaveBeenCalledWith("lee@customer.co.kr", "123456");

    await user.click(await screen.findByRole("button", { name: "열기" }));
    expect(bridge.openRemote).toHaveBeenCalledWith(DOC.docId, "도면.pdf.drm");
    expect(await screen.findByText("1 / 2")).toBeInTheDocument();
    expect(screen.getByTestId("watermark")).toHaveTextContent("lee@customer.co.kr");

    await user.click(screen.getByRole("button", { name: "닫기" }));
    expect(bridge.closeDocument).toHaveBeenCalled();
    expect(await screen.findByText("받은 문서")).toBeInTheDocument();
  });

  it("열람 중 회수되면 문서를 지우고 사유·발신자 연락처를 보여준다 (FR-308)", async () => {
    const doc = opened();
    const { bridge, fireClosed } = fakeBridge({
      authStatus: vi.fn(async () => ({
        ok: true as const,
        value: { loggedIn: true, email: "lee@customer.co.kr" },
      })),
      openRemote: vi.fn(async () => ({ ok: true as const, value: doc })),
    });
    const user = userEvent.setup();
    renderApp(bridge);
    await user.click(await screen.findByRole("button", { name: "열기" }));
    await screen.findByText("1 / 2");

    fireClosed({
      docId: DOC.docId,
      error: {
        code: "DOCUMENT_REVOKED",
        message: "발신자가 이 문서를 회수했습니다.",
        contact: { name: "김발신", email: "kim@company.com" },
      },
    });
    const alert = await screen.findByRole("alert", { name: "열람 불가" });
    expect(alert).toHaveTextContent("발신자가 문서를 회수했습니다");
    expect(alert).toHaveTextContent("kim@company.com");
    // 렌더러 쪽 평문 사본 삭제
    expect(doc.data.every((b) => b === 0)).toBe(true);
  });

  it("라이선스 거부(만료)면 문서를 열지 않고 사유를 보여준다", async () => {
    const { bridge } = fakeBridge({
      authStatus: vi.fn(async () => ({
        ok: true as const,
        value: { loggedIn: true, email: "lee@customer.co.kr" },
      })),
      openRemote: vi.fn(async () => ({
        ok: false as const,
        error: { code: "EXPIRED", message: "열람 기간이 만료되었습니다. 발신자에게 문의하세요." },
      })),
    });
    const user = userEvent.setup();
    renderApp(bridge);
    await user.click(await screen.findByRole("button", { name: "열기" }));
    expect(await screen.findByText("열람 기간이 만료되었습니다")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "문서 목록으로" }));
    expect(await screen.findByText("받은 문서")).toBeInTheDocument();
  });

  it("파일 더블클릭으로 전달된 .drm은 로그인 후 바로 연다", async () => {
    const { bridge } = fakeBridge({
      authStatus: vi.fn(async () => ({
        ok: true as const,
        value: { loggedIn: true, email: "lee@customer.co.kr" },
      })),
      openPendingFile: vi.fn(async () => ({ ok: true as const, value: opened() })),
    });
    renderApp(bridge);
    expect(await screen.findByText("1 / 2")).toBeInTheDocument();
    expect(bridge.listDocuments).not.toHaveBeenCalled();
  });

  it("로그인 오류 메시지를 보여준다", async () => {
    const { bridge } = fakeBridge({
      verifyOtp: vi.fn(async () => ({
        ok: false as const,
        error: { code: "OTP_INVALID", message: "인증 코드가 올바르지 않습니다." },
      })),
    });
    const user = userEvent.setup();
    renderApp(bridge);
    await user.type(await screen.findByLabelText("이메일"), "lee@customer.co.kr");
    await user.click(screen.getByRole("button", { name: "인증 코드 받기" }));
    await user.type(await screen.findByLabelText("인증 코드"), "000000");
    await user.click(screen.getByRole("button", { name: "로그인" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("인증 코드가 올바르지 않습니다."),
    );
  });
});
