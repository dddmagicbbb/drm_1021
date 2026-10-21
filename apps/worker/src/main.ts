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
import { Notifier, createSmtpMailer } from "./notifier.js";
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

const mailer = createSmtpMailer({
  host: env.SMTP_HOST,
  port: env.SMTP_PORT,
  ...(env.SMTP_USER ? { user: env.SMTP_USER } : {}),
  ...(env.SMTP_PASSWORD ? { password: env.SMTP_PASSWORD } : {}),
  from: env.MAIL_FROM,
});
const notifier = new Notifier({
  prisma,
  mailer,
  logger,
  viewerDownloadUrl: env.VIEWER_DOWNLOAD_URL,
});

/** 메일 실패가 작업 재시도로 이어지지 않도록 오류를 기록만 합니다. */
const notifySafely = async (docId: string) => {
  try {
    await notifier.notifyForDocument(docId);
  } catch (error) {
    logger.error({ err: error, docId }, "안내 메일 처리 실패");
  }
};

const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
const worker = new Worker<PackagingJob>(
  PACKAGING_QUEUE,
  async (job) => {
    const parsed = PackagingJobSchema.safeParse(job.data);
    if (!parsed.success) throw new UnrecoverableError("잘못된 작업 데이터");
    const outcome = await packager.package(parsed.data.docId);
    // 실패한 문서가 마지막 대기 문서였을 수도 있으므로 결과와 관계없이 확인합니다.
    await notifySafely(parsed.data.docId);
    return outcome;
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
    await notifySafely(doc.id);
  }
});

logger.info({ concurrency: env.WORKER_CONCURRENCY }, "패키징 워커 시작");

const shutdown = async (signal: string) => {
  logger.info({ signal }, "종료 중 (진행 중인 작업 완료 대기)");
  await worker.close();
  await connection.quit();
  mailer.close();
  await prisma.$disconnect();
  process.exit(0);
};
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
