/**
 * 렌더러에 노출하는 최소 API (contextBridge → window.drm)
 * sandbox preload는 CommonJS여야 합니다. 채널 이름은 shared/ipc.ts의 IPC와 같아야 합니다.
 * (sandbox preload는 로컬 모듈을 require할 수 없어 채널 이름을 여기에 다시 적습니다.)
 */
import electron = require("electron");

const { contextBridge, ipcRenderer } = electron;

const invoke = (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args);

const subscribe = (channel: string, listener: (...args: unknown[]) => void) => {
  const wrapped = (_event: unknown, ...args: unknown[]) => listener(...args);
  ipcRenderer.on(channel, wrapped);
  return () => {
    ipcRenderer.removeListener(channel, wrapped);
  };
};

contextBridge.exposeInMainWorld("drm", {
  authStatus: () => invoke("auth:status"),
  requestOtp: (email: string) => invoke("auth:request-otp", email),
  verifyOtp: (email: string, code: string) => invoke("auth:verify-otp", email, code),
  logout: () => invoke("auth:logout"),
  listDocuments: () => invoke("docs:list"),
  openRemote: (docId: string, fileName?: string) => invoke("docs:open-remote", docId, fileName),
  openPendingFile: () => invoke("docs:open-pending-file"),
  closeDocument: () => invoke("docs:close"),
  onDocumentClosed: (listener: (event: unknown) => void) => subscribe("doc:closed", listener),
  onPendingFile: (listener: () => void) => subscribe("file:pending", listener),
});
