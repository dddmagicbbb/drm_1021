/**
 * 가시 워터마크 (FR-505)
 * 수신자·발급 시각·문서 ID 문구를 대각선으로 반복 표시합니다.
 * 화면 촬영 등으로 유출되어도 유출자를 식별할 수 있게 하는 것이 목적입니다.
 */
const ROWS = 8;
const COLS = 4;

export const WatermarkOverlay = ({ text }: { text: string }) => (
  <div className="drm-watermark" aria-hidden="true" data-testid="watermark">
    {Array.from({ length: ROWS * COLS }, (_, i) => (
      <span key={i} className="drm-watermark__item">
        {text}
      </span>
    ))}
  </div>
);

/** 뷰어 컴포넌트 스타일 (앱이 CSS 파일 없이 바로 쓸 수 있게 문자열로 제공) */
export const RENDERER_STYLES = `
.drm-pdf { display: flex; flex-direction: column; height: 100%; outline: none; user-select: none; }
.drm-pdf__toolbar { display: flex; gap: 8px; align-items: center; padding: 8px 12px; background: #1f2329; color: #fff; }
.drm-pdf__toolbar button { background: #3a404a; color: #fff; border: 0; border-radius: 4px; padding: 4px 10px; cursor: pointer; }
.drm-pdf__toolbar button:disabled { opacity: .4; cursor: default; }
.drm-pdf__sep { flex: 1; }
.drm-pdf__stage { flex: 1; overflow: auto; display: flex; justify-content: center; padding: 24px; background: #2b2f36; }
.drm-pdf__page { position: relative; align-self: flex-start; box-shadow: 0 2px 12px rgba(0,0,0,.4); background: #fff; }
.drm-pdf__page canvas { display: block; pointer-events: none; }
.drm-pdf__error { color: #fff; }
.drm-watermark { position: absolute; inset: 0; overflow: hidden; pointer-events: none; display: grid;
  grid-template-columns: repeat(${COLS}, 1fr); grid-template-rows: repeat(${ROWS}, 1fr); align-items: center; justify-items: center; }
.drm-watermark__item { transform: rotate(-30deg); white-space: nowrap; font-size: 13px; color: rgba(40, 40, 40, .16);
  font-weight: 600; user-select: none; }
`;
