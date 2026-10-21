/**
 * 문서 목록·열기 (ViewerController 확장)
 */
import type { RecipientDocument } from "@drm/contracts";
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import type { OpenedDocument, ViewerError } from "../shared/ipc.js";
import { ViewerController, ViewerInputError } from "./controller.js";
import { DocumentSession } from "./document-session.js";
import type { TrustedKeys } from "./license.js";
import type { SecretStore } from "./secret-store.js";
import type { ServerApi } from "./server-api.js";

/** 메모리에 올릴 .drm 최대 크기 (MVP는 전체를 메모리에서 복호화) */
export const MAX_OPEN_BYTES = 512 * 1024 * 1024;

export class DocumentController extends ViewerController {
  private readonly session: DocumentSession;
  private pendingFile: string | null = null;

  constructor(
    api: ServerApi,
    secrets: SecretStore,
    trustedKeys: () => Promise<TrustedKeys>,
    onClosed: (docId: string, error: ViewerError) => void,
  ) {
    super(api, secrets);
    this.session = new DocumentSession({
      api,
      trustedKeys,
      device: () => this.currentDevice(),
      onClosed,
    });
  }

  listDocuments(): Promise<RecipientDocument[]> {
    return this.api.listDocuments();
  }

  /** 서버에서 .drm을 받아 엽니다. (메모리로만 받음) */
  async openRemote(docId: string, fileName?: string): Promise<OpenedDocument> {
    const drm = await this.api.downloadPackage(docId);
    return this.session.open(drm, fileName ?? `${docId}.drm`);
  }

  /** 파일 더블클릭·두 번째 실행으로 전달된 .drm 경로를 보관 */
  setPendingFile(path: string | null): void {
    this.pendingFile = path;
  }

  get hasPendingFile(): boolean {
    return this.pendingFile !== null;
  }

  /** 보관된 .drm 파일을 엽니다. 로그인 전이면 로그인 후 렌더러가 다시 요청합니다. */
  async openPendingFile(): Promise<OpenedDocument | null> {
    const path = this.pendingFile;
    if (!path) return null;
    const { loggedIn } = await this.authStatus();
    if (!loggedIn) return null;
    this.pendingFile = null;
    const info = await stat(path);
    if (info.size > MAX_OPEN_BYTES) {
      throw new ViewerInputError("파일이 너무 커서 열 수 없습니다.");
    }
    return this.session.open(await readFile(path), basename(path));
  }

  closeDocument(): void {
    this.session.close();
  }

  override async logout(): Promise<void> {
    this.session.close();
    await super.logout();
  }
}
