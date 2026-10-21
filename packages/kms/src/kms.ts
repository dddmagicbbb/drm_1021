/**
 * KMS 추상화
 * 문서별 CEK를 마스터키로 봉투 암호화(Envelope Encryption)합니다.
 * 운영 환경은 Vault Transit / AWS KMS 구현체로 교체합니다. (T2-10)
 */

/** 래핑 문맥. 래핑된 키가 해당 문서에만 쓰이도록 묶습니다. */
export interface KeyContext {
  docId: string;
}

/** DB에 저장하는 래핑된 CEK */
export interface WrappedDataKey {
  /** 래핑에 사용한 마스터키 버전. 키 교체 후에도 기존 문서를 풀 수 있도록 함께 저장합니다. */
  keyId: string;
  ciphertext: Buffer;
}

export interface KmsProvider {
  readonly name: string;
  /** 현재 활성 마스터키로 CEK를 래핑합니다. */
  wrapKey(plaintextKey: Uint8Array, context: KeyContext): Promise<WrappedDataKey>;
  /** keyId에 해당하는 마스터키로 언래핑합니다. 문맥이 다르면 실패합니다. */
  unwrapKey(wrapped: WrappedDataKey, context: KeyContext): Promise<Buffer>;
}

export type KmsErrorCode =
  "KEY_NOT_FOUND" | "UNWRAP_FAILED" | "INVALID_KEYRING" | "FORBIDDEN_IN_PRODUCTION";

export class KmsError extends Error {
  override readonly name = "KmsError";

  constructor(
    readonly code: KmsErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}
