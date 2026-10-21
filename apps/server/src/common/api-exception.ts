import type { ApiError, CommonErrorCode, DenyReason, ErrorCode } from "@drm/contracts";

/** 오류 코드별 HTTP 상태 (docs/specs/license-api.md §1.1) */
const STATUS_BY_CODE: Record<CommonErrorCode, number> = {
  VALIDATION_FAILED: 400,
  OTP_INVALID: 400,
  OTP_EXPIRED: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  DEVICE_LIMIT_EXCEEDED: 409,
  RATE_LIMITED: 429,
  OTP_ATTEMPTS_EXCEEDED: 429,
  INTERNAL_ERROR: 500,
};

export const statusOf = (code: ErrorCode): number =>
  // 열람 거부 사유(DenyReason)는 모두 403
  STATUS_BY_CODE[code as CommonErrorCode] ?? 403;

type ApiErrorBody = ApiError["error"];

/**
 * 서비스 계층에서 던지는 표준 오류
 * 필터가 ApiErrorSchema 형식으로 변환합니다.
 */
export class ApiException extends Error {
  override readonly name = "ApiException";

  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly extra: Pick<ApiErrorBody, "contact" | "issues"> = {},
  ) {
    super(message);
  }

  get status(): number {
    return statusOf(this.code);
  }

  static notFound(message = "대상을 찾을 수 없습니다."): ApiException {
    return new ApiException("NOT_FOUND", message);
  }

  static unauthenticated(message = "인증이 필요합니다."): ApiException {
    return new ApiException("UNAUTHENTICATED", message);
  }

  static denied(reason: DenyReason, message: string, contact?: ApiErrorBody["contact"]) {
    return new ApiException(reason, message, contact ? { contact } : {});
  }
}
