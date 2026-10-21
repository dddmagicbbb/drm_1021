import { config } from "dotenv";
import { z } from "zod";

/** 서버 환경 변수 스키마. 기동 시 한 번 검증하고, 실패하면 기동을 중단합니다. */
export const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  DATABASE_URL: z.string().url(),
});
export type Env = z.infer<typeof EnvSchema>;

export const ENV = Symbol("ENV");

/**
 * 환경 변수를 읽어 검증합니다.
 * 저장소 루트의 .env → apps/server/.env 순으로 읽고, 이미 설정된 프로세스 환경 변수가 우선합니다.
 */
export const loadEnv = (overrides: Partial<Record<keyof Env, string>> = {}): Env => {
  config({ path: ["../../.env", ".env"], quiet: true });
  const result = EnvSchema.safeParse({ ...process.env, ...overrides });
  if (!result.success) {
    // 값 자체는 비밀일 수 있으므로 항목 이름과 사유만 출력합니다.
    const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", ");
    throw new Error(`환경 변수 검증 실패: ${issues}`);
  }
  return result.data;
};
