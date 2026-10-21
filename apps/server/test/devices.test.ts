import { generateX25519KeyPair } from "@drm/crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaService } from "../src/prisma/prisma.service.js";
import {
  createDistribution,
  createSender,
  recipientAuthHeader,
  senderAuthHeader,
  uniqueEmail,
} from "./support/fixtures.js";
import { createTestApp, type TestContext } from "./support/test-app.js";

describe("기기 등록 (T1-11)", () => {
  let ctx: TestContext;
  let senderId: string;
  let senderEmail: string;
  const http = () => request(ctx.app.getHttpServer());
  const newKey = () => generateX25519KeyPair().publicKey.toString("base64url");

  /** 수신자를 만들고 Authorization 헤더 반환 */
  const recipientWith = async (maxDevices = 2) => {
    const email = uniqueEmail();
    const dist = await createDistribution(ctx, { senderId, recipients: [email], maxDevices });
    const recipientId = dist.recipients[0]!.recipientId;
    return { recipientId, email, auth: await recipientAuthHeader(ctx, recipientId) };
  };

  const register = (auth: string, publicKey = newKey(), name = "설계팀 PC") =>
    http()
      .post("/api/v1/devices")
      .set("Authorization", auth)
      .send({ publicKey, name, platform: "WINDOWS" });

  beforeAll(async () => {
    ctx = await createTestApp();
    const sender = await createSender(ctx);
    senderId = sender.id;
    senderEmail = sender.email;
  });

  afterAll(async () => {
    await ctx?.close();
  });

  it("기기를 등록하고 감사 로그를 남긴다", async () => {
    const { auth, recipientId } = await recipientWith();
    const res = await register(auth);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ deviceId: expect.any(String) });

    const { rows } = await ctx.query(
      `SELECT 1 FROM audit_events WHERE type = 'DEVICE_REGISTERED' AND "deviceId" = $1 AND "recipientId" = $2`,
      [res.body.deviceId, recipientId],
    );
    expect(rows).toHaveLength(1);
  });

  it("같은 공개키 재등록은 기존 deviceId를 200으로 반환한다 (멱등)", async () => {
    const { auth } = await recipientWith();
    const key = newKey();
    const first = await register(auth, key);
    const second = await register(auth, key);
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.deviceId).toBe(first.body.deviceId);
  });

  it("다른 수신자가 같은 공개키를 등록하면 409 CONFLICT", async () => {
    const a = await recipientWith();
    const b = await recipientWith();
    const key = newKey();
    await register(a.auth, key);
    const res = await register(b.auth, key);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("CONFLICT");
  });

  it("서로 다른 수신자가 같은 공개키를 동시에 등록해도 500이 아닌 409를 받는다", async () => {
    const a = await recipientWith();
    const b = await recipientWith();
    const key = newKey();
    const results = await Promise.all([register(a.auth, key), register(b.auth, key)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
  });

  it("기기 수 한도를 넘으면 409 DEVICE_LIMIT_EXCEEDED", async () => {
    const { auth } = await recipientWith(2);
    expect((await register(auth)).status).toBe(201);
    expect((await register(auth)).status).toBe(201);
    const res = await register(auth);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("DEVICE_LIMIT_EXCEEDED");
  });

  it("여러 배포 건 중 가장 작은 maxDevices를 적용한다", async () => {
    const { auth, email } = await recipientWith(3);
    await createDistribution(ctx, { senderId, recipients: [email], maxDevices: 1 });
    expect((await register(auth)).status).toBe(201);
    expect((await register(auth)).body.error.code).toBe("DEVICE_LIMIT_EXCEEDED");
  });

  it("등록 해제된 기기는 한도에서 빠지지만, 같은 키로 재등록할 수는 없다", async () => {
    const { auth, recipientId } = await recipientWith(1);
    const key = newKey();
    await register(auth, key);
    await ctx.app.get(PrismaService).device.updateMany({
      where: { recipientId },
      data: { revokedAt: new Date() },
    });
    expect((await register(auth, key)).body.error.code).toBe("CONFLICT");
    expect((await register(auth)).status).toBe(201);
  });

  it("동시에 등록해도 한도를 넘지 않는다", async () => {
    const { auth, recipientId } = await recipientWith(2);
    const results = await Promise.all(Array.from({ length: 6 }, () => register(auth)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(2);
    expect(results.filter((r) => r.body.error?.code === "DEVICE_LIMIT_EXCEEDED")).toHaveLength(4);
    const { rows } = await ctx.query<{ count: string }>(
      `SELECT count(*) FROM devices WHERE "recipientId" = $1`,
      [recipientId],
    );
    expect(rows[0]?.count).toBe("2");
  });

  it("유효하지 않은 공개키는 400 VALIDATION_FAILED", async () => {
    const { auth } = await recipientWith();
    const zero = Buffer.alloc(32).toString("base64url");
    const short = Buffer.alloc(31, 1).toString("base64url");
    for (const key of [zero, short]) {
      const res = await register(auth, key);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_FAILED");
    }
  });

  it("발신자 토큰·토큰 없음은 401", async () => {
    const senderAuth = await senderAuthHeader(ctx, senderEmail);
    expect((await register(senderAuth)).status).toBe(401);
    expect(
      (
        await http()
          .post("/api/v1/devices")
          .send({ publicKey: newKey(), name: "x", platform: "WINDOWS" })
      ).status,
    ).toBe(401);
  });
});
