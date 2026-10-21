import { z } from "zod";
import { Base64UrlSchema, IdSchema, IsoDateTimeSchema, base64UrlBytes } from "./common.js";
import { PackagedContentTypeSchema } from "./document.js";

/** 라이선스 기본 수명 (초). 만료 전에 뷰어가 재발급을 요청합니다. (NFR-S3) */
export const LICENSE_TTL_SECONDS = 600;

/** CEK 래핑 알고리즘 식별자. 상세는 docs/specs/license-api.md 참고 */
export const KEY_WRAP_ALG = "X25519-HKDF-SHA256-A256KW" as const;

export const LicenseRequestSchema = z.object({
  docId: IdSchema,
  deviceId: IdSchema,
});
export type LicenseRequest = z.infer<typeof LicenseRequestSchema>;

/** 기기 공개키로 래핑된 CEK */
export const WrappedKeySchema = z.object({
  alg: z.literal(KEY_WRAP_ALG),
  /** 서버가 라이선스마다 새로 만든 임시 X25519 공개키 (32바이트) */
  ephemeralPublicKey: base64UrlBytes(32),
  /** AES-256-KW로 래핑된 CEK (32바이트 키 → 40바이트) */
  wrappedKey: base64UrlBytes(40),
});
export type WrappedKey = z.infer<typeof WrappedKeySchema>;

/** 서버가 서명하는 라이선스 본문 */
export const LicensePayloadSchema = z.object({
  v: z.literal(1),
  licenseId: IdSchema,
  docId: IdSchema,
  recipientId: IdSchema,
  deviceId: IdSchema,
  contentType: PackagedContentTypeSchema,
  issuedAt: IsoDateTimeSchema,
  expiresAt: IsoDateTimeSchema,
  /** 1단계는 열람만 허용합니다. 향후 권한 확장을 위한 필드입니다. */
  permissions: z.object({
    view: z.literal(true),
  }),
  watermark: z.object({
    /** 화면에 반복 표시할 문구 (수신자 이메일, 발급 시각, 문서 ID) */
    text: z.string().min(1).max(200),
  }),
  key: WrappedKeySchema,
});
export type LicensePayload = z.infer<typeof LicensePayloadSchema>;

/**
 * 서명된 라이선스 (API 응답)
 * payload는 JSON을 UTF-8로 직렬화한 바이트의 base64url입니다.
 * 서명은 이 바이트에 대해 계산하므로 재직렬화 없이 검증할 수 있습니다.
 */
export const SignedLicenseSchema = z.object({
  payload: Base64UrlSchema,
  /** Ed25519 서명 (64바이트) */
  signature: base64UrlBytes(64),
  /** 서명 키 식별자. 뷰어는 내장된 서버 공개키 목록에서 찾습니다. */
  kid: z.string().min(1).max(64),
});
export type SignedLicense = z.infer<typeof SignedLicenseSchema>;
