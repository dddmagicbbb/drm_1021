/**
 * 열람 허용 판정 (정책 엔진)
 * 스펙: docs/specs/license-api.md §4
 *
 * 순수 함수입니다. 입력은 모두 서버가 DB에서 조회한 값이며, 판정 시각은 서버 시각입니다.
 * 처음 걸린 사유 하나만 반환합니다.
 */
import type { AccessDecision, DenyReason, DocumentStatus } from "@drm/contracts";

export interface AccessFacts {
  /** 배포 건의 수신자 연결. 없으면 수신자 목록에 없는 것 */
  membership: { revokedAt: Date | null } | null;
  distribution: {
    revokedAt: Date | null;
    validFrom: Date;
    validUntil: Date;
    maxViews: number | null;
  };
  document: {
    revokedAt: Date | null;
    status: DocumentStatus;
  };
}

export interface DeviceFacts {
  /** 요청한 기기. 없거나 다른 수신자의 기기면 null */
  device: { revokedAt: Date | null } | null;
  /** 해당 수신자에게 이 문서로 발급된 라이선스 수 */
  issuedCount: number;
}

/** 판정 대상 */
export type AccessPurpose =
  /** .drm 다운로드: 기기 조건(8~10) 제외 */
  | { kind: "download" }
  /** 라이선스 발급: 전체 조건 */
  | ({ kind: "license" } & DeviceFacts);

const deny = (reason: DenyReason): AccessDecision => ({ allowed: false, reason });

export const evaluateAccess = (
  facts: AccessFacts,
  purpose: AccessPurpose,
  now: Date,
): AccessDecision => {
  const { membership, distribution, document } = facts;
  const t = now.getTime();

  // 1~5: 수신자·회수·문서 상태 (회수를 기간보다 먼저 검사)
  if (!membership) return deny("NOT_RECIPIENT");
  if (distribution.revokedAt) return deny("DISTRIBUTION_REVOKED");
  if (membership.revokedAt) return deny("RECIPIENT_REVOKED");
  if (document.revokedAt) return deny("DOCUMENT_REVOKED");
  if (document.status !== "PACKAGED") return deny("DOCUMENT_NOT_READY");

  // 6~7: 기간 [validFrom, validUntil)
  if (t < distribution.validFrom.getTime()) return deny("NOT_YET_VALID");
  if (t >= distribution.validUntil.getTime()) return deny("EXPIRED");

  if (purpose.kind === "download") return { allowed: true };

  // 8~10: 기기·열람 횟수
  if (!purpose.device) return deny("DEVICE_NOT_REGISTERED");
  if (purpose.device.revokedAt) return deny("DEVICE_REVOKED");
  if (distribution.maxViews !== null && purpose.issuedCount >= distribution.maxViews) {
    return deny("VIEW_LIMIT_EXCEEDED");
  }
  return { allowed: true };
};

/** 수신자 안내 문구 (FR-308) */
export const DENY_MESSAGES: Record<DenyReason, string> = {
  NOT_RECIPIENT: "이 문서의 열람 대상이 아닙니다.",
  NOT_YET_VALID: "아직 열람 기간이 시작되지 않았습니다.",
  EXPIRED: "열람 기간이 만료되었습니다. 발신자에게 문의하세요.",
  DISTRIBUTION_REVOKED: "발신자가 이 배포를 회수했습니다.",
  DOCUMENT_REVOKED: "발신자가 이 문서를 회수했습니다.",
  RECIPIENT_REVOKED: "열람 권한이 회수되었습니다. 발신자에게 문의하세요.",
  DOCUMENT_NOT_READY: "문서를 준비 중입니다. 잠시 후 다시 시도하세요.",
  DEVICE_NOT_REGISTERED: "등록되지 않은 기기입니다. 다시 로그인해 기기를 등록하세요.",
  DEVICE_REVOKED: "등록이 해제된 기기입니다. 발신자에게 문의하세요.",
  VIEW_LIMIT_EXCEEDED: "최대 열람 횟수를 초과했습니다.",
};
