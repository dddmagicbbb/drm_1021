import type { ViewerError } from "../../shared/ipc.js";

/** 거부 사유별 제목 (FR-308) */
const TITLES: Record<string, string> = {
  EXPIRED: "열람 기간이 만료되었습니다",
  NOT_YET_VALID: "아직 열람할 수 없습니다",
  DISTRIBUTION_REVOKED: "발신자가 배포를 회수했습니다",
  DOCUMENT_REVOKED: "발신자가 문서를 회수했습니다",
  RECIPIENT_REVOKED: "열람 권한이 회수되었습니다",
  NOT_RECIPIENT: "열람 대상이 아닙니다",
  DEVICE_NOT_REGISTERED: "등록되지 않은 기기입니다",
  DEVICE_REVOKED: "등록이 해제된 기기입니다",
  DEVICE_LIMIT_EXCEEDED: "등록 가능한 기기 수를 초과했습니다",
  VIEW_LIMIT_EXCEEDED: "최대 열람 횟수를 초과했습니다",
  DOCUMENT_NOT_READY: "문서를 준비 중입니다",
  NETWORK_ERROR: "서버에 연결할 수 없습니다",
  INVALID_SIGNATURE: "변조된 문서 파일입니다",
  LICENSE_INVALID: "라이선스를 확인할 수 없습니다",
};

export const ErrorScreen = ({ error, onBack }: { error: ViewerError; onBack: () => void }) => (
  <main className="center">
    <section className="panel" role="alert" aria-label="열람 불가">
      <h1>{TITLES[error.code] ?? "문서를 열 수 없습니다"}</h1>
      <p>{error.message}</p>
      {error.contact && (
        <p className="muted">
          문의: {error.contact.name} (<span className="selectable">{error.contact.email}</span>)
        </p>
      )}
      <div className="actions">
        <button type="button" className="primary" onClick={onBack}>
          문서 목록으로
        </button>
      </div>
    </section>
  </main>
);
