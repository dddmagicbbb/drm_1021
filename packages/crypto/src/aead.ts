/**
 * 청크 단위 AES-256-GCM 스트림 암호화 (STREAM 구성)
 * 스펙: docs/specs/container.md §3
 *
 * nonce_i = noncePrefix(7) ‖ uint32BE(i)(4) ‖ lastFlag(1)
 * 청크 인덱스와 마지막 플래그를 논스에 넣어 순서 변경·복제·절단을 탐지합니다.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { CryptoError } from "./errors.js";

export const CEK_LENGTH = 32;
export const NONCE_PREFIX_LENGTH = 7;
export const NONCE_LENGTH = 12;
export const TAG_LENGTH = 16;
/** 청크 인덱스는 uint32이므로 최대 청크 수는 2^32 - 1 */
export const MAX_CHUNK_COUNT = 0xffff_ffff;

const CIPHER = "aes-256-gcm";

/** 문서별 콘텐츠 암호화 키(CEK) 생성. 문서마다 반드시 새로 만듭니다. */
export const generateCek = (): Buffer => randomBytes(CEK_LENGTH);

/** 파일별 논스 접두사 생성 */
export const generateNoncePrefix = (): Buffer => randomBytes(NONCE_PREFIX_LENGTH);

/** 민감한 버퍼를 0으로 덮어씁니다. 사용이 끝난 CEK·평문에 호출합니다. */
export const wipe = (...buffers: (Buffer | Uint8Array | null | undefined)[]): void => {
  for (const buf of buffers) buf?.fill(0);
};

/** 청크 논스 계산 */
export const chunkNonce = (noncePrefix: Uint8Array, index: number, isLast: boolean): Buffer => {
  if (noncePrefix.length !== NONCE_PREFIX_LENGTH) {
    throw new CryptoError("INVALID_ARGUMENT", "noncePrefix 길이가 올바르지 않습니다");
  }
  if (!Number.isInteger(index) || index < 0 || index >= MAX_CHUNK_COUNT) {
    throw new CryptoError("INVALID_ARGUMENT", "청크 인덱스가 범위를 벗어났습니다");
  }
  const nonce = Buffer.alloc(NONCE_LENGTH);
  nonce.set(noncePrefix, 0);
  nonce.writeUInt32BE(index, NONCE_PREFIX_LENGTH);
  nonce[NONCE_LENGTH - 1] = isLast ? 0x01 : 0x00;
  return nonce;
};

const assertCek = (cek: Uint8Array): void => {
  if (cek.length !== CEK_LENGTH) {
    throw new CryptoError("INVALID_KEY", "CEK 길이가 올바르지 않습니다");
  }
};

/** 단일 청크 암호화. 반환값은 ciphertext ‖ tag */
export const sealChunk = (
  cek: Uint8Array,
  noncePrefix: Uint8Array,
  index: number,
  isLast: boolean,
  plaintext: Uint8Array,
  aad: Uint8Array,
): Buffer => {
  assertCek(cek);
  const cipher = createCipheriv(CIPHER, cek, chunkNonce(noncePrefix, index, isLast), {
    authTagLength: TAG_LENGTH,
  });
  cipher.setAAD(aad);
  const body = cipher.update(plaintext);
  const final = cipher.final();
  return Buffer.concat([body, final, cipher.getAuthTag()]);
};

/** 단일 청크 복호화. 태그 검증에 실패하면 평문을 반환하지 않고 예외를 던집니다. */
export const openChunk = (
  cek: Uint8Array,
  noncePrefix: Uint8Array,
  index: number,
  isLast: boolean,
  sealed: Uint8Array,
  aad: Uint8Array,
): Buffer => {
  assertCek(cek);
  if (sealed.length < TAG_LENGTH) {
    throw new CryptoError("DECRYPTION_FAILED", "청크가 너무 짧습니다");
  }
  const ciphertext = sealed.subarray(0, sealed.length - TAG_LENGTH);
  const tag = sealed.subarray(sealed.length - TAG_LENGTH);
  const decipher = createDecipheriv(CIPHER, cek, chunkNonce(noncePrefix, index, isLast), {
    authTagLength: TAG_LENGTH,
  });
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  const body = decipher.update(ciphertext);
  try {
    const final = decipher.final();
    return Buffer.concat([body, final]);
  } catch (error) {
    // 태그 검증 실패: 이미 계산된 평문 조각은 즉시 폐기합니다.
    wipe(body);
    throw new CryptoError("DECRYPTION_FAILED", "청크 복호화에 실패했습니다 (키 불일치 또는 변조)", {
      cause: error,
    });
  }
};

/**
 * 순차 청크 암호화기
 * 인덱스를 내부에서 관리하여 호출자가 인덱스를 잘못 지정하거나 논스를 재사용하는 실수를 막습니다.
 */
export class StreamSealer {
  private index = 0;
  private finished = false;

  constructor(
    private readonly cek: Uint8Array,
    private readonly noncePrefix: Uint8Array,
    private readonly aad: Uint8Array,
  ) {
    assertCek(cek);
    chunkNonce(noncePrefix, 0, false);
  }

  get chunkIndex(): number {
    return this.index;
  }

  get isFinished(): boolean {
    return this.finished;
  }

  seal(plaintext: Uint8Array, isLast: boolean): Buffer {
    if (this.finished) {
      throw new CryptoError("INVALID_STATE", "마지막 청크 이후에는 암호화할 수 없습니다");
    }
    const sealed = sealChunk(this.cek, this.noncePrefix, this.index, isLast, plaintext, this.aad);
    this.index += 1;
    this.finished = isLast;
    return sealed;
  }
}

/** 순차 청크 복호화기 */
export class StreamOpener {
  private index = 0;
  private finished = false;

  constructor(
    private readonly cek: Uint8Array,
    private readonly noncePrefix: Uint8Array,
    private readonly aad: Uint8Array,
  ) {
    assertCek(cek);
    chunkNonce(noncePrefix, 0, false);
  }

  get chunkIndex(): number {
    return this.index;
  }

  /** 마지막 청크까지 정상 복호화되었는지 여부. false인 상태로 스트림이 끝나면 절단입니다. */
  get isFinished(): boolean {
    return this.finished;
  }

  open(sealed: Uint8Array, isLast: boolean): Buffer {
    if (this.finished) {
      throw new CryptoError("INVALID_STATE", "마지막 청크 이후의 데이터가 있습니다");
    }
    const plaintext = openChunk(this.cek, this.noncePrefix, this.index, isLast, sealed, this.aad);
    this.index += 1;
    this.finished = isLast;
    return plaintext;
  }
}
