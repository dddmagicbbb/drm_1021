import type { DistributionState, DocumentStatus } from "@drm/contracts";
import { EmailSchema } from "@drm/contracts";

export const STATE_LABELS: Record<DistributionState, string> = {
  SCHEDULED: "시작 전",
  ACTIVE: "열람 가능",
  EXPIRED: "만료",
  REVOKED: "회수됨",
};

export const DOCUMENT_STATUS_LABELS: Record<DocumentStatus, string> = {
  UPLOADED: "대기 중",
  CONVERTING: "변환·암호화 중",
  PACKAGED: "배포 완료",
  FAILED: "실패",
};

const DATE_TIME = new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "short" });
export const formatDateTime = (iso: string): string => DATE_TIME.format(new Date(iso));

export const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
};

/** ISO ↔ <input type="datetime-local"> 값 (사용자 로컬 시간대) */
export const toLocalInput = (iso: string): string => {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
export const fromLocalInput = (value: string): string => new Date(value).toISOString();

/**
 * 붙여넣거나 CSV에서 읽은 텍스트에서 수신자 이메일 추출
 * 줄바꿈·쉼표·세미콜론·공백으로 구분하며, 중복은 정규화 후 제거합니다.
 */
export const parseRecipients = (text: string): { valid: string[]; invalid: string[] } => {
  const tokens = text
    .split(/[\s,;]+/)
    .map((t) => t.replace(/^["'<]+|["'>]+$/g, ""))
    .filter((t) => t.length > 0);
  const valid = new Set<string>();
  const invalid: string[] = [];
  for (const token of tokens) {
    const parsed = EmailSchema.safeParse(token);
    if (parsed.success) valid.add(parsed.data);
    // CSV 머리글(예: email, 이름) 등 '@'가 없는 값은 무시합니다.
    else if (token.includes("@")) invalid.push(token);
  }
  return { valid: [...valid], invalid };
};
