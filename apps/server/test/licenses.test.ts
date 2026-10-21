import {
  LicensePayloadSchema,
  SignedLicenseSchema,
  type DenyReason,
  type LicensePayload,
} from "@drm/contracts";
import {
  SIGNING_CONTEXT,
  generateX25519KeyPair,
  unwrapCekOnDevice,
  verifyWithContext,
  type RawKeyPair,
} from "@drm/crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LICENSE_RATE_LIMIT_PER_MINUTE, watermarkText } from "../src/licenses/licenses.service.js";
import { PrismaService } from "../src/prisma/prisma.service.js";
import {
  createDistribution,
  createPackagedDocument,
  createSender,
  recipientAuthHeader,
  uniqueEmail,
  type DistributionFixtureOptions,
} from "./support/fixtures.js";
import { createTestApp, type TestContext } from "./support/test-app.js";

describe("라이선스 발급 (T1-12)", () => {
  let ctx: TestContext;
  let sender: { id: string; name: string; email: string };
  const http = () => request(ctx.app.getHttpServer());

  interface Viewer {
    recipientId: string;
    email: string;
    auth: string;
    device: RawKeyPair;
    deviceId: string;
  }

  /** 수신자 + 기기 등록 + 패키징된 문서 준비 */
  const setup = async (options: Partial<DistributionFixtureOptions> = {}) => {
    const email = uniqueEmail();
    const dist = await createDistribution(ctx, {
      senderId: sender.id,
      recipients: [email],
      ...options,
    });
    const { document, cek } = await createPackagedDocument(ctx, dist.id);
    const viewer = await viewerFor(dist.recipients[0]!.recipientId, email);
    return { dist, document, cek, viewer };
  };

  const viewerFor = async (recipientId: string, email: string): Promise<Viewer> => {
    const auth = await recipientAuthHeader(ctx, recipientId);
    const device = generateX25519KeyPair();
    const res = await http()
      .post("/api/v1/devices")
      .set("Authorization", auth)
      .send({ publicKey: device.publicKey.toString("base64url"), name: "PC", platform: "WINDOWS" });
    expect(res.status).toBe(201);
    return { recipientId, email, auth, device, deviceId: res.body.deviceId };
  };

  const requestLicense = (viewer: Viewer, docId: string, deviceId = viewer.deviceId) =>
    http().post("/api/v1/licenses").set("Authorization", viewer.auth).send({ docId, deviceId });

  /** 뷰어 검증 절차 (스펙 §7 1~3) */
  const verifyLicense = async (body: unknown): Promise<LicensePayload> => {
    const signed = SignedLicenseSchema.parse(body);
    const keys = await http().get("/api/v1/keys/signing");
    const key = keys.body.keys.find((k: { kid: string }) => k.kid === signed.kid);
    expect(key, "kid에 해당하는 공개키").toBeDefined();
    const payloadBytes = Buffer.from(signed.payload, "base64url");
    expect(
      verifyWithContext(
        Buffer.from(key.publicKey, "base64url"),
        SIGNING_CONTEXT.license,
        payloadBytes,
        Buffer.from(signed.signature, "base64url"),
      ),
    ).toBe(true);
    return LicensePayloadSchema.parse(JSON.parse(payloadBytes.toString("utf8")));
  };

  const expectDenied = async (
    res: request.Response,
    reason: DenyReason,
    contact: boolean = true,
  ) => {
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe(reason);
    expect(res.body.error.message).toMatch(/\S/);
    if (contact) {
      expect(res.body.error.contact).toEqual({ name: sender.name, email: sender.email });
    } else {
      expect(res.body.error.contact).toBeUndefined();
    }
  };

  beforeAll(async () => {
    ctx = await createTestApp();
    sender = await createSender(ctx, { name: "김발신" });
  });

  afterAll(async () => {
    await ctx?.close();
  });

  it("서명된 라이선스를 발급하고, 기기 개인키로 원래 CEK를 복원할 수 있다", async () => {
    const { document, cek, viewer } = await setup();
    const res = await requestLicense(viewer, document.id);
    expect(res.status).toBe(200);

    const payload = await verifyLicense(res.body);
    expect(payload).toMatchObject({
      docId: document.id,
      recipientId: viewer.recipientId,
      deviceId: viewer.deviceId,
      contentType: "application/pdf",
      permissions: { view: true },
    });
    const ttl = Date.parse(payload.expiresAt) - Date.parse(payload.issuedAt);
    expect(ttl).toBe(600_000);
    expect(payload.watermark.text).toBe(
      watermarkText(viewer.email, new Date(payload.issuedAt), document.id),
    );
    expect(payload.watermark.text).toContain(viewer.email);

    const restored = unwrapCekOnDevice(
      viewer.device.privateKey,
      {
        ephemeralPublicKey: Buffer.from(payload.key.ephemeralPublicKey, "base64url"),
        wrappedKey: Buffer.from(payload.key.wrappedKey, "base64url"),
      },
      { licenseId: payload.licenseId, docId: payload.docId },
    );
    expect(restored.equals(cek)).toBe(true);

    // 응답 어디에도 CEK 평문이 없어야 합니다.
    const raw = JSON.stringify(res.body) + Buffer.from(res.body.payload, "base64url").toString();
    for (const encoding of ["base64url", "base64", "hex"] as const) {
      expect(raw).not.toContain(cek.toString(encoding));
    }

    const { rows } = await ctx.query(
      `SELECT 1 FROM audit_events WHERE type = 'LICENSE_ISSUED' AND "documentId" = $1 AND "deviceId" = $2`,
      [document.id, viewer.deviceId],
    );
    expect(rows).toHaveLength(1);
  });

  describe("거부 사유", () => {
    it("수신자 목록에 없으면 NOT_RECIPIENT (발신자 연락처 미노출)", async () => {
      const { document } = await setup();
      const stranger = await setup();
      await expectDenied(
        await requestLicense(stranger.viewer, document.id),
        "NOT_RECIPIENT",
        false,
      );
    });

    it("만료·시작 전", async () => {
      const expired = await setup({
        validFrom: new Date(Date.now() - 2 * 86400_000),
        validUntil: new Date(Date.now() + 1000),
      });
      await ctx.app.get(PrismaService).distribution.update({
        where: { id: expired.dist.id },
        data: { validUntil: new Date(Date.now() - 1000) },
      });
      await expectDenied(await requestLicense(expired.viewer, expired.document.id), "EXPIRED");

      const scheduled = await setup();
      await ctx.app.get(PrismaService).distribution.update({
        where: { id: scheduled.dist.id },
        data: {
          validFrom: new Date(Date.now() + 86400_000),
          validUntil: new Date(Date.now() + 2 * 86400_000),
        },
      });
      await expectDenied(
        await requestLicense(scheduled.viewer, scheduled.document.id),
        "NOT_YET_VALID",
      );
    });

    it("배포 건·수신자·문서 회수", async () => {
      const prisma = ctx.app.get(PrismaService);
      const a = await setup();
      await prisma.distribution.update({
        where: { id: a.dist.id },
        data: { revokedAt: new Date() },
      });
      await expectDenied(await requestLicense(a.viewer, a.document.id), "DISTRIBUTION_REVOKED");

      const b = await setup();
      await prisma.distributionRecipient.updateMany({
        where: { distributionId: b.dist.id },
        data: { revokedAt: new Date() },
      });
      await expectDenied(await requestLicense(b.viewer, b.document.id), "RECIPIENT_REVOKED");

      const c = await setup();
      await prisma.document.update({
        where: { id: c.document.id },
        data: { revokedAt: new Date() },
      });
      await expectDenied(await requestLicense(c.viewer, c.document.id), "DOCUMENT_REVOKED");
    });

    it("패키징되지 않은 문서는 DOCUMENT_NOT_READY", async () => {
      const { dist, viewer } = await setup();
      const { document } = await createPackagedDocument(ctx, dist.id, { status: "CONVERTING" });
      await expectDenied(await requestLicense(viewer, document.id), "DOCUMENT_NOT_READY");
    });

    it("다른 수신자의 기기·등록 해제된 기기", async () => {
      const a = await setup();
      const b = await setup();
      await expectDenied(
        await requestLicense(a.viewer, a.document.id, b.viewer.deviceId),
        "DEVICE_NOT_REGISTERED",
      );
      await ctx.app.get(PrismaService).device.update({
        where: { id: a.viewer.deviceId },
        data: { revokedAt: new Date() },
      });
      await expectDenied(await requestLicense(a.viewer, a.document.id), "DEVICE_REVOKED");
    });

    it("최대 열람 횟수를 넘으면 VIEW_LIMIT_EXCEEDED (동시 요청 포함)", async () => {
      const { document, viewer } = await setup({ maxViews: 3 });
      const results = await Promise.all(
        Array.from({ length: 6 }, () => requestLicense(viewer, document.id)),
      );
      expect(results.filter((r) => r.status === 200)).toHaveLength(3);
      expect(results.filter((r) => r.body.error?.code === "VIEW_LIMIT_EXCEEDED")).toHaveLength(3);
    });

    it("거부도 감사 로그에 사유와 함께 남는다", async () => {
      const { dist, document, viewer } = await setup();
      await ctx.app.get(PrismaService).distribution.update({
        where: { id: dist.id },
        data: { revokedAt: new Date() },
      });
      await requestLicense(viewer, document.id);
      const { rows } = await ctx.query<{ detail: { reason: string } }>(
        `SELECT detail FROM audit_events WHERE type = 'LICENSE_DENIED' AND "documentId" = $1`,
        [document.id],
      );
      expect(rows[0]?.detail).toEqual({ reason: "DISTRIBUTION_REVOKED" });
    });
  });

  it("없는 문서는 404, 잘못된 요청은 400, 발신자 토큰은 401", async () => {
    const { viewer } = await setup();
    expect((await requestLicense(viewer, crypto.randomUUID())).status).toBe(404);
    const bad = await http()
      .post("/api/v1/licenses")
      .set("Authorization", viewer.auth)
      .send({ docId: "x" });
    expect(bad.status).toBe(400);
    expect((await http().post("/api/v1/licenses").send({})).status).toBe(401);
  });

  it(`수신자당 분당 ${LICENSE_RATE_LIMIT_PER_MINUTE}회를 넘으면 429`, async () => {
    const { document, viewer } = await setup();
    for (let i = 0; i < LICENSE_RATE_LIMIT_PER_MINUTE; i += 1) {
      expect((await requestLicense(viewer, document.id)).status).toBe(200);
    }
    const res = await requestLicense(viewer, document.id);
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe("RATE_LIMITED");
  });
});
