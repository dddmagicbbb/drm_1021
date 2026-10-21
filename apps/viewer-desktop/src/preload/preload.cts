/**
 * 렌더러에 노출하는 최소 API (contextBridge)
 * sandbox preload는 CommonJS여야 합니다.
 * 노출 채널은 shared/ipc.ts 목록과 일치해야 합니다.
 */
import electron = require("electron");

const { contextBridge, ipcRenderer } = electron;

contextBridge.exposeInMainWorld("drm", {
  version: () => ipcRenderer.invoke("app:version") as Promise<string>,
});
