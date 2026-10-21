import { z } from "zod";
import { IdSchema, IsoDateTimeSchema } from "./common.js";

export const AuditEventTypeSchema = z.enum([
  // 발신자
  "SENDER_LOGIN_SUCCEEDED",
  "SENDER_LOGIN_FAILED",
  // 배포 관리
  "DISTRIBUTION_CREATED",
  "DISTRIBUTION_UPDATED",
  "DISTRIBUTION_REVOKED",
  "RECIPIENT_ADDED",
  "RECIPIENT_REMOVED",
  "RECIPIENT_REVOKED",
  // 문서
  "DOCUMENT_UPLOADED",
  "DOCUMENT_PACKAGED",
  "DOCUMENT_PACKAGING_FAILED",
  "DOCUMENT_REVOKED",
  // 수신자 인증·기기
  "OTP_REQUESTED",
  "OTP_VERIFIED",
  "OTP_FAILED",
  "DEVICE_REGISTERED",
  "DEVICE_REVOKED",
  // 열람
  "LICENSE_ISSUED",
  "LICENSE_DENIED",
  "DOCUMENT_DOWNLOADED",
  "DOCUMENT_DOWNLOAD_DENIED",
]);
export type AuditEventType = z.infer<typeof AuditEventTypeSchema>;

export const ActorTypeSchema = z.enum(["SENDER", "RECIPIENT", "SYSTEM"]);
export type ActorType = z.infer<typeof ActorTypeSchema>;

/**
 * 감사 이벤트 (append-only)
 * detail에는 키, OTP, 비밀번호, 문서 본문을 넣지 않습니다.
 */
export const AuditEventSchema = z.object({
  id: IdSchema,
  type: AuditEventTypeSchema,
  actorType: ActorTypeSchema,
  /** 행위자 식별자. 인증 전 실패 이벤트는 null */
  actorId: IdSchema.nullable(),
  distributionId: IdSchema.nullable(),
  documentId: IdSchema.nullable(),
  recipientId: IdSchema.nullable(),
  deviceId: IdSchema.nullable(),
  ip: z.string().max(45).nullable(),
  correlationId: z.string().max(64).nullable(),
  detail: z.record(z.string(), z.unknown()),
  occurredAt: IsoDateTimeSchema,
});
export type AuditEvent = z.infer<typeof AuditEventSchema>;
