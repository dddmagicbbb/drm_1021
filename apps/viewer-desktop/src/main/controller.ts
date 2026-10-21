/**
 * 뷰어 동작 조정 (Electron과 분리된 main 프로세스 로직)
 * main.ts는 IPC를 이 클래스의 메서드로 연결만 합니다.
 */
import { EmailSchema, OtpVerifyRequestSchema } from "@drm/contracts";
import type { AuthStatus, IpcResult, ViewerError } from "../shared/ipc.js";
import { type DeviceIdentity, ensureDevice } from "./device.js";
import type { SecretStore } from "./secret-store.js";
import { viewerErrorOf } from "./document-session.js";
import { type ServerApi, ServerApiError } from "./server-api.js";

/** 예외를 렌더러용 결과로 변환 (내부 오류 상세는 숨김) */
export const toIpcError = (error: unknown): ViewerError =>
  error instanceof ViewerInputError
    ? { code: "VALIDATION_FAILED", message: error.message }
    : viewerErrorOf(error);

export class ViewerInputError extends Error {}

export const asResult = async <T>(
  work: () => Promise<T>,
  onError?: (error: unknown) => void,
): Promise<IpcResult<T>> => {
  try {
    return { ok: true, value: await work() };
  } catch (error) {
    onError?.(error);
    return { ok: false, error: toIpcError(error) };
  }
};

export class ViewerController {
  protected email: string | null = null;
  protected device: DeviceIdentity | null = null;

  constructor(
    protected readonly api: ServerApi,
    protected readonly secrets: SecretStore,
  ) {}

  /** 앱 시작 시 저장된 로그인으로 복구 */
  async authStatus(): Promise<AuthStatus> {
    if (!this.email) this.email = await this.api.savedEmail();
    return { loggedIn: this.email !== null, email: this.email };
  }

  async requestOtp(rawEmail: string): Promise<void> {
    const parsed = EmailSchema.safeParse(rawEmail);
    if (!parsed.success) throw new ViewerInputError("이메일 주소를 확인하세요.");
    await this.api.requestOtp(parsed.data);
  }

  /** OTP 검증 → 토큰 저장 → 기기 등록 */
  async verifyOtp(rawEmail: string, rawCode: string): Promise<AuthStatus> {
    const parsed = OtpVerifyRequestSchema.safeParse({ email: rawEmail, code: rawCode.trim() });
    if (!parsed.success) throw new ViewerInputError("인증 코드 6자리를 입력하세요.");
    await this.api.verifyOtp(parsed.data.email, parsed.data.code);
    this.email = parsed.data.email;
    this.device = await ensureDevice(this.email, this.secrets, this.api);
    return { loggedIn: true, email: this.email };
  }

  async logout(): Promise<void> {
    await this.api.logout();
    this.email = null;
    this.device = null;
  }

  /** 기기 정보 (필요할 때 등록) */
  protected async currentDevice(): Promise<DeviceIdentity> {
    if (this.device) return this.device;
    const { email } = await this.authStatus();
    if (!email) throw new ServerApiError(401, "UNAUTHENTICATED", "로그인이 필요합니다.");
    this.device = await ensureDevice(email, this.secrets, this.api);
    return this.device;
  }
}
