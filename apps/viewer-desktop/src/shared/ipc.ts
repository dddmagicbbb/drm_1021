/**
 * main ↔ renderer IPC 계약
 * preload는 이 목록의 채널만 노출합니다. 렌더러는 네트워크·파일에 직접 접근하지 않습니다.
 */
import type { DenyReason, PackagedContentType, RecipientDocument } from "@drm/contracts";

export const IPC = {
  authStatus: "auth:status",
  requestOtp: "auth:request-otp",
  verifyOtp: "auth:verify-otp",
  logout: "auth:logout",
  listDocuments: "docs:list",
  openRemote: "docs:open-remote",
  openPendingFile: "docs:open-pending-file",
  closeDocument: "docs:close",
  /** main → renderer 이벤트 */
  documentClosed: "doc:closed",
  pendingFile: "file:pending",
} as const;

export interface AuthStatus {
  loggedIn: boolean;
  email: string | null;
}

/** 렌더러로 전달하는 오류 (메시지는 사용자 표시용) */
export interface ViewerError {
  code: DenyReason | string;
  message: string;
  contact?: { name: string; email: string };
}

export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: ViewerError };

export interface OpenedDocument {
  docId: string;
  fileName: string;
  contentType: PackagedContentType;
  watermark: string;
  /** 복호화된 콘텐츠 (메모리 전용, 디스크에 쓰지 않음) */
  data: ArrayBuffer;
}

export interface DocumentClosedEvent {
  docId: string;
  error: ViewerError;
}

/** preload가 window.drm으로 노출하는 API */
export interface DrmBridge {
  authStatus(): Promise<IpcResult<AuthStatus>>;
  requestOtp(email: string): Promise<IpcResult<void>>;
  verifyOtp(email: string, code: string): Promise<IpcResult<AuthStatus>>;
  logout(): Promise<IpcResult<void>>;
  listDocuments(): Promise<IpcResult<RecipientDocument[]>>;
  openRemote(docId: string): Promise<IpcResult<OpenedDocument>>;
  openPendingFile(): Promise<IpcResult<OpenedDocument | null>>;
  closeDocument(): Promise<IpcResult<void>>;
  onDocumentClosed(listener: (event: DocumentClosedEvent) => void): () => void;
  onPendingFile(listener: () => void): () => void;
}
