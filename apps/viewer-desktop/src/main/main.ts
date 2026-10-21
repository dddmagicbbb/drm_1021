/**
 * 뷰어 main 프로세스
 * 복호화·키 처리는 모두 이곳에서 하며, 렌더러에는 IPC로 필요한 결과만 전달합니다.
 */
import { BrowserWindow, Menu, app, ipcMain, session } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  RENDERER_CSP,
  createWindowOptions,
  isAllowedNavigation,
  shouldBlockInput,
} from "./hardening.js";

const here = dirname(fileURLToPath(import.meta.url));
/** 패키징된 빌드에서는 개발자 도구를 막습니다. (DRM_VIEWER_DEVTOOLS=1은 개발용) */
const allowDevTools = !app.isPackaged && process.env.DRM_VIEWER_DEVTOOLS === "1";
const indexPath = join(here, "../renderer/index.html");
const indexUrl = pathToFileURL(indexPath).toString();

let mainWindow: BrowserWindow | null = null;

const createMainWindow = async (): Promise<BrowserWindow> => {
  const win = new BrowserWindow(
    createWindowOptions({ preloadPath: join(here, "../preload/preload.cjs"), allowDevTools }),
  );

  // 화면 캡처 차단: Windows에서 WDA_EXCLUDEFROMCAPTURE (FR-504)
  win.setContentProtection(true);

  const contents = win.webContents;
  contents.on("will-navigate", (event, url) => {
    if (!isAllowedNavigation(url, indexUrl)) event.preventDefault();
  });
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("before-input-event", (event, input) => {
    if (shouldBlockInput(input, allowDevTools)) event.preventDefault();
  });
  contents.on("context-menu", (event) => event.preventDefault());
  if (!allowDevTools) {
    contents.on("devtools-opened", () => contents.closeDevTools());
  }

  win.once("ready-to-show", () => win.show());
  await win.loadFile(indexPath);
  return win;
};

const hardenSession = (): void => {
  const ses = session.defaultSession;
  // 카메라·마이크·알림·클립보드 등 모든 권한 요청 거부
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  // 렌더러의 외부 네트워크 요청 차단 (앱 파일·blob·data만 허용)
  ses.webRequest.onBeforeRequest((details, callback) => {
    const allowed = /^(file|blob|data|devtools):/.test(details.url);
    callback({ cancel: !allowed });
  });
  ses.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: { ...details.responseHeaders, "Content-Security-Policy": [RENDERER_CSP] },
    });
  });
  // 다운로드 차단
  ses.on("will-download", (event) => event.preventDefault());
};

// 하나의 인스턴스만 실행 (두 번째 실행 시 기존 창으로 파일 전달은 T1-21에서 처리)
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // 렌더러에 webview 등 추가 콘텐츠 연결 차단
  app.on("web-contents-created", (_event, contents) => {
    contents.on("will-attach-webview", (event) => event.preventDefault());
  });

  app.on("second-instance", () => {
    if (mainWindow?.isMinimized()) mainWindow.restore();
    mainWindow?.focus();
  });

  app.on("window-all-closed", () => app.quit());

  void app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    hardenSession();
    ipcMain.handle("app:version", () => app.getVersion());
    mainWindow = await createMainWindow();
    mainWindow.on("closed", () => {
      mainWindow = null;
    });
  });
}
