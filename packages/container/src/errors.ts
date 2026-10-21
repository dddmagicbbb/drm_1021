/** 스펙: docs/specs/container.md §6 */
export type ContainerErrorCode =
  | "INVALID_MAGIC"
  | "UNSUPPORTED_VERSION"
  | "INVALID_HEADER"
  | "UNKNOWN_KEY_ID"
  | "INVALID_SIGNATURE"
  | "TRUNCATED"
  | "TRAILING_DATA"
  | "DECRYPTION_FAILED"
  | "SIZE_MISMATCH";

/** .drm 파싱·암복호화 오류. 메시지에 키·평문을 포함하지 않습니다. */
export class ContainerError extends Error {
  override readonly name = "ContainerError";

  constructor(
    readonly code: ContainerErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}
