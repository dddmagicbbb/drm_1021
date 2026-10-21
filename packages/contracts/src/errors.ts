import { z } from "zod";
import { EmailSchema } from "./common.js";
import { DenyReasonSchema } from "./policy.js";

/** 정책 거부 이외의 공통 오류 코드 */
export const CommonErrorCodeSchema = z.enum([
  "VALIDATION_FAILED",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "RATE_LIMITED",
  "OTP_INVALID",
  "OTP_EXPIRED",
  "OTP_ATTEMPTS_EXCEEDED",
  "DEVICE_LIMIT_EXCEEDED",
  "INTERNAL_ERROR",
]);
export type CommonErrorCode = z.infer<typeof CommonErrorCodeSchema>;

export const ErrorCodeSchema = z.union([CommonErrorCodeSchema, DenyReasonSchema]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

/** 모든 API 오류 응답 형식 */
export const ApiErrorSchema = z.object({
  error: z.object({
    code: ErrorCodeSchema,
    /** 사용자 표시용 한국어 메시지 */
    message: z.string(),
    correlationId: z.string().nullable(),
    /** 열람 거부 시 수신자에게 안내할 발신자 연락처 (FR-308) */
    contact: z
      .object({
        name: z.string(),
        email: EmailSchema,
      })
      .optional(),
    /** 입력값 검증 실패 상세 */
    issues: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;
