/**
 * .drm 바이너리 레이아웃 상수와 계산
 * 스펙: docs/specs/container.md §2, §3.1
 */
import { CONTAINER_FORMAT_VERSION, CONTAINER_MAGIC } from "@drm/contracts";
import { MAX_CHUNK_COUNT, TAG_LENGTH } from "@drm/crypto";
import { SIGNATURE_LENGTH } from "@drm/crypto";
import { createHash } from "node:crypto";

export const MAGIC_BYTES = Buffer.from(CONTAINER_MAGIC, "ascii");
export const FORMAT_VERSION = CONTAINER_FORMAT_VERSION;
/** magic(4) + version(2) + headerLen(4) */
export const FIXED_PREFIX_LENGTH = 10;
export const MAX_HEADER_LENGTH = 64 * 1024;
/** sigLen(2) + signature(64) */
export const SIGNATURE_BLOCK_LENGTH = 2 + SIGNATURE_LENGTH;

/** 청크 개수: max(1, ceil(plaintextSize / chunkSize)) */
export const chunkCount = (plaintextSize: number, chunkSize: number): number =>
  Math.max(1, Math.ceil(plaintextSize / chunkSize));

/** i번째 청크의 평문 길이 */
export const chunkPlaintextLength = (
  index: number,
  plaintextSize: number,
  chunkSize: number,
): number => {
  const count = chunkCount(plaintextSize, chunkSize);
  return index < count - 1 ? chunkSize : plaintextSize - (count - 1) * chunkSize;
};

/** .drm 전체 크기 = 76 + H + plaintextSize + 16 × N */
export const containerSize = (
  headerLength: number,
  plaintextSize: number,
  chunkSize: number,
): number =>
  FIXED_PREFIX_LENGTH +
  headerLength +
  SIGNATURE_BLOCK_LENGTH +
  plaintextSize +
  TAG_LENGTH * chunkCount(plaintextSize, chunkSize);

export const assertChunkCount = (plaintextSize: number, chunkSize: number): void => {
  if (chunkCount(plaintextSize, chunkSize) > MAX_CHUNK_COUNT) {
    throw new RangeError("청크 개수가 최대치를 초과합니다");
  }
};

/** prefix = magic ‖ version ‖ headerLen ‖ header */
export const encodePrefix = (headerBytes: Uint8Array): Buffer => {
  const fixed = Buffer.alloc(FIXED_PREFIX_LENGTH);
  MAGIC_BYTES.copy(fixed, 0);
  fixed.writeUInt16BE(FORMAT_VERSION, 4);
  fixed.writeUInt32BE(headerBytes.length, 6);
  return Buffer.concat([fixed, headerBytes]);
};

/** 청크 AAD = SHA-256(prefix) */
export const prefixAad = (prefix: Uint8Array): Buffer =>
  createHash("sha256").update(prefix).digest();
