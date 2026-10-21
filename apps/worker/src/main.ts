/**
 * 변환·패키징 워커 진입점
 * 서버가 등록한 패키징 작업(BullMQ)을 처리합니다.
 */
import { PACKAGING_QUEUE, PackagingJobSchema, type PackagingJob } from "@drm/contracts";
import { createPrismaClient } from "@drm/db";
import { createLocalKmsProvider, createLocalSigningKeyProvider } from "@drm/kms";
import { LocalFileStorage } from "@drm/storage";
import { UnrecoverableError, Worker } from "bullmq";
import { Redis } from "ioredis";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { pino } from "pino";
import { PdfPassthroughConverter } from "./converter.js";
import { loadWorkerEnv } from "./env.js";
import { Packager, TRANSIENT_FAILURE_MESSAGE } from "./packager.js";

const env = loadWorkerEnv();
const logger = pino({ level: env.LOG_LEVEL, base: { service: "worker" } });

await mkdir(dirname(env.KMS_KEYRING_PATH), { recursive: true });
const prisma = createPrismaClient(env.DATABASE_URL);
const packager = new Packager({
  prisma,
  storage: new LocalFileStorage(env.STORAGE_DIR),
  kms: await createLocalKmsProvider({
    keyringPath: env.KMS_KEYRING_PATH,
    nodeEnv: env.NODE_ENV,
    createIfMissing: true,
  }),
  signing: await createLocalSigningKeyProvider({
    keyringPath: env.SIGNING_KEYRING_PATH,
    nodeEnv: env.NODE_ENV,
    createIfMissing: true,
  }),
  converters: [new PdfPassthroughConverter()],
  logger,
});

const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
const worker = new Worker<PackagingJob>(
  PACKAGING_QUEUE,
  async (job) => {
    const parsed = PackagingJobSchema.safeParse(job.data);
    if (!parsed.success) throw new UnrecoverableError("잘못된 작업 데이터");
    return packager.package(parsed.data.docId);
  },
  { connection, concurrency: env.WORKER_CONCURRENCY },
);

// 일시적 오류로 재시도를 모두 소진하면 문서를 FAILED로 표시합니다.
worker.on("failed", async (job, error) => {
  if (!job) return;
  const attempts = job.opts.attempts ?? 1;
  logger.error({ docId: job.data.docId, attempt: job.attemptsMade, err: error }, "작업 실패");
  if (job.attemptsMade < attempts) return;
  const doc = await prisma.document.findUnique({ where: { id: job.data.docId } });
  if (doc && doc.status !== "PACKAGED" && doc.status !== "FAILED") {
    await packager.markFailed(doc.id, doc.distributionId, TRANSIENT_FAILURE_MESSAGE, error);
  }
});

logger.info({ concurrency: env.WORKER_CONCURRENCY }, "패키징 워커 시작");

const shutdown = async (signal: string) => {
  logger.info({ signal }, "종료 중 (진행 중인 작업 완료 대기)");
  await worker.close();
  await connection.quit();
  await prisma.$disconnect();
  process.exit(0);
};
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
