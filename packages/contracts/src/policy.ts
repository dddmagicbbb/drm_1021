import { z } from "zod";
import { IsoDateTimeSchema } from "./common.js";

/** 문서 보안등급. 등급에 따라 인증 강도와 웹 전달 방식이 달라집니다. */
export const SecurityLevelSchema = z.enum(["NORMAL", "CONFIDENTIAL"]);
export type SecurityLevel = z.infer<typeof SecurityLevelSchema>;

export const POLICY_LIMITS = {
  /** 오프라인 유예 최대 시간 */
  maxOfflineGraceHours: 72,
  /** 수신자당 최대 기기 수 */
  maxDevices: 10,
} as const;

/**
 * 배포 건 단위 열람 정책 (PRD 7장)
 * 기간 판정은 반드시 서버 시각 기준으로 합니다.
 */
export const PolicySchema = z
  .object({
    validFrom: IsoDateTimeSchema,
    validUntil: IsoDateTimeSchema,
    allowWeb: z.boolean(),
    securityLevel: SecurityLevelSchema,
    offlineGraceHours: z.number().int().min(0).max(POLICY_LIMITS.maxOfflineGraceHours),
    /** null이면 무제한 */
    maxViews: z.number().int().positive().nullable(),
    maxDevices: z.number().int().min(1).max(POLICY_LIMITS.maxDevices),
  })
  .refine((p) => Date.parse(p.validFrom) < Date.parse(p.validUntil), {
    message: "validUntil은 validFrom보다 이후여야 합니다",
    path: ["validUntil"],
  });
export type Policy = z.infer<typeof PolicySchema>;

/** 정책 기본값 (기간 제외). 기간은 배포 시점 기준으로 계산합니다. */
export const DEFAULT_POLICY_VALUES = {
  allowWeb: true,
  securityLevel: "NORMAL",
  offlineGraceHours: 0,
  maxViews: null,
  maxDevices: 2,
} as const satisfies Omit<Policy, "validFrom" | "validUntil">;

/** 기본 열람 기간 (일) */
export const DEFAULT_VALIDITY_DAYS = 30;

/**
 * 열람 거부 사유 코드
 * 정책 엔진, 라이선스 API 오류 응답, 뷰어 안내 화면이 같은 코드를 사용합니다.
 */
export const DenyReasonSchema = z.enum([
  /** 배포 건의 수신자 목록에 없음 */
  "NOT_RECIPIENT",
  /** 열람 시작 전 */
  "NOT_YET_VALID",
  /** 열람 기간 만료 */
  "EXPIRED",
  /** 배포 건 전체 회수 */
  "DISTRIBUTION_REVOKED",
  /** 해당 문서 회수 */
  "DOCUMENT_REVOKED",
  /** 해당 수신자 회수 */
  "RECIPIENT_REVOKED",
  /** 문서가 아직 열람 가능한 상태가 아님 (변환 중, 실패 등) */
  "DOCUMENT_NOT_READY",
  /** 등록되지 않은 기기 */
  "DEVICE_NOT_REGISTERED",
  /** 등록 해제된 기기 */
  "DEVICE_REVOKED",
  /** 최대 열람 횟수 초과 */
  "VIEW_LIMIT_EXCEEDED",
]);
export type DenyReason = z.infer<typeof DenyReasonSchema>;

export type AccessDecision = { allowed: true } | { allowed: false; reason: DenyReason };
