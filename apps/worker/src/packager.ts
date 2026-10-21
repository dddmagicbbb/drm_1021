/**
 * 문서 패키징: 원본 → (변환) → .drm 암호화 → 저장 → DB 갱신
 * 스펙: docs/specs/container.md, PRD FR-201·202·206, NFR-S8
 */
import { SIGNING_CONTEXT, generateCek, wipe } from "@drm/crypto";
import { type ContainerSigner, writeContainer } from "@drm/container";
import { type PrismaClient, writeAuditEvents } from "@drm/db";
import type { KmsProvider, SigningKeyProvider } from "@drm/kms";
import { type ObjectStorage, storageKeys } from "@drm/storage";
import type { Logger } from "pino";
import { type ContentConverter, PermanentPackagingError } from "./converter.js";

export interface PackagerDeps {
  prisma: PrismaClient;
  storage: ObjectStorage;
  kms: KmsProvider;
  signing: SigningKeyProvider;
  converters: ContentConverter[];
  logger: Logger;
}

export type PackagingOutcome = "PACKAGED" | "FAILED" | "SKIPPED";

/** 일시적 오류로 재시도를 모두 소진했을 때 발신자에게 보여줄 사유 */
export const TRANSIENT_FAILURE_MESSAGE =
  "일시적인 오류로 처리하지 못했습니다. 다시 업로드해 주세요.";

const signerFrom = (signing: SigningKeyProvider): ContainerSigner => ({
  kid: signing.activeKid,
  sign: (prefix) => signing.sign(SIGNING_CONTEXT.containerHeader, prefix),
});

export class Packager {
  constructor(private readonly deps: PackagerDeps) {}

  /**
   * 문서 하나를 패키징합니다. 같은 문서로 여러 번 호출해도 안전합니다(멱등).
   * 영구 오류는 FAILED로 기록하고 반환하며, 일시적 오류는 예외로 던져 큐가 재시도하게 합니다.
   */
  async package(docId: string): Promise<PackagingOutcome> {
    const { prisma, storage, logger } = this.deps;
    const doc = await prisma.document.findUnique({
      where: { id: docId },
      include: { distribution: true },
    });
    if (!doc || doc.status === "PACKAGED" || doc.status === "FAILED") {
      logger.info({ docId, status: doc?.status ?? null }, "패키징 대상이 아니어서 건너뜀");
      return "SKIPPED";
    }

    const uploadKey = storageKeys.upload(docId);
    const packageKey = storageKeys.package(docId);
    try {
      if (doc.revokedAt || doc.distribution.revokedAt) {
        throw new PermanentPackagingError("회수된 문서입니다.");
      }
      const converter = this.deps.converters.find((c) => c.supports(doc.sourceFormat));
      if (!converter) {
        throw new PermanentPackagingError(`지원하지 않는 형식입니다: ${doc.sourceFormat}`);
      }
      const uploaded = await storage.stat(uploadKey);
      if (!uploaded) throw new PermanentPackagingError("원본 파일을 찾을 수 없습니다.");

      await prisma.document.update({ where: { id: docId }, data: { status: "CONVERTING" } });

      const content = await converter.prepare({
        docId,
        fileName: doc.fileName,
        format: doc.sourceFormat,
        source: () => storage.get(uploadKey),
        size: uploaded.size,
      });
      try {
        const cek = generateCek();
        try {
          const wrapped = await this.deps.kms.wrapKey(cek, { docId });
          const { size: packageSize } = await storage.put(
            packageKey,
            writeContainer(await content.stream(), {
              docId,
              contentType: content.contentType,
              plaintextSize: content.size,
              cek,
              signer: signerFrom(this.deps.signing),
            }),
          );
          await prisma.$transaction(async (tx) => {
            await tx.document.update({
              where: { id: docId },
              data: {
                status: "PACKAGED",
                failureReason: null,
                contentType: content.contentType,
                packagePath: packageKey,
                packageSize: BigInt(packageSize),
                wrappedCek: Uint8Array.from(wrapped.ciphertext),
                kmsKeyId: wrapped.keyId,
              },
            });
            await writeAuditEvents(tx, [
              {
                type: "DOCUMENT_PACKAGED",
                actorType: "SYSTEM",
                distributionId: doc.distributionId,
                documentId: docId,
                detail: {
                  contentType: content.contentType,
                  plaintextSize: content.size,
                  packageSize,
                },
              },
            ]);
          });
        } finally {
          // CEK 평문은 KMS 래핑과 암호화에만 쓰고 즉시 폐기합니다.
          wipe(cek);
        }
      } finally {
        await content.cleanup();
      }

      // 원본은 패키징 완료 후 삭제합니다. (NFR-S8)
      await storage.delete(uploadKey);
      logger.info({ docId }, "패키징 완료");
      return "PACKAGED";
    } catch (error) {
      if (error instanceof PermanentPackagingError) {
        await this.markFailed(docId, doc.distributionId, error.userMessage, error);
        return "FAILED";
      }
      // 일시적 오류: 불완전한 패키지를 지우고 재시도에 맡깁니다.
      await storage.delete(packageKey).catch(() => undefined);
      throw error;
    }
  }

  /** 문서를 FAILED로 표시하고 원본·패키지를 정리합니다. */
  async markFailed(
    docId: string,
    distributionId: string,
    userMessage: string,
    cause?: unknown,
  ): Promise<void> {
    const { prisma, storage, logger } = this.deps;
    logger.warn({ docId, err: cause, reason: userMessage }, "패키징 실패");
    await prisma.$transaction(async (tx) => {
      await tx.document.update({
        where: { id: docId },
        data: { status: "FAILED", failureReason: userMessage },
      });
      await writeAuditEvents(tx, [
        {
          type: "DOCUMENT_PACKAGING_FAILED",
          actorType: "SYSTEM",
          distributionId,
          documentId: docId,
          detail: { reason: userMessage },
        },
      ]);
    });
    await storage.delete(storageKeys.upload(docId));
    await storage.delete(storageKeys.package(docId));
  }
}
