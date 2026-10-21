import { Injectable } from "@nestjs/common";
import { DEFAULT_POLICY_VALUES, type RegisterDeviceRequest } from "@drm/contracts";
import { CryptoError, generateCek, wipe, wrapCekForDevice } from "@drm/crypto";
import { randomUUID } from "node:crypto";
import { AuditService } from "../audit/audit.service.js";
import { ApiException } from "../common/api-exception.js";
import { toBytes } from "../common/bytes.js";
import { PrismaService } from "../prisma/prisma.service.js";

export interface RegisterDeviceResult {
  deviceId: string;
  /** false면 이미 등록된 같은 공개키 (멱등) */
  created: boolean;
}

/**
 * X25519 공개키가 실제로 키 래핑에 쓸 수 있는 값인지 확인합니다.
 * 저차수 점 등은 등록 단계에서 거부해야 라이선스 발급 시 오류가 나지 않습니다.
 */
const assertUsablePublicKey = (publicKey: Buffer): void => {
  const probe = generateCek();
  try {
    wrapCekForDevice(probe, publicKey, { licenseId: randomUUID(), docId: randomUUID() });
  } catch (error) {
    if (error instanceof CryptoError) {
      throw new ApiException("VALIDATION_FAILED", "기기 공개키가 올바르지 않습니다.", {
        issues: [{ path: "publicKey", message: "유효한 X25519 공개키가 아닙니다" }],
      });
    }
    throw error;
  } finally {
    wipe(probe);
  }
};

@Injectable()
export class DevicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async register(recipientId: string, input: RegisterDeviceRequest): Promise<RegisterDeviceResult> {
    const publicKey = Buffer.from(input.publicKey, "base64url");
    assertUsablePublicKey(publicKey);

    return this.prisma.$transaction(async (tx) => {
      // 같은 수신자의 동시 등록을 직렬화하여 기기 수 한도를 넘지 않게 합니다.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${recipientId}))`;

      const existing = await tx.device.findUnique({ where: { publicKey: toBytes(publicKey) } });
      if (existing) {
        if (existing.recipientId !== recipientId) {
          throw new ApiException("CONFLICT", "이미 다른 사용자에게 등록된 기기 키입니다.");
        }
        if (existing.revokedAt) {
          throw new ApiException("CONFLICT", "등록이 해제된 기기입니다. 발신자에게 문의하세요.");
        }
        return { deviceId: existing.id, created: false };
      }

      const limit = await this.deviceLimitFor(tx, recipientId);
      const active = await tx.device.count({ where: { recipientId, revokedAt: null } });
      if (active >= limit) {
        throw new ApiException(
          "DEVICE_LIMIT_EXCEEDED",
          `등록 가능한 기기 수(${limit}대)를 초과했습니다. 발신자에게 기존 기기 해제를 요청하세요.`,
        );
      }

      const device = await tx.device.create({
        data: {
          recipientId,
          publicKey: toBytes(publicKey),
          name: input.name,
          platform: input.platform,
        },
      });
      await this.audit.record(
        {
          type: "DEVICE_REGISTERED",
          actorType: "RECIPIENT",
          actorId: recipientId,
          recipientId,
          deviceId: device.id,
          detail: { name: input.name, platform: input.platform, activeDevices: active + 1 },
        },
        tx,
      );
      return { deviceId: device.id, created: true };
    });
  }

  /** 수신자가 속한 유효 배포 건 정책 중 가장 작은 maxDevices (docs/specs/license-api.md §3.3) */
  private async deviceLimitFor(
    tx: Pick<PrismaService, "distribution">,
    recipientId: string,
  ): Promise<number> {
    const { _min } = await tx.distribution.aggregate({
      _min: { maxDevices: true },
      where: {
        revokedAt: null,
        validUntil: { gt: new Date() },
        recipients: { some: { recipientId, revokedAt: null } },
      },
    });
    return _min.maxDevices ?? DEFAULT_POLICY_VALUES.maxDevices;
  }
}
