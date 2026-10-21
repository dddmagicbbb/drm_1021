import { Inject, Injectable } from "@nestjs/common";
import type { Document } from "@drm/contracts";
import { type ObjectStorage, storageKeys } from "@drm/storage";
import type { Request } from "express";
import { randomUUID } from "node:crypto";
import { AuditService } from "../audit/audit.service.js";
import { ApiException } from "../common/api-exception.js";
import { toDocument } from "../distributions/distribution.mapper.js";
import { PrismaService } from "../prisma/prisma.service.js";
import { STORAGE } from "../storage/storage.module.js";
import { PACKAGING_QUEUE_TOKEN, type PackagingQueue } from "./packaging-queue.js";
import { receiveSingleFile } from "./upload.js";

@Injectable()
export class DocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(STORAGE) private readonly storage: ObjectStorage,
    @Inject(PACKAGING_QUEUE_TOKEN) private readonly queue: PackagingQueue,
  ) {}

  /**
   * 문서 업로드 (FR-101)
   * 원본을 저장소에 스트리밍으로 저장하고 패키징 작업을 등록합니다. 변환·암호화는 워커가 수행합니다.
   */
  async upload(senderId: string, distributionId: string, req: Request): Promise<Document> {
    // 본문을 읽기 전에 권한을 먼저 확인합니다.
    const distribution = await this.prisma.distribution.findFirst({
      where: { id: distributionId, createdById: senderId },
    });
    if (!distribution) throw ApiException.notFound("배포 건을 찾을 수 없습니다.");
    if (distribution.revokedAt) {
      throw new ApiException("CONFLICT", "회수된 배포 건에는 문서를 추가할 수 없습니다.");
    }

    const file = await receiveSingleFile(req);
    const docId = randomUUID();
    const key = storageKeys.upload(docId);
    const { size } = await this.storage.put(key, file.stream);

    let document;
    try {
      document = await this.prisma.$transaction(async (tx) => {
        const created = await tx.document.create({
          data: {
            id: docId,
            distributionId,
            fileName: file.fileName,
            sourceFormat: file.sourceFormat,
            sourceSize: BigInt(size),
            status: "UPLOADED",
          },
        });
        await this.audit.record(
          {
            type: "DOCUMENT_UPLOADED",
            actorType: "SENDER",
            actorId: senderId,
            distributionId,
            documentId: docId,
            detail: { fileName: file.fileName, sourceFormat: file.sourceFormat, size },
          },
          tx,
        );
        return created;
      });
    } catch (error) {
      // DB 기록에 실패하면 고아 파일이 남지 않도록 원본을 지웁니다.
      await this.storage.delete(key);
      throw error;
    }

    await this.queue.enqueue({ docId });
    return toDocument(document);
  }
}
