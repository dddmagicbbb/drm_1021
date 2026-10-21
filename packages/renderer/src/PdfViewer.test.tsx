import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { PdfDocumentHandle, PdfLoader } from "./pdf-loader.js";
import { PdfViewer } from "./PdfViewer.js";

const fakeLoader = (numPages = 3) => {
  const renders: { page: number; scale: number; rotation: number }[] = [];
  const destroy = vi.fn(async () => undefined);
  const loader: PdfLoader = vi.fn(async () => {
    const doc: PdfDocumentHandle = {
      numPages,
      getPage: async (page) => ({
        width: 595,
        height: 842,
        render: async (_canvas, scale, rotation) => {
          renders.push({ page, scale, rotation });
        },
      }),
      destroy,
    };
    return doc;
  });
  return { loader, renders, destroy };
};

const DATA = new Uint8Array([1, 2, 3]);
const WATERMARK = "kim@customer.co.kr · 2026-10-21 09:00 · abcd1234";

describe("PdfViewer (T1-23)", () => {
  it("첫 페이지를 그리고 페이지 이동·확대·회전을 반영한다", async () => {
    const { loader, renders } = fakeLoader(3);
    const user = userEvent.setup();
    render(<PdfViewer data={DATA} watermark={WATERMARK} loader={loader} />);

    expect(await screen.findByText("1 / 3")).toBeInTheDocument();
    await waitFor(() => expect(renders.at(-1)).toEqual({ page: 1, scale: 1, rotation: 0 }));

    await user.click(screen.getByRole("button", { name: "다음" }));
    await user.click(screen.getByRole("button", { name: "다음" }));
    expect(screen.getByText("3 / 3")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "다음" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "확대" }));
    await user.click(screen.getByRole("button", { name: "회전" }));
    await waitFor(() => expect(renders.at(-1)).toEqual({ page: 3, scale: 1.25, rotation: 90 }));
    expect(screen.getByText("125%")).toBeInTheDocument();
  });

  it("키보드로 페이지를 넘긴다", async () => {
    const { loader } = fakeLoader(5);
    const user = userEvent.setup();
    render(<PdfViewer data={DATA} watermark={WATERMARK} loader={loader} />);
    await screen.findByText("1 / 5");
    screen.getByLabelText("문서 보기").focus();
    await user.keyboard("{ArrowRight}{ArrowRight}");
    expect(screen.getByText("3 / 5")).toBeInTheDocument();
    await user.keyboard("{End}");
    expect(screen.getByText("5 / 5")).toBeInTheDocument();
    await user.keyboard("{Home}");
    expect(screen.getByText("1 / 5")).toBeInTheDocument();
  });

  it("다운로드·인쇄 버튼과 텍스트 레이어가 없다", async () => {
    const { loader } = fakeLoader();
    const { container } = render(<PdfViewer data={DATA} watermark={WATERMARK} loader={loader} />);
    await screen.findByText("1 / 3");
    expect(screen.queryByRole("button", { name: /인쇄|다운로드|저장/ })).toBeNull();
    expect(container.querySelector(".textLayer")).toBeNull();
    expect(container.querySelectorAll("canvas")).toHaveLength(1);
  });

  it("워터마크를 문서 위에 반복 표시하고 보조기기에서는 숨긴다", async () => {
    const { loader } = fakeLoader();
    render(<PdfViewer data={DATA} watermark={WATERMARK} loader={loader} />);
    await screen.findByText("1 / 3");
    const overlay = screen.getByTestId("watermark");
    expect(overlay).toHaveAttribute("aria-hidden", "true");
    expect(overlay.querySelectorAll("span").length).toBeGreaterThanOrEqual(20);
    expect(overlay).toHaveTextContent(WATERMARK);
  });

  it("문서를 열 수 없으면 오류를 표시하고, 닫으면 pdf.js 문서를 정리한다", async () => {
    const failing: PdfLoader = async () => {
      throw new Error("Invalid PDF");
    };
    const { unmount } = render(<PdfViewer data={DATA} watermark={WATERMARK} loader={failing} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("문서를 표시할 수 없습니다.");
    unmount();

    const { loader, destroy } = fakeLoader();
    const second = render(<PdfViewer data={DATA} watermark={WATERMARK} loader={loader} />);
    await screen.findByText("1 / 3");
    second.unmount();
    expect(destroy).toHaveBeenCalled();
  });
});
