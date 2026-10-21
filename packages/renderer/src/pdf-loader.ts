/**
 * pdf.js 로더 (데스크톱·웹 뷰어 공용)
 * 텍스트 레이어·주석 레이어를 만들지 않으므로 텍스트 선택·복사·링크 이동이 불가능합니다.
 */

export interface PdfPageHandle {
  /** 회전 0일 때 배율 1의 크기 (pt) */
  readonly width: number;
  readonly height: number;
  render(canvas: HTMLCanvasElement, scale: number, rotation: number): Promise<void>;
}

export interface PdfDocumentHandle {
  readonly numPages: number;
  getPage(pageNumber: number): Promise<PdfPageHandle>;
  destroy(): Promise<void>;
}

export type PdfLoader = (data: Uint8Array) => Promise<PdfDocumentHandle>;

/** 앱 시작 시 한 번 pdf.js 워커 위치를 지정합니다. (번들러가 제공하는 URL) */
export const configurePdfWorker = async (workerSrc: string): Promise<void> => {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
};

export const pdfjsLoader: PdfLoader = async (data) => {
  const pdfjs = await import("pdfjs-dist");
  // pdf.js는 전달한 버퍼를 워커로 넘기며(transfer) 원본을 비웁니다. 호출자 버퍼 보존을 위해 사본을 넘깁니다.
  const task = pdfjs.getDocument({
    data: data.slice(),
    enableXfa: false,
    // 문서 내 스크립트(JavaScript) 실행 안 함
    disableAutoFetch: true,
    stopAtErrors: false,
  });
  const doc = await task.promise;
  return {
    numPages: doc.numPages,
    getPage: async (pageNumber) => {
      const page = await doc.getPage(pageNumber);
      const base = page.getViewport({ scale: 1, rotation: 0 });
      return {
        width: base.width,
        height: base.height,
        render: async (canvas, scale, rotation) => {
          const ratio = globalThis.devicePixelRatio || 1;
          const viewport = page.getViewport({ scale: scale * ratio, rotation });
          canvas.width = Math.floor(viewport.width);
          canvas.height = Math.floor(viewport.height);
          canvas.style.width = `${Math.floor(viewport.width / ratio)}px`;
          canvas.style.height = `${Math.floor(viewport.height / ratio)}px`;
          await page.render({ canvas, viewport }).promise;
        },
      };
    },
    destroy: () => task.destroy(),
  };
};
