export type CryptoErrorCode =
  | "INVALID_KEY"
  | "INVALID_ARGUMENT"
  | "INVALID_STATE"
  | "DECRYPTION_FAILED"
  | "UNWRAP_FAILED"
  | "INVALID_PUBLIC_KEY";

/**
 * 암호 연산 오류
 * 메시지에 키·평문·논스 값을 절대 포함하지 않습니다.
 */
export class CryptoError extends Error {
  override readonly name = "CryptoError";

  constructor(
    readonly code: CryptoErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}
