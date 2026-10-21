import type { SourceFormat } from "@drm/contracts";
import { makeTestPdf } from "@drm/contracts/testing";
import { decryptContainer } from "@drm/container";
import { type PrismaClient, createPrismaClient } from "@drm/db";
import { type TestDatabase, createTestDatabase } from "@drm/db/testing";
import {
  LocalKmsProvider,
  LocalSigningKeyProvider,
  generateLocalKeyring,
  generateLocalSigningKeyring,
} from "@drm/kms";
import { LocalFileStorage, storageKeys } from "@drm/storage";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pino } from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PdfPassthroughConverter } from "../src/converter.js";
import { loadWorkerEnv } from "../src/env.js";
import { Packager, TRANSIENT_FAILURE_MESSAGE } from "../src/packager.js";
import { PDF_MESSAGES } from "../src/pdf-inspect.js";

const PDF = Buffer.from(makeTestPdf({ payload: randomBytes(3 * 1024 * 1024 + 123) }));
/** 작은 정상 PDF */
const smallPdf = () => Buffer.from(makeTestPdf({ payload: randomBytes(500) }));

describe("패키저 (T1-14)", () => {
  let db: TestDatabase;
  let prisma: PrismaClient;
  let storage: LocalFileStorage;
  let storageDir: string;
  let packager: Packager;
  let senderId: string;
  const kms = new LocalKmsProvider(generateLocalKeyring());
  const signing = new LocalSigningKeyProvider(generateLocalSigningKeyring("srv-test"));
  const resolveKey = (kid: string) => {
    const key = signing.publicKeys().find((k) => k.kid === kid);
    return key ? Buffer.from(key.publicKey, "base64url") : undefined;
  };

  /** 업로드 완료 상태의 문서 생성 */
  const uploaded = async (
    content: Buffer,
    options: { format?: SourceFormat; revoked?: boolean; skipFile?: boolean } = {},
  ) => {
    const dist = await prisma.distribution.create({
      data: {
        title: "배포",
        createdById: senderId,
        validFrom: new Date(),
        validUntil: new Date(Date.now() + 86400_000),
        allowWeb: true,
        securityLevel: "NORMAL",
        offlineGraceHours: 0,
        maxDevices: 2,
        revokedAt: options.revoked ? new Date() : null,
      },
    });
    const doc = await prisma.document.create({
      data: {
        distributionId: dist.id,
        fileName: "도면.pdf",
        sourceFormat: options.format ?? "PDF",
        sourceSize: BigInt(content.length),
      },
    });
    if (!options.skipFile) await storage.put(storageKeys.upload(doc.id), Readable.from([content]));
    return doc;
  };

  const auditTypes = async (docId: string) =>
    (
      await db.query<{ type: string }>(
        `SELECT type FROM audit_events WHERE "documentId" = $1 ORDER BY "occurredAt"`,
        [docId],
      )
    ).rows.map((r) => r.type);

  beforeAll(async () => {
    db = await createTestDatabase(loadWorkerEnv({ NODE_ENV: "test" }).DATABASE_URL);
    prisma = createPrismaClient(db.url);
    storageDir = await mkdtemp(join(tmpdir(), "drm-worker-"));
    storage = new LocalFileStorage(storageDir);
    packager = new Packager({
      prisma,
      storage,
      kms,
      signing,
      converters: [new PdfPassthroughConverter()],
      logger: pino({ level: "silent" }),
    });
    senderId = (
      await prisma.user.create({
        data: { email: `s-${randomUUID()}@company.com`, name: "발신", passwordHash: "x" },
      })
    ).id;
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await db?.drop();
    await rm(storageDir, { recursive: true, force: true });
  });

  it("PDF를 .drm으로 패키징하고, CEK로 복호화하면 원본과 같다", async () => {
    const doc = await uploaded(PDF);
    expect(await packager.package(doc.id)).toBe("PACKAGED");

    const saved = await prisma.document.findUniqueOrThrow({ where: { id: doc.id } });
    expect(saved).toMatchObject({
      status: "PACKAGED",
      contentType: "application/pdf",
      packagePath: storageKeys.package(doc.id),
      failureReason: null,
    });

    // 원본 삭제 (NFR-S8), 패키지 존재
    expect(await storage.stat(storageKeys.upload(doc.id))).toBeNull();
    const pkg = await storage.stat(storageKeys.package(doc.id));
    expect(pkg?.size).toBe(Number(saved.packageSize));

    // KMS로 CEK를 풀어 컨테이너 복호화
    const cek = await kms.unwrapKey(
      { keyId: saved.kmsKeyId!, ciphertext: Buffer.from(saved.wrappedCek!) },
      { docId: doc.id },
    );
    const parts: Buffer[] = [];
    for await (const p of await storage.get(storageKeys.package(doc.id))) parts.push(p as Buffer);
    const { header, plaintext } = await decryptContainer(Buffer.concat(parts), cek, resolveKey);
    expect(header).toMatchObject({
      docId: doc.id,
      contentType: "application/pdf",
      kid: "srv-test",
    });
    expect(plaintext.equals(PDF)).toBe(true);

    // 패키지 파일에 평문이 그대로 들어있지 않음
    expect(Buffer.concat(parts).includes(PDF.subarray(PDF.length / 2, PDF.length / 2 + 100))).toBe(
      false,
    );
    expect(await auditTypes(doc.id)).toEqual(["DOCUMENT_PACKAGED"]);
  });

  it("이미 처리된 문서는 건너뛴다 (멱등)", async () => {
    const doc = await uploaded(smallPdf());
    expect(await packager.package(doc.id)).toBe("PACKAGED");
    expect(await packager.package(doc.id)).toBe("SKIPPED");
    expect(await packager.package(randomUUID())).toBe("SKIPPED");
    expect(await auditTypes(doc.id)).toEqual(["DOCUMENT_PACKAGED"]);
  });

  it.each([
    ["회수된 배포 건", { revoked: true }, "회수된 문서입니다."],
    ["원본 파일 없음", { skipFile: true }, "원본 파일을 찾을 수 없습니다."],
    ["변환기 없는 형식", { format: "DOCX" as const }, "지원하지 않는 형식입니다: DOCX"],
  ])("%s → FAILED, 사유 기록, 파일 정리", async (_label, options, reason) => {
    const doc = await uploaded(smallPdf(), options);
    expect(await packager.package(doc.id)).toBe("FAILED");
    const saved = await prisma.document.findUniqueOrThrow({ where: { id: doc.id } });
    expect(saved).toMatchObject({ status: "FAILED", failureReason: reason, wrappedCek: null });
    expect(await storage.stat(storageKeys.upload(doc.id))).toBeNull();
    expect(await storage.stat(storageKeys.package(doc.id))).toBeNull();
    expect(await auditTypes(doc.id)).toEqual(["DOCUMENT_PACKAGING_FAILED"]);
  });

  it.each([
    ["암호가 걸린 PDF", Buffer.from(makeTestPdf({ encrypted: true })), PDF_MESSAGES.password],
    [
      "손상된 PDF",
      Buffer.concat([Buffer.from("%PDF-1.7\n"), randomBytes(2000)]),
      PDF_MESSAGES.invalid,
    ],
  ])("%s는 배포 전에 거부한다", async (_label, content, reason) => {
    const doc = await uploaded(content);
    expect(await packager.package(doc.id)).toBe("FAILED");
    const saved = await prisma.document.findUniqueOrThrow({ where: { id: doc.id } });
    expect(saved).toMatchObject({ status: "FAILED", failureReason: reason });
  });

  it("일시적 오류는 예외로 던지고 불완전한 패키지를 남기지 않는다 (재시도 대상)", async () => {
    const doc = await uploaded(smallPdf());
    const flaky = new Packager({
      prisma,
      storage,
      kms: {
        name: "flaky",
        wrapKey: async () => {
          throw new Error("KMS 일시 장애");
        },
        unwrapKey: kms.unwrapKey.bind(kms),
      },
      signing,
      converters: [new PdfPassthroughConverter()],
      logger: pino({ level: "silent" }),
    });
    await expect(flaky.package(doc.id)).rejects.toThrow("KMS 일시 장애");
    const saved = await prisma.document.findUniqueOrThrow({ where: { id: doc.id } });
    expect(saved.status).toBe("CONVERTING");
    // 원본은 재시도를 위해 유지
    expect(await storage.stat(storageKeys.upload(doc.id))).not.toBeNull();
    expect(await storage.stat(storageKeys.package(doc.id))).toBeNull();

    // 재시도에서 정상 처리
    expect(await packager.package(doc.id)).toBe("PACKAGED");
  });

  it("재시도를 모두 소진하면 FAILED로 표시한다", async () => {
    const doc = await uploaded(smallPdf());
    await packager.markFailed(doc.id, doc.distributionId, TRANSIENT_FAILURE_MESSAGE);
    const saved = await prisma.document.findUniqueOrThrow({ where: { id: doc.id } });
    expect(saved).toMatchObject({ status: "FAILED", failureReason: TRANSIENT_FAILURE_MESSAGE });
    expect(await storage.stat(storageKeys.upload(doc.id))).toBeNull();
  });
});
