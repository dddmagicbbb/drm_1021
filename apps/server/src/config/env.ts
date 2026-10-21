import { config } from "dotenv";
import { z } from "zod";

/** 서버 환경 변수 스키마. 기동 시 한 번 검증하고, 실패하면 기동을 중단합니다. */
export const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  DATABASE_URL: z.string().url(),
  /** access 토큰(JWT HS256) 서명 비밀값 */
  JWT_SECRET: z.string().min(32, "32자 이상이어야 합니다"),
  /** 수신자 OTP HMAC 비밀값 */
  OTP_PEPPER: z.string().min(32, "32자 이상이어야 합니다"),
  SMTP_HOST: z.string().min(1),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535),
  /** SMTP 인증 (운영 메일 서버용, 로컬 Mailpit은 불필요) */
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  MAIL_FROM: z.string().min(1).default("DRM <no-reply@drm.local>"),
  /** 개발용 로컬 KMS 마스터키 키링 (운영에서는 사용 불가) */
  KMS_KEYRING_PATH: z.string().min(1).default("../../.local/kms-keyring.json"),
  /** 개발용 로컬 서명 키링 (운영에서는 사용 불가) */
  SIGNING_KEYRING_PATH: z.string().min(1).default("../../.local/signing-keyring.json"),
  /** 업로드 원본·패키지 저장 위치 (로컬 디스크) */
  STORAGE_DIR: z.string().min(1).default("../../.local/storage"),
  /** BullMQ 작업 큐 */
  REDIS_URL: z.string().url(),
  /**
   * 앞단 리버스 프록시 단계 수. 0이면 X-Forwarded-For를 무시합니다.
   * 프록시 없이 운영하면서 켜면 클라이언트가 IP를 위조해 발급 한도를 우회할 수 있습니다.
   */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
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
