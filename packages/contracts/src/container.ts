import { z } from "zod";
import { IdSchema, IsoDateTimeSchema, base64UrlBytes } from "./common.js";
import { PackagedContentTypeSchema } from "./document.js";

/** .drm 파일 매직 바이트 "DRM1" */
export const CONTAINER_MAGIC = "DRM1" as const;
export const CONTAINER_FORMAT_VERSION = 1 as const;
export const CONTENT_ALG = "AES-256-GCM-STREAM" as const;

/** 평문 청크 크기 기본값 (1 MiB) */
export const DEFAULT_CHUNK_SIZE = 1024 * 1024;
export const MIN_CHUNK_SIZE = 4 * 1024;
export const MAX_CHUNK_SIZE = 16 * 1024 * 1024;

/**
 * .drm 헤더 (평문 JSON, 서버 서명 대상)
 * 바이너리 레이아웃은 docs/specs/container.md 참고
 */
export const ContainerHeaderSchema = z.object({
  v: z.literal(CONTAINER_FORMAT_VERSION),
  docId: IdSchema,
  alg: z.literal(CONTENT_ALG),
  contentType: PackagedContentTypeSchema,
  chunkSize: z.number().int().min(MIN_CHUNK_SIZE).max(MAX_CHUNK_SIZE),
  /** 평문 전체 크기 (바이트). 청크 개수와 마지막 청크 판정에 사용합니다. */
  plaintextSize: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  /** 청크 논스 앞 7바이트 (파일마다 무작위) */
  noncePrefix: base64UrlBytes(7),
  /** 서명 키 식별자 */
  kid: z.string().min(1).max(64),
  createdAt: IsoDateTimeSchema,
});
export type ContainerHeader = z.infer<typeof ContainerHeaderSchema>;
