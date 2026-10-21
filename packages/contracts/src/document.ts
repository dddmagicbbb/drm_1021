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

/** 수신자가 열람 가능한 문서 (뷰어 문서 목록) */
export const RecipientDocumentSchema = z.object({
  docId: IdSchema,
  fileName: z.string(),
  contentType: PackagedContentTypeSchema,
  distributionTitle: z.string(),
  validUntil: IsoDateTimeSchema,
  sender: z.object({ name: z.string(), email: z.string() }),
});
export type RecipientDocument = z.infer<typeof RecipientDocumentSchema>;

/**
 * 뷰어가 열 수 있는 콘텐츠 최대 크기 (1단계: 메모리 전체 복호화)
 * 이보다 큰 문서는 패키징 단계에서 거부해 수신자가 열지 못하는 배포를 막습니다.
 */
export const MAX_VIEWABLE_BYTES = 512 * 1024 * 1024;
