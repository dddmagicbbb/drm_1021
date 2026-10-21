/**
 * 열람 세션: .drm → 라이선스 → 메모리 복호화 → 주기적 재발급 → 종료 시 폐기
 * 평문은 메모리에만 존재하며 디스크에 쓰지 않습니다. (NFR-S4)
 */
import type { ContainerHeader } from "@drm/contracts";
import { ContainerError, decryptContainer, inspectContainer } from "@drm/container";
import { wipe } from "@drm/crypto";
import type { KeyObject } from "node:crypto";
import type { OpenedDocument, ViewerError } from "../shared/ipc.js";
import {
  LicenseVerificationError,
  type TrustedKeys,
  renewalDelayMs,
  verifyLicense,
} from "./license.js";
import { ServerApiError, type ServerApi } from "./server-api.js";

export interface SessionDevice {
  deviceId: string;
  privateKey: KeyObject;
}

export interface SessionDeps {
  api: Pick<ServerApi, "requestLicense">;
  trustedKeys: () => Promise<TrustedKeys>;
  device: () => Promise<SessionDevice>;
  /** 세션이 강제로 닫힐 때 (회수·만료 등) 렌더러에 알림 */
  onClosed: (docId: string, error: ViewerError) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export const viewerErrorOf = (error: unknown): ViewerError => {
  if (error instanceof ServerApiError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.contact ? { contact: error.contact } : {}),
    };
  }
  if (error instanceof LicenseVerificationError) {
    return { code: "LICENSE_INVALID", message: error.message };
  }
  if (error instanceof ContainerError) {
    return { code: error.code, message: "손상되었거나 변조된 문서 파일입니다." };
  }
  return { code: "INTERNAL_ERROR", message: "문서를 여는 중 오류가 발생했습니다." };
};

export class DocumentSession {
  private current: { docId: string; plaintext: Buffer; timer: unknown } | null = null;

  constructor(private readonly deps: SessionDeps) {}

  get openDocId(): string | null {
    return this.current?.docId ?? null;
  }

  /** .drm 바이트를 열어 평문을 렌더러용으로 반환합니다. 이전 문서는 닫습니다. */
  async open(drm: Uint8Array, fileName: string): Promise<OpenedDocument> {
    this.close();
    const keys = await this.deps.trustedKeys();
    const resolveKey = (kid: string) => keys.get(kid);

    // 헤더 서명을 먼저 검증하고 docId를 얻습니다. (라이선스 요청 전)
    const header: ContainerHeader = await inspectContainer(drm, resolveKey);
    const device = await this.deps.device();
    const signed = await this.deps.api.requestLicense(header.docId, device.deviceId);
    const { payload, cek } = verifyLicense(signed, keys, {
      docId: header.docId,
      deviceId: device.deviceId,
      devicePrivateKey: device.privateKey,
    });

    let plaintext: Buffer;
    try {
      ({ plaintext } = await decryptContainer(drm, cek, resolveKey));
    } finally {
      // CEK는 복호화 직후 폐기 (재발급 시 새로 받음)
      wipe(cek);
    }
    if (payload.contentType !== header.contentType) {
      wipe(plaintext);
      throw new LicenseVerificationError("문서 형식이 라이선스와 다릅니다.");
    }

    const timer = this.schedule(header.docId, renewalDelayMs(payload));
    this.current = { docId: header.docId, plaintext, timer };

    // IPC 직렬화가 렌더러 쪽 사본을 만듭니다. main에는 별도 사본을 만들지 않아,
    // 닫을 때 지우는 버퍼(plaintext)가 main의 유일한 평문입니다.
    const data = new Uint8Array(plaintext.buffer, plaintext.byteOffset, plaintext.byteLength);
    return {
      docId: header.docId,
      fileName: fileName.replace(/\.drm$/i, ""),
      contentType: header.contentType,
      watermark: payload.watermark.text,
      data,
    };
  }

  /** 문서를 닫고 메모리의 평문을 지웁니다. */
  close(): void {
    if (!this.current) return;
    (this.deps.clearTimer ?? clearTimeout)(this.current.timer as never);
    wipe(this.current.plaintext);
    this.current = null;
  }

  /** 만료 전 재발급. 거부되거나 실패하면 문서를 닫고 사유를 알립니다. */
  private schedule(docId: string, delayMs: number): unknown {
    const setTimer = this.deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    return setTimer(() => void this.renew(docId), delayMs);
  }

  private async renew(docId: string): Promise<void> {
    if (this.current?.docId !== docId) return;
    try {
      const keys = await this.deps.trustedKeys();
      const device = await this.deps.device();
      const signed = await this.deps.api.requestLicense(docId, device.deviceId);
      const { payload, cek } = verifyLicense(signed, keys, {
        docId,
        deviceId: device.deviceId,
        devicePrivateKey: device.privateKey,
      });
      wipe(cek);
      if (this.current?.docId === docId) {
        this.current.timer = this.schedule(docId, renewalDelayMs(payload));
      }
    } catch (error) {
      if (this.current?.docId !== docId) return;
      this.close();
      this.deps.onClosed(docId, viewerErrorOf(error));
    }
  }
}
