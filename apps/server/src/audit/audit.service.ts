import { Injectable } from "@nestjs/common";
import type { ActorType, AuditEventType } from "@drm/contracts";
import { currentRequestContext } from "../common/request-context.js";
import type { Prisma } from "../generated/prisma/client.js";
import { PrismaService } from "../prisma/prisma.service.js";

export interface AuditInput {
  type: AuditEventType;
  actorType: ActorType;
  actorId?: string | null;
  distributionId?: string | null;
  documentId?: string | null;
  recipientId?: string | null;
  deviceId?: string | null;
  detail?: Record<string, unknown>;
}

/** 트랜잭션 안에서 기록할 때 전달하는 클라이언트 */
export type AuditWriter = Pick<Prisma.TransactionClient, "auditEvent">;

/** 이름에 이 단어가 들어간 필드는 값을 기록하지 않습니다. (NFR-S7) */
const SENSITIVE_KEY = /pass|secret|token|otp|code|cek|key|signature|authorization|cookie/i;
const REDACTED = "[REDACTED]";
const MAX_DEPTH = 5;

/** detail 객체에서 민감 필드를 재귀적으로 가립니다. */
export const maskSensitive = (value: unknown, depth = 0): unknown => {
  if (depth > MAX_DEPTH) return REDACTED;
  if (Array.isArray(value)) return value.map((v) => maskSensitive(v, depth + 1));
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return REDACTED;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        SENSITIVE_KEY.test(k) ? REDACTED : maskSensitive(v, depth + 1),
      ]),
    );
  }
  if (typeof value === "bigint") return value.toString();
  return value;
};

/**
 * 감사 로그 기록 (append-only)
 * 변경 작업과 같은 트랜잭션에서 기록하려면 tx를 전달합니다.
 */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(input: AuditInput, tx?: AuditWriter): Promise<void> {
    await this.recordMany([input], tx);
  }

  async recordMany(inputs: AuditInput[], tx?: AuditWriter): Promise<void> {
    if (inputs.length === 0) return;
    const { correlationId, ip } = currentRequestContext();
    await (tx ?? this.prisma).auditEvent.createMany({
      data: inputs.map((input) => ({
        type: input.type,
        actorType: input.actorType,
        actorId: input.actorId ?? null,
        distributionId: input.distributionId ?? null,
        documentId: input.documentId ?? null,
        recipientId: input.recipientId ?? null,
        deviceId: input.deviceId ?? null,
        ip,
        correlationId,
        detail: maskSensitive(input.detail ?? {}) as Prisma.InputJsonValue,
      })),
    });
  }
}
