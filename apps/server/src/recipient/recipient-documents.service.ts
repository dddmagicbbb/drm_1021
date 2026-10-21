import { Inject, Injectable } from "@nestjs/common";
import { PackagedContentTypeSchema, type RecipientDocument } from "@drm/contracts";
import { type ObjectStorage, storageKeys } from "@drm/storage";
import type { Readable } from "node:stream";
import { AuditService } from "../audit/audit.service.js";
import { ApiException } from "../common/api-exception.js";
import { DENY_MESSAGES, evaluateAccess } from "../policy/policy-engine.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { STORAGE } from "../storage/storage.module.js";

@Injectable()
export class RecipientDocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(STORAGE) private readonly storage: ObjectStorage,
  ) {}

  /** 지금 열람(다운로드) 가능한 문서 목록. 판정은 정책 엔진의 다운로드 기준을 따릅니다. */
  async list(recipientId: string): Promise<RecipientDocument[]> {
    const memberships = await this.prisma.distributionRecipient.findMany({
      where: { recipientId, revokedAt: null, distribution: { revokedAt: null } },
      include: {
        distribution: {
          include: {
            createdBy: true,
            documents: { where: { status: "PACKAGED", revokedAt: null } },
          },
        },
      },
    });
    const now = new Date();
    return memberships.flatMap(({ distribution, ...membership }) =>
      distribution.documents
        .filter(
          (document) =>
            evaluateAccess({ membership, distribution, document }, { kind: "download" }, now)
              .allowed,
        )
        .map((document) => ({
          docId: document.id,
          fileName: document.fileName,
          contentType: PackagedContentTypeSchema.parse(document.contentType),
          distributionTitle: distribution.title,
          validUntil: distribution.validUntil.toISOString(),
          sender: { name: distribution.createdBy.name, email: distribution.createdBy.email },
        })),
    );
  }

  /** .drm 다운로드. 기기 조건을 제외한 정책을 통과해야 합니다. (스펙 §3.4) */
  async openPackage(
    recipientId: string,
    docId: string,
  ): Promise<{ fileName: string; size: number; stream: Readable }> {
    const document = await this.prisma.document.findUnique({
      where: { id: docId },
      include: { distribution: { include: { createdBy: true } } },
    });
    if (!document) throw ApiException.notFound("문서를 찾을 수 없습니다.");
    const { distribution } = document;
    const membership = await this.prisma.distributionRecipient.findUnique({
      where: { distributionId_recipientId: { distributionId: distribution.id, recipientId } },
    });
    const decision = evaluateAccess(
      { membership, distribution, document },
      { kind: "download" },
      new Date(),
    );
    const auditBase = {
      actorType: "RECIPIENT" as const,
      actorId: recipientId,
      recipientId,
      distributionId: distribution.id,
      documentId: docId,
    };
    if (!decision.allowed) {
      // 유출 조사(S7)를 위해 거부된 다운로드도 기록합니다.
      await this.audit.record({
        ...auditBase,
        type: "DOCUMENT_DOWNLOAD_DENIED",
        detail: { reason: decision.reason },
      });
      const contact =
        decision.reason === "NOT_RECIPIENT"
          ? undefined
          : { name: distribution.createdBy.name, email: distribution.createdBy.email };
      throw ApiException.denied(decision.reason, DENY_MESSAGES[decision.reason], contact);
    }

    const key = storageKeys.package(docId);
    const stat = await this.storage.stat(key);
    if (!stat) throw new Error(`PACKAGED 문서의 패키지 파일이 없습니다: ${docId}`);
    await this.audit.record({
      ...auditBase,
      type: "DOCUMENT_DOWNLOADED",
      detail: { size: stat.size },
    });
    return {
      fileName: `${document.fileName}.drm`,
      size: stat.size,
      stream: await this.storage.get(key),
    };
  }
}
