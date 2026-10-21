import { Injectable } from "@nestjs/common";
import { type AuditInput, type AuditWriter, writeAuditEvents } from "@drm/db";
import { currentRequestContext } from "../common/request-context.js";
import { PrismaService } from "../prisma/prisma.service.js";

export type { AuditInput, AuditWriter } from "@drm/db";

/**
 * 감사 로그 기록 (append-only)
 * 요청 컨텍스트의 IP·correlation ID를 자동으로 붙입니다.
 * 변경 작업과 같은 트랜잭션에서 기록하려면 tx를 전달합니다.
 */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(input: AuditInput, tx?: AuditWriter): Promise<void> {
    await this.recordMany([input], tx);
  }

  async recordMany(inputs: AuditInput[], tx?: AuditWriter): Promise<void> {
    await writeAuditEvents(tx ?? this.prisma, inputs, currentRequestContext());
  }
}
