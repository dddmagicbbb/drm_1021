import { z } from "zod";
import { IdSchema, IsoDateTimeSchema } from "./common.js";

/** 업로드 가능한 원본 포맷 (1단계: PDF, Office) */
export const SourceFormatSchema = z.enum(["PDF", "DOCX", "XLSX", "PPTX"]);
export type SourceFormat = z.infer<typeof SourceFormatSchema>;

/** 패키징된 콘텐츠(중간 포맷)의 MIME 타입 */
export const PackagedContentTypeSchema = z.enum(["application/pdf", "model/gltf-binary"]);
export type PackagedContentType = z.infer<typeof PackagedContentTypeSchema>;

/**
 * 문서 상태
 * UPLOADED → CONVERTING → PACKAGED, 실패 시 FAILED. 회수는 별도 플래그(revokedAt)로 관리합니다.
 */
export const DocumentStatusSchema = z.enum(["UPLOADED", "CONVERTING", "PACKAGED", "FAILED"]);
export type DocumentStatus = z.infer<typeof DocumentStatusSchema>;

export const DocumentSchema = z.object({
  id: IdSchema,
  distributionId: IdSchema,
  fileName: z.string().min(1).max(255),
  sourceFormat: SourceFormatSchema,
  sourceSize: z.number().int().nonnegative(),
  status: DocumentStatusSchema,
  /** 실패 사유 (발신자 안내용, 민감정보 미포함) */
  failureReason: z.string().max(500).nullable(),
  revokedAt: IsoDateTimeSchema.nullable(),
  createdAt: IsoDateTimeSchema,
});
export type Document = z.infer<typeof DocumentSchema>;

/** 파일당 최대 업로드 크기 (FR-101) */
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;
