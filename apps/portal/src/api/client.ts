/**
 * 발신자 포털 API 클라이언트
 * - 응답은 @drm/contracts 스키마로 검증합니다.
 * - access 토큰은 메모리에만, refresh 토큰은 탭 단위 sessionStorage에 둡니다.
 *   (localStorage보다 노출 범위가 좁고, 탭을 닫으면 사라짐)
 * - 401이면 refresh로 한 번 재시도합니다.
 */
import {
  ApiErrorSchema,
  DistributionSchema,
  DistributionSummarySchema,
  DocumentSchema,
  TokenResponseSchema,
  type ApiError as ApiErrorBody,
  type CreateDistributionRequest,
  type Distribution,
  type DistributionSummary,
  type Document,
  type UpdateDistributionRequest,
} from "@drm/contracts";
import { z, type ZodType } from "zod";

export const API_BASE = "/api/v1";
const REFRESH_KEY = "drm.portal.refreshToken";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorBody["error"]["code"] | "NETWORK_ERROR",
    message: string,
    readonly issues: { path: string; message: string }[] = [],
  ) {
    super(message);
  }
}

type Listener = () => void;

export class ApiClient {
  private accessToken: string | null = null;
  private refreshing: Promise<boolean> | null = null;
  private readonly listeners = new Set<Listener>();

  constructor(
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
    private readonly storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> = sessionStorage,
  ) {}

  // ── 세션 ──────────────────────────────────────────────

  /** 로그인 상태 (새로고침 후에는 refresh 토큰으로 복구 가능) */
  get isAuthenticated(): boolean {
    return this.accessToken !== null || this.storage.getItem(REFRESH_KEY) !== null;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async login(email: string, password: string): Promise<void> {
    const tokens = await this.send(
      "POST",
      "/auth/login",
      { email, password },
      TokenResponseSchema,
      {
        auth: false,
      },
    );
    this.setTokens(tokens.accessToken, tokens.refreshToken);
  }

  logout(): void {
    this.accessToken = null;
    this.storage.removeItem(REFRESH_KEY);
    this.emit();
  }

  // ── 배포 관리 ──────────────────────────────────────────

  listDistributions(page = 1, size = 20): Promise<DistributionSummary[]> {
    return this.send(
      "GET",
      `/distributions?page=${page}&size=${size}`,
      undefined,
      z.array(DistributionSummarySchema),
    );
  }

  getDistribution(id: string): Promise<Distribution> {
    return this.send("GET", `/distributions/${id}`, undefined, DistributionSchema);
  }

  createDistribution(body: CreateDistributionRequest): Promise<Distribution> {
    return this.send("POST", "/distributions", body, DistributionSchema);
  }

  updateDistribution(id: string, body: UpdateDistributionRequest): Promise<Distribution> {
    return this.send("PATCH", `/distributions/${id}`, body, DistributionSchema);
  }

  revokeDistribution(id: string): Promise<Distribution> {
    return this.send("POST", `/distributions/${id}/revoke`, undefined, DistributionSchema);
  }

  revokeRecipient(id: string, recipientId: string): Promise<Distribution> {
    return this.send(
      "POST",
      `/distributions/${id}/recipients/${recipientId}/revoke`,
      undefined,
      DistributionSchema,
    );
  }

  revokeDocument(docId: string): Promise<Document> {
    return this.send("POST", `/documents/${docId}/revoke`, undefined, DocumentSchema);
  }

  /**
   * 문서 업로드 (진행률 표시를 위해 XMLHttpRequest 사용)
   * @param onProgress 0~1
   */
  async uploadDocument(
    distributionId: string,
    file: File,
    onProgress?: (ratio: number) => void,
  ): Promise<Document> {
    const attempt = () =>
      new Promise<{ status: number; body: unknown }>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", `${API_BASE}/distributions/${distributionId}/documents`);
        if (this.accessToken) xhr.setRequestHeader("Authorization", `Bearer ${this.accessToken}`);
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) onProgress?.(e.loaded / e.total);
        };
        xhr.onload = () => {
          let body: unknown = null;
          try {
            body = JSON.parse(xhr.responseText);
          } catch {
            // 본문이 JSON이 아니면 상태 코드로만 판단
          }
          resolve({ status: xhr.status, body });
        };
        xhr.onerror = () =>
          reject(new ApiError(0, "NETWORK_ERROR", "네트워크 오류로 업로드하지 못했습니다."));
        const form = new FormData();
        form.append("file", file, file.name);
        xhr.send(form);
      });

    if (!this.accessToken) await this.refresh();
    let res = await attempt();
    if (res.status === 401 && (await this.refresh())) res = await attempt();
    if (res.status >= 400) throw toApiError(res.status, res.body);
    return DocumentSchema.parse(res.body);
  }

  // ── 내부 ──────────────────────────────────────────────

  private async send<T>(
    method: string,
    path: string,
    body: unknown,
    schema: ZodType<T>,
    options: { auth?: boolean } = {},
  ): Promise<T> {
    const auth = options.auth ?? true;
    if (auth && !this.accessToken) await this.refresh();

    const doFetch = async () => {
      try {
        return await this.fetchImpl(`${API_BASE}${path}`, {
          method,
          headers: {
            ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
            ...(auth && this.accessToken ? { Authorization: `Bearer ${this.accessToken}` } : {}),
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
      } catch {
        throw new ApiError(0, "NETWORK_ERROR", "서버에 연결할 수 없습니다.");
      }
    };

    let res = await doFetch();
    if (res.status === 401 && auth && (await this.refresh())) res = await doFetch();

    const data: unknown = res.status === 204 ? null : await res.json().catch(() => null);
    if (!res.ok) {
      if (res.status === 401 && auth) this.logout();
      throw toApiError(res.status, data);
    }
    return schema.parse(data);
  }

  /** refresh 토큰으로 access 토큰 갱신. 동시 호출은 하나로 합칩니다. */
  private refresh(): Promise<boolean> {
    this.refreshing ??= (async () => {
      const refreshToken = this.storage.getItem(REFRESH_KEY);
      if (!refreshToken) return false;
      try {
        const res = await this.fetchImpl(`${API_BASE}/auth/refresh`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refreshToken }),
        });
        if (!res.ok) {
          this.logout();
          return false;
        }
        const tokens = TokenResponseSchema.parse(await res.json());
        this.setTokens(tokens.accessToken, tokens.refreshToken);
        return true;
      } catch {
        return false;
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  private setTokens(accessToken: string, refreshToken: string): void {
    this.accessToken = accessToken;
    this.storage.setItem(REFRESH_KEY, refreshToken);
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

const toApiError = (status: number, body: unknown): ApiError => {
  const parsed = ApiErrorSchema.safeParse(body);
  if (parsed.success) {
    const { code, message, issues } = parsed.data.error;
    return new ApiError(status, code, message, issues ?? []);
  }
  return new ApiError(status, "INTERNAL_ERROR", `요청을 처리하지 못했습니다. (HTTP ${status})`);
};
