import { Controller, Get, Module, UseGuards } from "@nestjs/common";
import { SignJWT } from "jose";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CurrentSubject, RecipientGuard, SenderGuard } from "../src/auth/auth.guard.js";
import { MAX_LOGIN_FAILURES } from "../src/auth/sender-auth.service.js";
import type { AuthSubject } from "../src/auth/token.service.js";
import { PrismaService } from "../src/prisma/prisma.service.js";
import {
  TEST_PASSWORD,
  createSender,
  recipientAuthHeader,
  senderAuthHeader,
} from "./support/fixtures.js";
import { createTestApp, type TestContext } from "./support/test-app.js";

@Controller("probe")
class ProbeController {
  @Get("sender")
  @UseGuards(SenderGuard)
  sender(@CurrentSubject() subject: AuthSubject) {
    return subject;
  }

  @Get("recipient")
  @UseGuards(RecipientGuard)
  recipient(@CurrentSubject() subject: AuthSubject) {
    return subject;
  }
}

@Module({ controllers: [ProbeController] })
class ProbeModule {}

describe("발신자 인증 (T1-06)", () => {
  let ctx: TestContext;
  const http = () => request(ctx.app.getHttpServer());

  beforeAll(async () => {
    ctx = await createTestApp({ imports: [ProbeModule] });
  });

  afterAll(async () => {
    await ctx?.close();
  });

  it("로그인 성공 시 토큰을 발급하고 보호된 API에 접근할 수 있다", async () => {
    const user = await createSender(ctx);
    const res = await http().post("/api/v1/auth/login").send({
      email: user.email.toUpperCase(),
      password: TEST_PASSWORD,
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      accessToken: expect.any(String),
      refreshToken: expect.any(String),
      expiresIn: 900,
    });

    const probe = await http()
      .get("/api/v1/probe/sender")
      .set("Authorization", `Bearer ${res.body.accessToken}`);
    expect(probe.status).toBe(200);
    expect(probe.body).toEqual({ type: "SENDER", id: user.id });

    const { rows } = await ctx.query(
      `SELECT 1 FROM audit_events WHERE type = 'SENDER_LOGIN_SUCCEEDED' AND "actorId" = $1`,
      [user.id],
    );
    expect(rows).toHaveLength(1);
  });

  it("비밀번호 오류와 없는 계정은 같은 401 응답을 받는다", async () => {
    const user = await createSender(ctx);
    const wrong = await http()
      .post("/api/v1/auth/login")
      .send({ email: user.email, password: "wrong-password" });
    const missing = await http()
      .post("/api/v1/auth/login")
      .send({ email: "nobody@company.com", password: "wrong-password" });
    expect(wrong.status).toBe(401);
    expect(missing.status).toBe(401);
    expect(wrong.body.error.message).toBe(missing.body.error.message);

    const { rows } = await ctx.query<{ detail: Record<string, unknown> }>(
      `SELECT detail FROM audit_events WHERE type = 'SENDER_LOGIN_FAILED' AND detail->>'email' = $1`,
      [user.email],
    );
    expect(rows[0]?.detail).toEqual({ email: user.email, reason: "INVALID_CREDENTIALS" });
  });

  it("비활성화된 계정은 로그인할 수 없고 기존 토큰도 거부된다", async () => {
    const user = await createSender(ctx);
    const auth = await senderAuthHeader(ctx, user.email);
    await ctx.app.get(PrismaService).user.update({
      where: { id: user.id },
      data: { disabledAt: new Date() },
    });
    expect((await http().get("/api/v1/probe/sender").set("Authorization", auth)).status).toBe(401);
    const login = await http()
      .post("/api/v1/auth/login")
      .send({ email: user.email, password: TEST_PASSWORD });
    expect(login.status).toBe(401);
  });

  it(`로그인 실패 ${MAX_LOGIN_FAILURES}회 후에는 올바른 비밀번호도 429로 거부한다`, async () => {
    const user = await createSender(ctx);
    for (let i = 0; i < MAX_LOGIN_FAILURES; i += 1) {
      await http().post("/api/v1/auth/login").send({ email: user.email, password: "wrong" });
    }
    const res = await http()
      .post("/api/v1/auth/login")
      .send({ email: user.email, password: TEST_PASSWORD });
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe("RATE_LIMITED");
  });

  it("입력값 검증 실패는 400 VALIDATION_FAILED", async () => {
    const res = await http().post("/api/v1/auth/login").send({ email: "not-email" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_FAILED");
    expect(res.body.error.issues.length).toBeGreaterThan(0);
  });

  describe("refresh 토큰", () => {
    it("회전하면 새 토큰을 받고, 사용한 토큰을 재사용하면 계열 전체가 폐기된다", async () => {
      const user = await createSender(ctx);
      const login = await http()
        .post("/api/v1/auth/login")
        .send({ email: user.email, password: TEST_PASSWORD });
      const first = login.body.refreshToken as string;

      const rotated = await http().post("/api/v1/auth/refresh").send({ refreshToken: first });
      expect(rotated.status).toBe(200);
      const second = rotated.body.refreshToken as string;
      expect(second).not.toBe(first);

      // 이미 사용한 토큰 재사용 → 401, 그리고 새로 받은 토큰도 폐기됨
      const reuse = await http().post("/api/v1/auth/refresh").send({ refreshToken: first });
      expect(reuse.status).toBe(401);
      const afterReuse = await http().post("/api/v1/auth/refresh").send({ refreshToken: second });
      expect(afterReuse.status).toBe(401);
    });

    it("수신자 refresh 토큰으로는 발신자 토큰을 갱신할 수 없다", async () => {
      const recipient = await ctx.app.get(PrismaService).recipient.create({
        data: { email: "r1@customer.co.kr" },
      });
      const { TokenService } = await import("../src/auth/token.service.js");
      const tokens = await ctx.app.get(TokenService).issue({ type: "RECIPIENT", id: recipient.id });
      const res = await http()
        .post("/api/v1/auth/refresh")
        .send({ refreshToken: tokens.refreshToken });
      expect(res.status).toBe(401);
    });
  });

  describe("access 토큰 검증", () => {
    it("토큰이 없거나 형식이 틀리면 401", async () => {
      expect((await http().get("/api/v1/probe/sender")).status).toBe(401);
      expect(
        (await http().get("/api/v1/probe/sender").set("Authorization", "Basic abc")).status,
      ).toBe(401);
      expect(
        (await http().get("/api/v1/probe/sender").set("Authorization", "Bearer abc.def.ghi"))
          .status,
      ).toBe(401);
    });

    it("만료된 토큰과 다른 비밀키로 서명한 토큰은 401", async () => {
      const user = await createSender(ctx);
      const secret = new TextEncoder().encode(ctx.env.JWT_SECRET);
      const build = (key: Uint8Array, exp: number) =>
        new SignJWT({ typ: "sender" })
          .setProtectedHeader({ alg: "HS256" })
          .setSubject(user.id)
          .setIssuer("drm-1021")
          .setAudience("drm-1021-api")
          .setIssuedAt()
          .setExpirationTime(exp)
          .sign(key);
      const expired = await build(secret, Math.floor(Date.now() / 1000) - 10);
      const forged = await build(
        new TextEncoder().encode("another-secret-another-secret-123456"),
        Math.floor(Date.now() / 1000) + 600,
      );
      for (const token of [expired, forged]) {
        const res = await http()
          .get("/api/v1/probe/sender")
          .set("Authorization", `Bearer ${token}`);
        expect(res.status).toBe(401);
      }
    });

    it("수신자 토큰으로 발신자 API를, 발신자 토큰으로 수신자 API를 호출할 수 없다", async () => {
      const user = await createSender(ctx);
      const senderAuth = await senderAuthHeader(ctx, user.email);
      const recipient = await ctx.app.get(PrismaService).recipient.create({
        data: { email: "r2@customer.co.kr" },
      });
      const recipientAuth = await recipientAuthHeader(ctx, recipient.id);

      expect(
        (await http().get("/api/v1/probe/sender").set("Authorization", recipientAuth)).status,
      ).toBe(401);
      expect(
        (await http().get("/api/v1/probe/recipient").set("Authorization", senderAuth)).status,
      ).toBe(401);
      const ok = await http().get("/api/v1/probe/recipient").set("Authorization", recipientAuth);
      expect(ok.body).toEqual({ type: "RECIPIENT", id: recipient.id });
    });
  });
});
