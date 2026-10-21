/**
 * 뷰어 → 서버 API (main 프로세스 전용)
 * access 토큰은 메모리에, refresh 토큰은 SecretStore(DPAPI)에 보관합니다.
 */
import {
  ApiErrorSchema,
  RecipientDocumentSchema,
  RegisterDeviceResponseSchema,
  SignedLicenseSchema,
  TokenResponseSchema,
  type ApiError,
  type DevicePlatform,
  type RecipientDocument,
  type SignedLicense,
} from "@drm/contracts";
import { z, type ZodType } from "zod";
import type { SecretStore } from "./secret-store.js";

const REFRESH_SECRET = "recipient-refresh-token";
const EMAIL_SECRET = "recipient-email";

export class ServerApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly contact?: ApiError["error"]["contact"],
  ) {
    super(message);
  }
}

export class ServerApi {
  private accessToken: string | null = null;
  private refreshing: Promise<boolean> | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly secrets: SecretStore,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
  ) {}

  /** 저장된 로그인 이메일 (refresh 토큰이 있을 때만 의미 있음) */
  async savedEmail(): Promise<string | null> {
    const hasRefresh = await this.secrets.load(REFRESH_SECRET);
    const email = await this.secrets.load(EMAIL_SECRET);
    return hasRefresh && email ? email.toString("utf8") : null;
  }

  async requestOtp(email: string): Promise<void> {
    await this.call("POST", "/recipient-auth/otp/request", { email }, z.unknown(), false);
  }

  async verifyOtp(email: string, code: string): Promise<void> {
    const tokens = await this.call(
      "POST",
      "/recipient-auth/otp/verify",
      { email, code },
      TokenResponseSchema,
      false,
    );
    this.accessToken = tokens.accessToken;
    await this.secrets.save(REFRESH_SECRET, Buffer.from(tokens.refreshToken));
    await this.secrets.save(EMAIL_SECRET, Buffer.from(email));
  }

  async logout(): Promise<void> {
    this.accessToken = null;
    await this.secrets.delete(REFRESH_SECRET);
    await this.secrets.delete(EMAIL_SECRET);
  }

  async registerDevice(publicKey: Buffer, name: string, platform: DevicePlatform): Promise<string> {
    const res = await this.call(
      "POST",
      "/devices",
      { publicKey: publicKey.toString("base64url"), name, platform },
      RegisterDeviceResponseSchema,
    );
    return res.deviceId;
  }

  listDocuments(): Promise<RecipientDocument[]> {
    return this.call("GET", "/recipient/documents", undefined, z.array(RecipientDocumentSchema));
  }

  /** .drm 다운로드 (메모리로만 받음) */
  async downloadPackage(docId: string): Promise<Buffer> {
    const res = await this.request("GET", `/recipient/documents/${docId}/package`, undefined, true);
    return Buffer.from(await res.arrayBuffer());
  }

  requestLicense(docId: string, deviceId: string): Promise<SignedLicense> {
    return this.call("POST", "/licenses", { docId, deviceId }, SignedLicenseSchema);
  }

  /** 개발용: 서버 서명 공개키 목록 */
  signingKeys(): Promise<{ kid: string; publicKey: string }[]> {
    return this.call(
      "GET",
      "/keys/signing",
      undefined,
      z.object({ keys: z.array(z.object({ kid: z.string(), publicKey: z.string() })) }),
      false,
    ).then((r) => r.keys);
  }

  private async call<T>(
    method: string,
    path: string,
    body: unknown,
    schema: ZodType<T>,
    auth = true,
  ): Promise<T> {
    const res = await this.request(method, path, body, auth);
    const data: unknown = res.status === 202 || res.status === 204 ? null : await res.json();
    return schema.parse(data);
  }

  private async request(
    method: string,
    path: string,
    body: unknown,
    auth: boolean,
  ): Promise<Response> {
    if (auth && !this.accessToken) await this.refresh();
    const send = async () => {
      try {
        return await this.fetchImpl(`${this.baseUrl}/api/v1${path}`, {
          method,
          headers: {
            ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
            ...(auth && this.accessToken ? { Authorization: `Bearer ${this.accessToken}` } : {}),
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
      } catch (error) {
        const networkError = new ServerApiError(
          0,
          "NETWORK_ERROR",
          "서버에 연결할 수 없습니다. 네트워크를 확인하세요.",
        );
        networkError.cause = error;
        throw networkError;
      }
    };
    let res = await send();
    if (res.status === 401 && auth && (await this.refresh())) res = await send();
    if (!res.ok) {
      const parsed = ApiErrorSchema.safeParse(await res.json().catch(() => null));
      if (res.status === 401 && auth) await this.logout();
      if (parsed.success) {
        const { code, message, contact } = parsed.data.error;
        throw new ServerApiError(res.status, code, message, contact);
      }
      throw new ServerApiError(
        res.status,
        "INTERNAL_ERROR",
        `서버 오류가 발생했습니다. (HTTP ${res.status})`,
      );
    }
    return res;
  }

  private refresh(): Promise<boolean> {
    this.refreshing ??= (async () => {
      const saved = await this.secrets.load(REFRESH_SECRET);
      if (!saved) return false;
      try {
        const res = await this.fetchImpl(`${this.baseUrl}/api/v1/recipient-auth/refresh`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refreshToken: saved.toString("utf8") }),
        });
        if (!res.ok) {
          if (res.status === 401) await this.logout();
          return false;
        }
        const tokens = TokenResponseSchema.parse(await res.json());
        this.accessToken = tokens.accessToken;
        await this.secrets.save(REFRESH_SECRET, Buffer.from(tokens.refreshToken));
        return true;
      } catch {
        return false;
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }
}
