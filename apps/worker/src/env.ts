import { config } from "dotenv";
import { z } from "zod";

/** 변환 워커 환경 변수. 기동 시 검증하고 실패하면 기동을 중단합니다. */
export const WorkerEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  STORAGE_DIR: z.string().min(1).default("../../.local/storage"),
  KMS_KEYRING_PATH: z.string().min(1).default("../../.local/kms-keyring.json"),
  SIGNING_KEYRING_PATH: z.string().min(1).default("../../.local/signing-keyring.json"),
  /** 동시에 처리할 패키징 작업 수 */
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(2),
});
export type WorkerEnv = z.infer<typeof WorkerEnvSchema>;

export const loadWorkerEnv = (
  overrides: Partial<Record<keyof WorkerEnv, string>> = {},
): WorkerEnv => {
  config({ path: ["../../.env", ".env"], quiet: true });
  const result = WorkerEnvSchema.safeParse({ ...process.env, ...overrides });
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ");
    throw new Error(`환경 변수 검증 실패: ${issues}`);
  }
  return result.data;
};
