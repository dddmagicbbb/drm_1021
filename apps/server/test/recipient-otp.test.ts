import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  OTP_LIMIT_PER_EMAIL_PER_HOUR,
  OTP_LIMIT_PER_IP_PER_HOUR,
  OTP_MAX_ATTEMPTS,
} from "../src/auth/otp.service.js";
import { MAILER } from "../src/mail/mailer.js";
import { PrismaService } from "../src/prisma/prisma.service.js";
import { createDistribution, createSender, uniqueEmail } from "./support/fixtures.js";
import { InMemoryMailer } from "./support/mailer.js";
import { createTestApp, type TestContext } from "./support/test-app.js";

describe("수신자 OTP 인증 (T1-07)", () => {
  let ctx: TestContext;
  let mailer: InMemoryMailer;
  let senderId: string;
  const http = () => request(ctx.app.getHttpServer());

  /** 테스트끼리 IP 한도를 공유하지 않도록 요청마다 다른 클라이언트 IP를 사용합니다. (trust proxy 1단계) */
  let ipSeq = 0;
  const requestOtp = (email: string, ip = `198.51.100.${(ipSeq += 1) % 250}`) =>
    http().post("/api/v1/recipient-auth/otp/request").set("X-Forwarded-For", ip).send({ email });
  const verifyOtp = (email: string, code: string) =>
    http().post("/api/v1/recipient-auth/otp/verify").send({ email, code });

  /** 유효한 배포 건의 수신자 생성 */
  const eligibleRecipient = async () => {
    const email = uniqueEmail();
    await createDistribution(ctx, { senderId, recipients: [email] });
    return email;
  };

  beforeAll(async () => {
    mailer = new InMemoryMailer();
    ctx = await createTestApp({ providers: [[MAILER, mailer]] });
    senderId = (await createSender(ctx)).id;
  });

  beforeEach(() => {
    mailer.sent.length = 0;
  });

  afterAll(async () => {
    await ctx?.close();
  });

  it("유효한 수신자는 OTP 메일을 받고, 검증하면 수신자 토큰을 받는다", async () => {
    const email = await eligibleRecipient();
    expect((await requestOtp(email.toUpperCase())).status).toBe(202);
    const code = mailer.otpFor(email);

    const res = await verifyOtp(email, code);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      accessToken: expect.any(String),
      refreshToken: expect.any(String),
      expiresIn: 900,
    });

    // 1회용: 같은 코드 재사용 불가
    expect((await verifyOtp(email, code)).body.error.code).toBe("OTP_INVALID");

    // 수신자 refresh 토큰 회전
    const refreshed = await http()
      .post("/api/v1/recipient-auth/refresh")
      .send({ refreshToken: res.body.refreshToken });
    expect(refreshed.status).toBe(200);
  });

  it("OTP는 HMAC 해시로만 저장된다", async () => {
    const email = await eligibleRecipient();
    await requestOtp(email);
    const code = mailer.otpFor(email);
    const { rows } = await ctx.query<{ codeHash: Buffer }>(
      `SELECT "codeHash" FROM otp_challenges WHERE email = $1`,
      [email],
    );
    expect(rows[0]?.codeHash).toHaveLength(32);
    expect(rows[0]?.codeHash.toString("utf8")).not.toContain(code);
  });

  describe("계정 존재 여부 비노출", () => {
    it("등록되지 않은 이메일도 202를 받지만 메일은 발송되지 않는다", async () => {
      const email = uniqueEmail("stranger");
      const res = await requestOtp(email);
      expect(res.status).toBe(202);
      expect(res.body).toEqual({});
      expect(mailer.sent).toHaveLength(0);

      const { rows } = await ctx.query<{ detail: Record<string, unknown> }>(
        `SELECT detail FROM audit_events WHERE type = 'OTP_REQUESTED' AND detail->>'email' = $1`,
        [email],
      );
      expect(rows[0]?.detail).toEqual({ email, sent: false, reason: "NOT_ELIGIBLE" });
    });

    it("회수된 배포 건·회수된 수신자·만료된 배포 건만 있으면 발송하지 않는다", async () => {
      const revokedDist = uniqueEmail();
      await createDistribution(ctx, { senderId, recipients: [revokedDist], revoked: true });

      const expired = uniqueEmail();
      await createDistribution(ctx, {
        senderId,
        recipients: [expired],
        validFrom: new Date(Date.now() - 2 * 86400_000),
        validUntil: new Date(Date.now() - 86400_000),
      });

      const revokedRecipient = uniqueEmail();
      const dist = await createDistribution(ctx, { senderId, recipients: [revokedRecipient] });
      await ctx.app.get(PrismaService).distributionRecipient.updateMany({
        where: { distributionId: dist.id },
        data: { revokedAt: new Date() },
      });

      for (const email of [revokedDist, expired, revokedRecipient]) {
        expect((await requestOtp(email)).status).toBe(202);
      }
      expect(mailer.sent).toHaveLength(0);
    });
  });

  describe("검증 실패", () => {
    it(`틀린 코드 ${OTP_MAX_ATTEMPTS}회째에 OTP가 폐기되어 올바른 코드도 거부된다`, async () => {
      const email = await eligibleRecipient();
      await requestOtp(email);
      const code = mailer.otpFor(email);
      const wrong = code === "000000" ? "111111" : "000000";

      for (let i = 1; i < OTP_MAX_ATTEMPTS; i += 1) {
        const res = await verifyOtp(email, wrong);
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe("OTP_INVALID");
      }
      const last = await verifyOtp(email, wrong);
      expect(last.status).toBe(429);
      expect(last.body.error.code).toBe("OTP_ATTEMPTS_EXCEEDED");
      expect((await verifyOtp(email, code)).body.error.code).toBe("OTP_INVALID");
    });

    it("병렬 요청으로도 시도 횟수 제한을 넘을 수 없다", async () => {
      const email = await eligibleRecipient();
      await requestOtp(email);
      const code = mailer.otpFor(email);
      const wrong = code === "000000" ? "111111" : "000000";

      await Promise.all(Array.from({ length: 15 }, () => verifyOtp(email, wrong)));
      const { rows } = await ctx.query<{ attempts: number }>(
        `SELECT attempts FROM otp_challenges WHERE email = $1`,
        [email],
      );
      expect(rows[0]?.attempts).toBeLessThanOrEqual(OTP_MAX_ATTEMPTS);
      expect((await verifyOtp(email, code)).status).not.toBe(200);
    });

    it("만료된 OTP는 OTP_EXPIRED", async () => {
      const email = await eligibleRecipient();
      await requestOtp(email);
      const code = mailer.otpFor(email);
      await ctx.query(
        `UPDATE otp_challenges SET "expiresAt" = now() - interval '1 second' WHERE email = $1`,
        [email],
      );
      const res = await verifyOtp(email, code);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("OTP_EXPIRED");
    });

    it("새 OTP를 요청하면 이전 OTP는 무효가 된다", async () => {
      const email = await eligibleRecipient();
      await requestOtp(email);
      const first = mailer.otpFor(email);
      await requestOtp(email);
      const second = mailer.otpFor(email);
      if (first !== second) {
        expect((await verifyOtp(email, first)).body.error.code).toBe("OTP_INVALID");
      }
      expect((await verifyOtp(email, second)).status).toBe(200);
    });

    it("OTP 형식이 틀리면 400 VALIDATION_FAILED", async () => {
      const res = await verifyOtp("a@x.com", "12ab");
      expect(res.body.error.code).toBe("VALIDATION_FAILED");
    });
  });

  describe("발급 한도·장애", () => {
    it(`이메일당 시간당 ${OTP_LIMIT_PER_EMAIL_PER_HOUR}회를 넘으면 202지만 발송하지 않는다`, async () => {
      const email = await eligibleRecipient();
      for (let i = 0; i < OTP_LIMIT_PER_EMAIL_PER_HOUR; i += 1) await requestOtp(email);
      expect(mailer.sent).toHaveLength(OTP_LIMIT_PER_EMAIL_PER_HOUR);
      const res = await requestOtp(email);
      expect(res.status).toBe(202);
      expect(mailer.sent).toHaveLength(OTP_LIMIT_PER_EMAIL_PER_HOUR);
    });

    it(`IP당 시간당 ${OTP_LIMIT_PER_IP_PER_HOUR}회를 넘으면 발송하지 않는다`, async () => {
      const ip = "203.0.113.99";
      for (let i = 0; i < OTP_LIMIT_PER_IP_PER_HOUR; i += 1) {
        await requestOtp(await eligibleRecipient(), ip);
      }
      expect(mailer.sent).toHaveLength(OTP_LIMIT_PER_IP_PER_HOUR);
      const email = await eligibleRecipient();
      expect((await requestOtp(email, ip)).status).toBe(202);
      expect(mailer.lastTo(email)).toBeUndefined();
      // 다른 IP에서는 정상 발송
      await requestOtp(email, "203.0.113.100");
      expect(mailer.lastTo(email)).toBeDefined();
    });

    it("메일 발송이 실패해도 202를 반환하고 감사 로그에 기록한다", async () => {
      const email = await eligibleRecipient();
      mailer.failNext = true;
      expect((await requestOtp(email)).status).toBe(202);
      const { rows } = await ctx.query<{ detail: Record<string, unknown> }>(
        `SELECT detail FROM audit_events WHERE type = 'OTP_REQUESTED' AND detail->>'email' = $1`,
        [email],
      );
      expect(rows[0]?.detail).toMatchObject({ sent: false, reason: "MAIL_FAILED" });
    });
  });
});
