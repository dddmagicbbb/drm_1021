import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { type PdfDocumentHandle, type PdfLoader, pdfjsLoader } from "./pdf-loader.js";
import { WatermarkOverlay } from "./WatermarkOverlay.js";

export interface PdfViewerProps {
  /** 복호화된 PDF (메모리) */
  data: Uint8Array;
  /** 화면에 반복 표시할 워터마크 문구 (FR-505) */
  watermark: string;
  /** 테스트·웹 뷰어에서 로더 교체용 */
  loader?: PdfLoader;
}

const MIN_SCALE = 0.25;
const MAX_SCALE = 5;
const STEP = 1.25;

/**
 * PDF 뷰어 (FR-303)
 * 페이지 이동, 확대·축소, 회전. 다운로드·인쇄·텍스트 선택 기능은 의도적으로 없습니다.
 */
export const PdfViewer = ({ data, watermark, loader = pdfjsLoader }: PdfViewerProps) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [doc, setDoc] = useState<PdfDocumentHandle | null>(null);
  const [page, setPage] = useState(1);
  const [scale, setScale] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let loaded: PdfDocumentHandle | null = null;
    setDoc(null);
    setError(null);
    setPage(1);
    loader(data)
      .then((handle) => {
        loaded = handle;
        if (cancelled) void handle.destroy();
        else setDoc(handle);
      })
      .catch(() => {
        if (!cancelled) setError("문서를 표시할 수 없습니다.");
      });
    return () => {
      cancelled = true;
      void loaded?.destroy();
    };
  }, [data, loader]);

  useEffect(() => {
    if (!doc || !canvasRef.current) return;
    let cancelled = false;
    const canvas = canvasRef.current;
    doc
      .getPage(page)
      .then((p) => (cancelled ? undefined : p.render(canvas, scale, rotation)))
      .catch(() => {
        if (!cancelled) setError(`${page}페이지를 표시할 수 없습니다.`);
      });
    return () => {
      cancelled = true;
    };
  }, [doc, page, scale, rotation]);

  const numPages = doc?.numPages ?? 0;
  const go = useCallback(
    (n: number) => setPage((current) => (numPages ? Math.min(Math.max(n, 1), numPages) : current)),
    [numPages],
  );
  const zoom = (factor: number) =>
    setScale((s) => Math.min(Math.max(Number((s * factor).toFixed(3)), MIN_SCALE), MAX_SCALE));

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowRight" || e.key === "PageDown") go(page + 1);
    else if (e.key === "ArrowLeft" || e.key === "PageUp") go(page - 1);
    else if (e.key === "Home") go(1);
    else if (e.key === "End") go(numPages);
    else if (e.key === "+" || e.key === "=") zoom(STEP);
    else if (e.key === "-") zoom(1 / STEP);
    else return;
    e.preventDefault();
  };

  return (
    <div className="drm-pdf" tabIndex={0} onKeyDown={onKeyDown} aria-label="문서 보기">
      <div className="drm-pdf__toolbar" role="toolbar" aria-label="문서 도구">
        <button type="button" onClick={() => go(page - 1)} disabled={page <= 1}>
          이전
        </button>
        <span aria-live="polite">{numPages ? `${page} / ${numPages}` : "-"}</span>
        <button type="button" onClick={() => go(page + 1)} disabled={!numPages || page >= numPages}>
          다음
        </button>
        <span className="drm-pdf__sep" />
        <button type="button" onClick={() => zoom(1 / STEP)} aria-label="축소">
          −
        </button>
        <span>{Math.round(scale * 100)}%</span>
        <button type="button" onClick={() => zoom(STEP)} aria-label="확대">
          +
        </button>
        <button type="button" onClick={() => setScale(1)}>
          100%
        </button>
        <button type="button" onClick={() => setRotation((r) => (r + 90) % 360)} aria-label="회전">
          회전
        </button>
      </div>
      <div className="drm-pdf__stage">
        {error ? (
          <p role="alert" className="drm-pdf__error">
            {error}
          </p>
        ) : (
          <div className="drm-pdf__page">
            <canvas ref={canvasRef} aria-label={`${page}페이지`} />
            <WatermarkOverlay text={watermark} />
          </div>
        )}
      </div>
    </div>
  );
};
