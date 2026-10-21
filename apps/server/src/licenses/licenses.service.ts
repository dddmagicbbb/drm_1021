/**
 * 라이선스 발급
 * 스펙: docs/specs/license-api.md §3.4, §4, §5, §6
 */
import { Inject, Injectable } from "@nestjs/common";
import {
  KEY_WRAP_ALG,
  LICENSE_TTL_SECONDS,
  LicensePayloadSchema,
  PackagedContentTypeSchema,
  type LicensePayload,
  type LicenseRequest,
  type SignedLicense,
} from "@drm/contracts";
import { SIGNING_CONTEXT, wipe, wrapCekForDevice, type WrappedCek } from "@drm/crypto";
import type { KmsProvider, SigningKeyProvider } from "@drm/kms";
import { randomUUID } from "node:crypto";
import { AuditService } from "../audit/audit.service.js";
import { ApiException } from "../common/api-exception.js";
import { KMS, SIGNING_KEYS } from "../keys/keys.module.js";
import { DENY_MESSAGES, evaluateAccess } from "../policy/policy-engine.js";
import { PrismaService } from "../prisma/prisma.service.js";

/** 수신자당 분당 라이선스 요청 한도 */
export const LICENSE_RATE_LIMIT_PER_MINUTE = 60;

const KST_FORMAT = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Seoul",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** 워터마크 문구: <수신자 이메일> · <발급 시각 KST> · <docId 앞 8자> */
export const watermarkText = (email: string, issuedAt: Date, docId: string): string =>
  `${email} · ${KST_FORMAT.format(issuedAt)} · ${docId.slice(0, 8)}`;

@Injectable()
export class LicensesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(KMS) private readonly kms: KmsProvider,
    @Inject(SIGNING_KEYS) private readonly signing: SigningKeyProvider,
  ) {}

  async issue(recipientId: string, { docId, deviceId }: LicenseRequest): Promise<SignedLicense> {
    await this.assertRateLimit(recipientId);

    const document = await this.prisma.document.findUnique({
      where: { id: docId },
      include: { distribution: { include: { createdBy: true } } },
    });
    if (!document) throw ApiException.notFound("문서를 찾을 수 없습니다.");
    const { distribution } = document;
    const auditBase = {
      actorType: "RECIPIENT" as const,
      actorId: recipientId,
      recipientId,
      distributionId: distribution.id,
      documentId: docId,
      deviceId,
    };

    const result = await this.prisma.$transaction(async (tx) => {
      // 같은 수신자·문서의 동시 발급을 직렬화하여 열람 횟수 한도를 정확히 지킵니다.
      const lockKey = `license:${docId}:${recipientId}`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;

      const [membership, device, issuedCount, recipient] = await Promise.all([
        tx.distributionRecipient.findUnique({
          where: { distributionId_recipientId: { distributionId: distribution.id, recipientId } },
        }),
        // 다른 수신자의 기기는 미등록과 동일하게 취급
        tx.device.findFirst({ where: { id: deviceId, recipientId } }),
        tx.license.count({ where: { documentId: docId, recipientId } }),
        tx.recipient.findUniqueOrThrow({ where: { id: recipientId } }),
      ]);

      const now = new Date();
      const decision = evaluateAccess(
        { membership, distribution, document },
        { kind: "license", device, issuedCount },
        now,
      );
      if (!decision.allowed || !device) return { allowed: false as const, decision };

      // 정책 엔진이 PACKAGED를 확인했으므로 패키징 결과가 반드시 있어야 합니다.
      if (!document.wrappedCek || !document.kmsKeyId || !document.contentType) {
        throw new Error(`패키징 정보가 없는 PACKAGED 문서입니다: ${docId}`);
      }

      // 키 처리 실패 시 라이선스 행도 롤백되어 열람 횟수가 차감되지 않습니다.
      const licenseId = randomUUID();
      const cek = await this.kms.unwrapKey(
        { keyId: document.kmsKeyId, ciphertext: Buffer.from(document.wrappedCek) },
        { docId },
      );
      let wrapped: WrappedCek;
      try {
        wrapped = wrapCekForDevice(cek, Buffer.from(device.publicKey), { licenseId, docId });
      } finally {
        // CEK 평문은 래핑 직후 즉시 폐기합니다.
        wipe(cek);
      }

      const license = await tx.license.create({
        data: {
          id: licenseId,
          documentId: docId,
          recipientId,
          deviceId,
          issuedAt: now,
          expiresAt: new Date(now.getTime() + LICENSE_TTL_SECONDS * 1000),
        },
      });
      await tx.device.update({ where: { id: deviceId }, data: { lastSeenAt: now } });
      return {
        allowed: true as const,
        license,
        wrapped,
        email: recipient.email,
        contentType: PackagedContentTypeSchema.parse(document.contentType),
      };
    });

    if (!result.allowed) {
      const { decision } = result;
      const reason = decision.allowed ? "DEVICE_NOT_REGISTERED" : decision.reason;
      await this.audit.record({ ...auditBase, type: "LICENSE_DENIED", detail: { reason } });
      // 수신자 목록에 없는 사용자에게는 발신자 연락처를 노출하지 않습니다.
      const contact =
        reason === "NOT_RECIPIENT"
          ? undefined
          : { name: distribution.createdBy.name, email: distribution.createdBy.email };
      throw ApiException.denied(reason, DENY_MESSAGES[reason], contact);
    }

    const { license, wrapped } = result;
    const payload: LicensePayload = LicensePayloadSchema.parse({
      v: 1,
      licenseId: license.id,
      docId,
      recipientId,
      deviceId,
      contentType: result.contentType,
      issuedAt: license.issuedAt.toISOString(),
      expiresAt: license.expiresAt.toISOString(),
      permissions: { view: true },
      watermark: { text: watermarkText(result.email, license.issuedAt, docId) },
      key: {
        alg: KEY_WRAP_ALG,
        ephemeralPublicKey: wrapped.ephemeralPublicKey.toString("base64url"),
        wrappedKey: wrapped.wrappedKey.toString("base64url"),
      },
    } satisfies LicensePayload);

    const payloadBytes = Buffer.from(JSON.stringify(payload), "utf8");
    const signature = await this.signing.sign(SIGNING_CONTEXT.license, payloadBytes);

    await this.audit.record({
      ...auditBase,
      type: "LICENSE_ISSUED",
      detail: { licenseId: license.id, expiresAt: payload.expiresAt },
    });

    return {
      payload: payloadBytes.toString("base64url"),
      signature: signature.toString("base64url"),
      kid: this.signing.activeKid,
    };
  }

  /** 발급·거부 이벤트를 합산해 분당 한도를 적용합니다. */
  private async assertRateLimit(recipientId: string): Promise<void> {
    const recent = await this.prisma.auditEvent.count({
      where: {
        recipientId,
        type: { in: ["LICENSE_ISSUED", "LICENSE_DENIED"] },
        occurredAt: { gte: new Date(Date.now() - 60_000) },
      },
    });
    if (recent >= LICENSE_RATE_LIMIT_PER_MINUTE) {
      throw new ApiException("RATE_LIMITED", "요청이 너무 많습니다. 잠시 후 다시 시도하세요.");
    }
  }
}
