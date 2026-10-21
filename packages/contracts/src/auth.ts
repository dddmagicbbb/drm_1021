import { z } from "zod";
import { EmailSchema, IdSchema, base64UrlBytes } from "./common.js";

// ── 발신자 (사내 사용자) ──────────────────────────────────────

export const SenderLoginRequestSchema = z.object({
  email: EmailSchema,
  password: z.string().min(1).max(256),
});
export type SenderLoginRequest = z.infer<typeof SenderLoginRequestSchema>;

export const RefreshTokenRequestSchema = z.object({
  refreshToken: z.string().min(1),
});
export type RefreshTokenRequest = z.infer<typeof RefreshTokenRequestSchema>;

export const TokenResponseSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  /** accessToken 유효 시간 (초) */
  expiresIn: z.number().int().positive(),
});
export type TokenResponse = z.infer<typeof TokenResponseSchema>;

// ── 수신자 (고객사 사용자) ────────────────────────────────────

/** OTP 자릿수 */
export const OTP_LENGTH = 6;

export const OtpRequestSchema = z.object({
  email: EmailSchema,
});
export type OtpRequest = z.infer<typeof OtpRequestSchema>;

export const OtpVerifyRequestSchema = z.object({
  email: EmailSchema,
  code: z.string().regex(new RegExp(`^\\d{${OTP_LENGTH}}$`), `OTP는 숫자 ${OTP_LENGTH}자리입니다`),
});
export type OtpVerifyRequest = z.infer<typeof OtpVerifyRequestSchema>;

// ── 기기 ──────────────────────────────────────────────────

export const DevicePlatformSchema = z.enum(["WINDOWS", "WEB"]);
export type DevicePlatform = z.infer<typeof DevicePlatformSchema>;

/** X25519 공개키 (raw 32바이트, base64url) */
export const X25519PublicKeySchema = base64UrlBytes(32);

export const RegisterDeviceRequestSchema = z.object({
  publicKey: X25519PublicKeySchema,
  name: z.string().trim().min(1).max(100),
  platform: DevicePlatformSchema,
});
export type RegisterDeviceRequest = z.infer<typeof RegisterDeviceRequestSchema>;

export const RegisterDeviceResponseSchema = z.object({
  deviceId: IdSchema,
});
export type RegisterDeviceResponse = z.infer<typeof RegisterDeviceResponseSchema>;
