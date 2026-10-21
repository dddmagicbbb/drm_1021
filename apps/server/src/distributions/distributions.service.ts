import { Injectable } from "@nestjs/common";
import {
  MAX_RECIPIENTS_PER_DISTRIBUTION,
  type CreateDistributionRequest,
  type Distribution,
  type DistributionSummary,
  type Document,
  type UpdateDistributionRequest,
} from "@drm/contracts";
import { type AuditInput, AuditService } from "../audit/audit.service.js";
import { ApiException } from "../common/api-exception.js";
import type { Prisma } from "@drm/db";
import { PrismaService } from "../prisma/prisma.service.js";
import {
  policyColumns,
  policyOf,
  toDistribution,
  toDocument,
  toSummary,
} from "./distribution.mapper.js";

type Tx = Prisma.TransactionClient;

const WITH_RELATIONS = {
  recipients: { include: { recipient: true } },
  documents: true,
} as const;

@Injectable()
export class DistributionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async create(senderId: string, input: CreateDistributionRequest): Promise<Distribution> {
    return this.prisma.$transaction(async (tx) => {
      const distribution = await tx.distribution.create({
        data: { title: input.title, createdById: senderId, ...policyColumns(input.policy) },
      });
      const added = await this.addRecipients(tx, distribution.id, input.recipients);
      await this.audit.recordMany(
        [
          {
            type: "DISTRIBUTION_CREATED",
            actorType: "SENDER",
            actorId: senderId,
            distributionId: distribution.id,
            detail: { title: input.title, policy: input.policy, recipientCount: added.length },
          },
          ...added.map((r) => this.recipientEvent("RECIPIENT_ADDED", senderId, distribution.id, r)),
        ],
        tx,
      );
      return this.load(tx, senderId, distribution.id);
    });
  }

  async list(senderId: string, page: number, size: number): Promise<DistributionSummary[]> {
    const rows = await this.prisma.distribution.findMany({
      where: { createdById: senderId },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * size,
      take: size,
      include: { _count: { select: { recipients: true, documents: true } } },
    });
    return rows.map(toSummary);
  }

  get(senderId: string, id: string): Promise<Distribution> {
    return this.load(this.prisma, senderId, id);
  }

  async update(
    senderId: string,
    id: string,
    input: UpdateDistributionRequest,
  ): Promise<Distribution> {
    return this.prisma.$transaction(async (tx) => {
      const current = await this.owned(tx, senderId, id);
      if (current.revokedAt) {
        throw new ApiException("CONFLICT", "회수된 배포 건은 수정할 수 없습니다.");
      }

      const events: AuditInput[] = [];
      if (input.title !== undefined || input.policy !== undefined) {
        await tx.distribution.update({
          where: { id },
          data: {
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(input.policy ? policyColumns(input.policy) : {}),
          },
        });
        events.push({
          type: "DISTRIBUTION_UPDATED",
          actorType: "SENDER",
          actorId: senderId,
          distributionId: id,
          detail: {
            ...(input.title !== undefined
              ? { title: { from: current.title, to: input.title } }
              : {}),
            ...(input.policy ? { policy: { from: policyOf(current), to: input.policy } } : {}),
          },
        });
      }

      if (input.removeRecipientIds?.length) {
        const removed = await tx.distributionRecipient.findMany({
          where: { distributionId: id, recipientId: { in: input.removeRecipientIds } },
          include: { recipient: true },
        });
        await tx.distributionRecipient.deleteMany({
          where: { distributionId: id, recipientId: { in: removed.map((m) => m.recipientId) } },
        });
        events.push(
          ...removed.map((m) =>
            this.recipientEvent("RECIPIENT_REMOVED", senderId, id, {
              id: m.recipientId,
              email: m.recipient.email,
            }),
          ),
        );
      }

      if (input.addRecipients?.length) {
        const added = await this.addRecipients(tx, id, input.addRecipients);
        events.push(...added.map((r) => this.recipientEvent("RECIPIENT_ADDED", senderId, id, r)));
      }

      const remaining = await tx.distributionRecipient.count({ where: { distributionId: id } });
      if (remaining > MAX_RECIPIENTS_PER_DISTRIBUTION) {
        throw new ApiException(
          "VALIDATION_FAILED",
          `수신자는 최대 ${MAX_RECIPIENTS_PER_DISTRIBUTION}명까지 등록할 수 있습니다.`,
        );
      }
      if (remaining === 0) {
        throw new ApiException("VALIDATION_FAILED", "수신자는 최소 1명 이상이어야 합니다.", {
          issues: [{ path: "removeRecipientIds", message: "모든 수신자를 삭제할 수 없습니다" }],
        });
      }

      await this.audit.recordMany(events, tx);
      return this.load(tx, senderId, id);
    });
  }

  /** 배포 건 전체 회수 (멱등) */
  async revoke(senderId: string, id: string): Promise<Distribution> {
    return this.prisma.$transaction(async (tx) => {
      const current = await this.owned(tx, senderId, id);
      if (!current.revokedAt) {
        await tx.distribution.update({ where: { id }, data: { revokedAt: new Date() } });
        await this.audit.record(
          {
            type: "DISTRIBUTION_REVOKED",
            actorType: "SENDER",
            actorId: senderId,
            distributionId: id,
          },
          tx,
        );
      }
      return this.load(tx, senderId, id);
    });
  }

  /** 특정 수신자 회수 (멱등) */
  async revokeRecipient(senderId: string, id: string, recipientId: string): Promise<Distribution> {
    return this.prisma.$transaction(async (tx) => {
      await this.owned(tx, senderId, id);
      const membership = await tx.distributionRecipient.findUnique({
        where: { distributionId_recipientId: { distributionId: id, recipientId } },
        include: { recipient: true },
      });
      if (!membership) throw ApiException.notFound("배포 건에 해당 수신자가 없습니다.");
      if (!membership.revokedAt) {
        await tx.distributionRecipient.update({
          where: { distributionId_recipientId: { distributionId: id, recipientId } },
          data: { revokedAt: new Date() },
        });
        await this.audit.record(
          this.recipientEvent("RECIPIENT_REVOKED", senderId, id, {
            id: recipientId,
            email: membership.recipient.email,
          }),
          tx,
        );
      }
      return this.load(tx, senderId, id);
    });
  }

  /** 문서 회수 (멱등) */
  async revokeDocument(senderId: string, docId: string): Promise<Document> {
    return this.prisma.$transaction(async (tx) => {
      const document = await tx.document.findFirst({
        where: { id: docId, distribution: { createdById: senderId } },
      });
      if (!document) throw ApiException.notFound("문서를 찾을 수 없습니다.");
      if (document.revokedAt) return toDocument(document);

      const updated = await tx.document.update({
        where: { id: docId },
        data: { revokedAt: new Date() },
      });
      await this.audit.record(
        {
          type: "DOCUMENT_REVOKED",
          actorType: "SENDER",
          actorId: senderId,
          distributionId: document.distributionId,
          documentId: docId,
          detail: { fileName: document.fileName },
        },
        tx,
      );
      return toDocument(updated);
    });
  }

  /** 본인이 만든 배포 건만 조회. 남의 배포 건은 존재 여부를 숨기기 위해 404 */
  private async owned(tx: Tx, senderId: string, id: string) {
    const row = await tx.distribution.findFirst({ where: { id, createdById: senderId } });
    if (!row) throw ApiException.notFound("배포 건을 찾을 수 없습니다.");
    return row;
  }

  private async load(tx: Tx | PrismaService, senderId: string, id: string): Promise<Distribution> {
    const row = await tx.distribution.findFirst({
      where: { id, createdById: senderId },
      include: WITH_RELATIONS,
    });
    if (!row) throw ApiException.notFound("배포 건을 찾을 수 없습니다.");
    return toDistribution(row);
  }

  /** 수신자 upsert 후 배포 건에 연결. 이미 연결된 수신자는 건너뜁니다. */
  private async addRecipients(
    tx: Tx,
    distributionId: string,
    emails: string[],
  ): Promise<{ id: string; email: string }[]> {
    const unique = [...new Set(emails)];
    await tx.recipient.createMany({
      data: unique.map((email) => ({ email })),
      skipDuplicates: true,
    });
    const recipients = await tx.recipient.findMany({
      where: { email: { in: unique } },
      select: { id: true, email: true },
    });
    const existing = await tx.distributionRecipient.findMany({
      where: { distributionId, recipientId: { in: recipients.map((r) => r.id) } },
      select: { recipientId: true },
    });
    const already = new Set(existing.map((m) => m.recipientId));
    const toAdd = recipients.filter((r) => !already.has(r.id));
    await tx.distributionRecipient.createMany({
      data: toAdd.map((r) => ({ distributionId, recipientId: r.id })),
    });
    return toAdd;
  }

  private recipientEvent(
    type: "RECIPIENT_ADDED" | "RECIPIENT_REMOVED" | "RECIPIENT_REVOKED",
    senderId: string,
    distributionId: string,
    recipient: { id: string; email: string },
  ): AuditInput {
    return {
      type,
      actorType: "SENDER",
      actorId: senderId,
      distributionId,
      recipientId: recipient.id,
      detail: { email: recipient.email },
    };
  }
}
