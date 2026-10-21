/**
 * 뷰어 보안 하드닝 설정 (T1-20)
 * Electron 런타임 없이 검증할 수 있도록 순수 값·함수로 분리합니다.
 * docs/architecture.md §4 Electron 보안 하드닝
 */
import type { BrowserWindowConstructorOptions, Input } from "electron";

/**
 * 렌더러 CSP
 * 렌더러는 네트워크에 직접 접근하지 않고 IPC로만 main과 통신합니다. (connect-src 'none')
 * pdf.js 워커는 번들 파일(self)과 blob URL을 사용합니다.
 */
export const RENDERER_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

export const createWindowOptions = (options: {
  preloadPath: string;
  allowDevTools: boolean;
}): BrowserWindowConstructorOptions => ({
  width: 1280,
  height: 860,
  minWidth: 800,
  minHeight: 600,
  show: false,
  title: "DRM 보안 뷰어",
  backgroundColor: "#2b2f36",
  autoHideMenuBar: true,
  webPreferences: {
    preload: options.preloadPath,
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    navigateOnDragDrop: false,
    spellcheck: false,
    safeDialogs: true,
    devTools: options.allowDevTools,
  },
});

/** 앱 내부 페이지(file://.../renderer/index.html)만 허용, 그 외 이동은 차단 */
export const isAllowedNavigation = (url: string, appIndexUrl: string): boolean => {
  try {
    const target = new URL(url);
    const index = new URL(appIndexUrl);
    return target.protocol === index.protocol && target.pathname === index.pathname;
  } catch {
    return false;
  }
};

/**
 * 차단할 단축키 (FR-501~503)
 * 인쇄·저장·복사·전체 선택·소스 보기·개발자 도구·새로고침(평문 재로딩 방지)
 */
export const shouldBlockInput = (
  input: Pick<Input, "type" | "key" | "control" | "meta" | "shift" | "alt">,
  allowDevTools: boolean,
): boolean => {
  if (input.type !== "keyDown") return false;
  const key = input.key.toLowerCase();
  const mod = input.control || input.meta;
  if (key === "printscreen") return true;
  if (mod && ["p", "s", "c", "x", "a", "u", "r", "o"].includes(key)) return true;
  if (key === "f5") return true;
  if (!allowDevTools) {
    if (key === "f12") return true;
    if (mod && input.shift && ["i", "j", "c"].includes(key)) return true;
  }
  return false;
};
