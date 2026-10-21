import { describe, expect, it } from "vitest";
import { DIST_ID, TOKENS, fakeFetch, sampleDistribution } from "../test/fake-server.js";
import { ApiClient, ApiError } from "./client.js";

describe("ApiClient", () => {
  it("로그인하면 refresh 토큰을 sessionStorage에 두고 이후 요청에 access 토큰을 붙인다", async () => {
    const fetchMock = fakeFetch({
      "POST /auth/login": () => ({ status: 200, body: TOKENS }),
      [`GET /distributions/${DIST_ID}`]: (_b, init) => {
        const auth = (init.headers as Record<string, string>).Authorization;
        return auth === "Bearer access-1"
          ? { status: 200, body: sampleDistribution() }
          : { status: 401 };
      },
    });
    const client = new ApiClient(fetchMock as never, sessionStorage);
    expect(client.isAuthenticated).toBe(false);
    await client.login("hong@company.com", "pw");
    expect(sessionStorage.getItem("drm.portal.refreshToken")).toBe("refresh-1");
    expect((await client.getDistribution(DIST_ID)).title).toBe("A사 도면 송부");
  });

  it("401이면 refresh 후 한 번 재시도한다 (새로고침 후 복구)", async () => {
    sessionStorage.setItem("drm.portal.refreshToken", "old-refresh");
    let refreshCalls = 0;
    const fetchMock = fakeFetch({
      "POST /auth/refresh": (body) => {
        refreshCalls += 1;
        return (body as { refreshToken: string }).refreshToken === "old-refresh"
          ? { status: 200, body: { ...TOKENS, accessToken: "access-2" } }
          : { status: 401 };
      },
      [`GET /distributions/${DIST_ID}`]: (_b, init) =>
        (init.headers as Record<string, string>).Authorization === "Bearer access-2"
          ? { status: 200, body: sampleDistribution() }
          : { status: 401 },
    });
    const client = new ApiClient(fetchMock as never, sessionStorage);
    expect(client.isAuthenticated).toBe(true);
    // 동시 요청이어도 refresh는 한 번
    await Promise.all([client.getDistribution(DIST_ID), client.getDistribution(DIST_ID)]);
    expect(refreshCalls).toBe(1);
    expect(sessionStorage.getItem("drm.portal.refreshToken")).toBe("refresh-1");
  });

  it("refresh도 실패하면 로그아웃 상태가 되고 401 오류를 던진다", async () => {
    sessionStorage.setItem("drm.portal.refreshToken", "expired");
    const fetchMock = fakeFetch({
      "POST /auth/refresh": () => ({ status: 401 }),
      "GET /distributions?page=1&size=20": () => ({
        status: 401,
        body: { error: { code: "UNAUTHENTICATED", message: "인증 필요", correlationId: null } },
      }),
    });
    const client = new ApiClient(fetchMock as never, sessionStorage);
    const error = await client.listDistributions().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(401);
    expect(client.isAuthenticated).toBe(false);
  });

  it("서버 오류 응답을 코드·메시지·항목으로 변환한다", async () => {
    const fetchMock = fakeFetch({
      "POST /auth/login": () => ({
        status: 400,
        body: {
          error: {
            code: "VALIDATION_FAILED",
            message: "입력값이 올바르지 않습니다.",
            correlationId: "c1",
            issues: [{ path: "email", message: "이메일 형식" }],
          },
        },
      }),
    });
    const client = new ApiClient(fetchMock as never, sessionStorage);
    const error = (await client.login("x", "y").catch((e: unknown) => e)) as ApiError;
    expect(error.code).toBe("VALIDATION_FAILED");
    expect(error.issues).toEqual([{ path: "email", message: "이메일 형식" }]);
  });

  it("네트워크 오류는 NETWORK_ERROR", async () => {
    const client = new ApiClient(
      (async () => {
        throw new TypeError("failed to fetch");
      }) as never,
      sessionStorage,
    );
    const error = (await client.login("a@b.c", "p").catch((e: unknown) => e)) as ApiError;
    expect(error.code).toBe("NETWORK_ERROR");
  });
});
