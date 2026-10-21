/**
 * .drm 읽기 (뷰어·서버)
 * 스펙: docs/specs/container.md §5 리더 검증 순서
 */
import { ContainerHeaderSchema, type ContainerHeader } from "@drm/contracts";
import {
  CryptoError,
  SIGNATURE_LENGTH,
  SIGNING_CONTEXT,
  StreamOpener,
  TAG_LENGTH,
  verifyWithContext,
} from "@drm/crypto";
import type { KeyObject } from "node:crypto";
import { ByteReader, bufferSource } from "./byte-reader.js";
import { ContainerError } from "./errors.js";
import {
  FIXED_PREFIX_LENGTH,
  FORMAT_VERSION,
  MAGIC_BYTES,
  MAX_HEADER_LENGTH,
  chunkCount,
  chunkPlaintextLength,
  containerSize,
  prefixAad,
} from "./layout.js";

/** kid로 헤더 서명 검증용 Ed25519 공개키를 찾습니다. 없으면 undefined */
export type SigningKeyResolver = (kid: string) => KeyObject | Uint8Array | undefined;

export interface OpenedContainer {
  /** 서명 검증이 끝난 헤더 */
  readonly header: ContainerHeader;
  /**
   * 본문을 복호화하여 평문 조각을 순서대로 반환합니다.
   * 반복이 오류 없이 끝나야 문서 전체가 검증된 것입니다. (§5-7)
   * 한 번만 호출할 수 있습니다.
   */
  decrypt(cek: Uint8Array): AsyncGenerator<Buffer>;
}

const parseHeader = (headerBytes: Buffer): ContainerHeader => {
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(headerBytes));
  } catch (error) {
    throw new ContainerError("INVALID_HEADER", "헤더를 해석할 수 없습니다", { cause: error });
  }
  const result = ContainerHeaderSchema.safeParse(json);
  if (!result.success) {
    throw new ContainerError("INVALID_HEADER", "헤더 형식이 올바르지 않습니다", {
      cause: result.error,
    });
  }
  return result.data;
};

/**
 * .drm 스트림을 열고 헤더 서명까지 검증합니다.
 * @param totalSize 파일 크기를 알면 전달합니다. 헤더의 크기 공식과 비교합니다.
 */
export const openContainer = async (
  source: AsyncIterable<Uint8Array>,
  resolveSigningKey: SigningKeyResolver,
  totalSize?: number,
): Promise<OpenedContainer> => {
  const reader = new ByteReader(source);

  // 1. magic, version
  const fixed = await reader.readExact(FIXED_PREFIX_LENGTH);
  if (!fixed.subarray(0, 4).equals(MAGIC_BYTES)) {
    throw new ContainerError("INVALID_MAGIC", "DRM 파일이 아닙니다");
  }
  const version = fixed.readUInt16BE(4);
  if (version !== FORMAT_VERSION) {
    throw new ContainerError("UNSUPPORTED_VERSION", `지원하지 않는 포맷 버전입니다: ${version}`);
  }

  // 2. headerLen
  const headerLength = fixed.readUInt32BE(6);
  if (headerLength < 1 || headerLength > MAX_HEADER_LENGTH) {
    throw new ContainerError("INVALID_HEADER", "헤더 길이가 올바르지 않습니다");
  }

  // 3. 헤더 파싱 (원본 바이트 보존)
  const headerBytes = await reader.readExact(headerLength);
  const header = parseHeader(headerBytes);
  if (header.v !== version) {
    throw new ContainerError("INVALID_HEADER", "헤더 버전이 바이너리 버전과 다릅니다");
  }
  const prefix = Buffer.concat([fixed, headerBytes]);

  // 4. 서명 검증
  const sigBlock = await reader.readExact(2 + SIGNATURE_LENGTH);
  if (sigBlock.readUInt16BE(0) !== SIGNATURE_LENGTH) {
    throw new ContainerError("INVALID_SIGNATURE", "서명 길이가 올바르지 않습니다");
  }
  const publicKey = resolveSigningKey(header.kid);
  if (!publicKey) {
    throw new ContainerError("UNKNOWN_KEY_ID", "알 수 없는 서명 키입니다");
  }
  if (
    !verifyWithContext(publicKey, SIGNING_CONTEXT.containerHeader, prefix, sigBlock.subarray(2))
  ) {
    throw new ContainerError("INVALID_SIGNATURE", "헤더 서명 검증에 실패했습니다");
  }

  // 5. 전체 크기 비교
  if (totalSize !== undefined) {
    const expected = containerSize(headerLength, header.plaintextSize, header.chunkSize);
    if (totalSize < expected) throw new ContainerError("TRUNCATED", "파일이 예상보다 짧습니다");
    if (totalSize > expected) throw new ContainerError("TRAILING_DATA", "파일이 예상보다 깁니다");
  }

  let consumed = false;
  async function* decrypt(cek: Uint8Array): AsyncGenerator<Buffer> {
    if (consumed) throw new Error("decrypt는 한 번만 호출할 수 있습니다");
    consumed = true;

    // 6. 청크 순차 복호화
    const opener = new StreamOpener(
      cek,
      Buffer.from(header.noncePrefix, "base64url"),
      prefixAad(prefix),
    );
    const count = chunkCount(header.plaintextSize, header.chunkSize);
    for (let i = 0; i < count; i += 1) {
      const sealedLength =
        chunkPlaintextLength(i, header.plaintextSize, header.chunkSize) + TAG_LENGTH;
      const sealed = await reader.readExact(sealedLength);
      try {
        yield opener.open(sealed, i === count - 1);
      } catch (error) {
        if (error instanceof CryptoError) {
          throw new ContainerError("DECRYPTION_FAILED", "본문 복호화에 실패했습니다", {
            cause: error,
          });
        }
        throw error;
      }
    }

    // 7. 꼬리 데이터 검사
    if (!(await reader.isAtEnd())) {
      throw new ContainerError("TRAILING_DATA", "마지막 청크 이후에 데이터가 있습니다");
    }
  }

  return { header, decrypt };
};

/** 메모리에 있는 .drm의 헤더만 검증·조회합니다. (라이선스 요청 전 docId 확인용) */
export const inspectContainer = async (
  data: Uint8Array,
  resolveSigningKey: SigningKeyResolver,
): Promise<ContainerHeader> =>
  (await openContainer(bufferSource(data), resolveSigningKey, data.length)).header;

/**
 * 메모리에 있는 .drm 전체를 복호화합니다.
 * 모든 청크와 꼬리 검사가 통과한 경우에만 평문을 반환합니다.
 */
export const decryptContainer = async (
  data: Uint8Array,
  cek: Uint8Array,
  resolveSigningKey: SigningKeyResolver,
): Promise<{ header: ContainerHeader; plaintext: Buffer }> => {
  const opened = await openContainer(bufferSource(data), resolveSigningKey, data.length);
  const plaintext = Buffer.alloc(opened.header.plaintextSize);
  let offset = 0;
  try {
    for await (const piece of opened.decrypt(cek)) {
      piece.copy(plaintext, offset);
      offset += piece.length;
      piece.fill(0);
    }
  } catch (error) {
    // 검증되지 않은 평문은 반환하지 않고 폐기합니다.
    plaintext.fill(0);
    throw error;
  }
  return { header: opened.header, plaintext };
};
