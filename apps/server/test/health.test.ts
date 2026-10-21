import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type TestContext } from "./support/test-app.js";

describe("서버 골격", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await ctx?.close();
  });

  it("GET /api/v1/health → 200, DB 연결 확인", async () => {
    const res = await request(ctx.app.getHttpServer()).get("/api/v1/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", db: "ok" });
  });

  it("응답에 correlation ID를 붙이고, 유효한 요청 값은 그대로 사용한다", async () => {
    const server = ctx.app.getHttpServer();
    const generated = await request(server).get("/api/v1/health");
    expect(generated.headers["x-correlation-id"]).toMatch(/^[0-9a-f-]{36}$/);

    const echoed = await request(server).get("/api/v1/health").set("X-Correlation-Id", "abc-123");
    expect(echoed.headers["x-correlation-id"]).toBe("abc-123");

    const invalid = await request(server)
      .get("/api/v1/health")
      .set("X-Correlation-Id", "bad id with spaces");
    expect(invalid.headers["x-correlation-id"]).not.toBe("bad id with spaces");
  });

  it("없는 경로는 ApiError 형식의 404를 반환한다", async () => {
    const res = await request(ctx.app.getHttpServer())
      .get("/api/v1/nope")
      .set("X-Correlation-Id", "trace-1");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: { code: "NOT_FOUND", message: expect.any(String), correlationId: "trace-1" },
    });
  });

  it("감사 로그 테이블은 UPDATE·DELETE가 차단된다 (append-only)", async () => {
    await ctx.query(
      `INSERT INTO audit_events (id, type, "actorType", detail) VALUES (gen_random_uuid(), 'OTP_REQUESTED', 'SYSTEM', '{}')`,
    );
    await expect(ctx.query(`UPDATE audit_events SET ip = '1.2.3.4'`)).rejects.toThrow(
      /append-only/,
    );
    await expect(ctx.query(`DELETE FROM audit_events`)).rejects.toThrow(/append-only/);
    const { rows } = await ctx.query<{ count: string }>(`SELECT count(*) FROM audit_events`);
    expect(rows[0]?.count).toBe("1");
  });
});
