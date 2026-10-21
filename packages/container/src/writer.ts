/**
 * .drm 작성 (패키저)
 * 스펙: docs/specs/container.md
 */
import {
  CONTAINER_FORMAT_VERSION,
  CONTENT_ALG,
  ContainerHeaderSchema,
  DEFAULT_CHUNK_SIZE,
  type ContainerHeader,
  type PackagedContentType,
} from "@drm/contracts";
import {
  SIGNATURE_LENGTH,
  SIGNING_CONTEXT,
  StreamSealer,
  generateNoncePrefix,
  signWithContext,
} from "@drm/crypto";
import type { KeyObject } from "node:crypto";
import { ByteReader } from "./byte-reader.js";
import { ContainerError } from "./errors.js";
import {
  MAX_HEADER_LENGTH,
  assertChunkCount,
  chunkCount,
  chunkPlaintextLength,
  encodePrefix,
  prefixAad,
} from "./layout.js";

/** 헤더 서명자. 운영 환경에서는 KMS 서명으로 대체할 수 있도록 추상화합니다. */
export interface ContainerSigner {
  readonly kid: string;
  /** 도메인 분리 문자열을 포함해 prefix에 서명합니다. */
  sign(prefix: Uint8Array): Uint8Array | Promise<Uint8Array>;
}

/** 로컬 Ed25519 개인키 서명자 */
export const localContainerSigner = (kid: string, privateKey: KeyObject): ContainerSigner => ({
  kid,
  sign: (prefix) => signWithContext(privateKey, SIGNING_CONTEXT.containerHeader, prefix),
});

export interface WriteContainerOptions {
  docId: string;
  contentType: PackagedContentType;
  /** 평문 전체 크기. 실제 입력 크기와 다르면 SIZE_MISMATCH */
  plaintextSize: number;
  /** 문서별 CEK (32바이트). 호출자가 사용 후 폐기합니다. */
  cek: Uint8Array;
  signer: ContainerSigner;
  chunkSize?: number;
  /** 테스트용 시각 주입 */
  now?: Date;
}

/**
 * 평문 스트림을 .drm 바이트 스트림으로 암호화합니다.
 * 반환된 조각을 순서대로 이어 쓰면 .drm 파일이 됩니다.
 */
export async function* writeContainer(
  source: AsyncIterable<Uint8Array>,
  options: WriteContainerOptions,
): AsyncGenerator<Buffer> {
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const header: ContainerHeader = ContainerHeaderSchema.parse({
    v: CONTAINER_FORMAT_VERSION,
    docId: options.docId,
    alg: CONTENT_ALG,
    contentType: options.contentType,
    chunkSize,
    plaintextSize: options.plaintextSize,
    noncePrefix: generateNoncePrefix().toString("base64url"),
    kid: options.signer.kid,
    createdAt: (options.now ?? new Date()).toISOString(),
  } satisfies ContainerHeader);
  assertChunkCount(header.plaintextSize, chunkSize);

  const headerBytes = Buffer.from(JSON.stringify(header), "utf8");
  if (headerBytes.length > MAX_HEADER_LENGTH) {
    throw new ContainerError("INVALID_HEADER", "헤더가 최대 길이를 초과합니다");
  }
  const prefix = encodePrefix(headerBytes);
  const signature = Buffer.from(await options.signer.sign(prefix));
  if (signature.length !== SIGNATURE_LENGTH) {
    throw new ContainerError("INVALID_SIGNATURE", "서명 길이가 올바르지 않습니다");
  }
  const sigLen = Buffer.alloc(2);
  sigLen.writeUInt16BE(SIGNATURE_LENGTH);
  yield Buffer.concat([prefix, sigLen, signature]);

  const sealer = new StreamSealer(
    options.cek,
    Buffer.from(header.noncePrefix, "base64url"),
    prefixAad(prefix),
  );
  const reader = new ByteReader(source);
  const count = chunkCount(header.plaintextSize, chunkSize);
  for (let i = 0; i < count; i += 1) {
    const length = chunkPlaintextLength(i, header.plaintextSize, chunkSize);
    let plaintext: Buffer;
    try {
      plaintext = await reader.readExact(length);
    } catch (error) {
      throw new ContainerError("SIZE_MISMATCH", "입력 크기가 plaintextSize보다 작습니다", {
        cause: error,
      });
    }
    yield sealer.seal(plaintext, i === count - 1);
  }
  if (!(await reader.isAtEnd())) {
    throw new ContainerError("SIZE_MISMATCH", "입력 크기가 plaintextSize보다 큽니다");
  }
}
