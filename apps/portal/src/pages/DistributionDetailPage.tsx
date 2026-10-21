import type { Distribution } from "@drm/contracts";
import { useState } from "react";
import { ApiError } from "../api/client.js";
import { useApi } from "../api/context.js";
import { RecipientInput } from "../components/RecipientInput.js";
import {
  DOCUMENT_STATUS_LABELS,
  STATE_LABELS,
  formatBytes,
  formatDateTime,
  fromLocalInput,
  parseRecipients,
  toLocalInput,
} from "../format.js";
import { useAsync } from "../useAsync.js";

const POLL_MS = 3000;

/** 처리 중 문서가 있으면 주기적으로 다시 조회 */
const pollWhileProcessing = (d: Distribution | null) =>
  d?.documents.some((doc) => doc.status === "UPLOADED" || doc.status === "CONVERTING")
    ? POLL_MS
    : null;

/** 배포 관리 (FR-105~107) */
export const DistributionDetailPage = ({ id }: { id: string }) => {
  const api = useApi();
  const { data, error, loading, setData, reload } = useAsync(
    () => api.getDistribution(id),
    [api, id],
    pollWhileProcessing,
  );
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newRecipients, setNewRecipients] = useState("");
  const [newUntil, setNewUntil] = useState<string | null>(null);

  if (loading && !data) return <p className="muted">불러오는 중…</p>;
  if (error && !data) {
    return (
      <p className="error" role="alert">
        {error.message}
      </p>
    );
  }
  if (!data) return null;

  const revoked = data.state === "REVOKED";

  /** 변경 작업 공통 처리 */
  const run = async (action: () => Promise<Distribution | void>, confirmText?: string) => {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(true);
    setActionError(null);
    try {
      const updated = await action();
      if (updated) setData(updated);
      else await reload();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : "요청을 처리하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  };

  const extend = () =>
    run(() =>
      api.updateDistribution(id, {
        policy: { ...data.policy, validUntil: fromLocalInput(newUntil ?? "") },
      }),
    );

  const addRecipients = async () => {
    const { valid, invalid } = parseRecipients(newRecipients);
    if (invalid.length > 0 || valid.length === 0) {
      setActionError("추가할 수신자 주소를 확인하세요.");
      return;
    }
    await run(() => api.updateDistribution(id, { addRecipients: valid }));
    setNewRecipients("");
  };

  const uploadMore = (files: FileList | null) =>
    run(async () => {
      for (const file of files ?? []) await api.uploadDocument(id, file);
    });

  return (
    <>
      <section className="card">
        <div className="row" style={{ alignItems: "center" }}>
          <h2 style={{ margin: 0 }}>{data.title}</h2>
          <div style={{ flex: 0, whiteSpace: "nowrap" }}>
            <span className={`badge ${data.state}`}>{STATE_LABELS[data.state]}</span>
          </div>
        </div>
        <p className="muted">
          열람 기간: {formatDateTime(data.policy.validFrom)} ~{" "}
          {formatDateTime(data.policy.validUntil)} · 수신자당 기기 {data.policy.maxDevices}대
        </p>
        {actionError && (
          <p className="error" role="alert">
            {actionError}
          </p>
        )}
        {!revoked && (
          <div className="row">
            <div>
              <label htmlFor="newUntil">만료일 변경 (연장·단축)</label>
              <input
                id="newUntil"
                type="datetime-local"
                value={newUntil ?? toLocalInput(data.policy.validUntil)}
                onChange={(e) => setNewUntil(e.target.value)}
              />
            </div>
            <div style={{ flex: 0 }}>
              <button type="button" disabled={busy || !newUntil} onClick={() => void extend()}>
                기간 변경
              </button>
            </div>
            <div style={{ flex: 0 }}>
              <button
                type="button"
                className="danger"
                disabled={busy}
                onClick={() =>
                  void run(
                    () => api.revokeDistribution(id),
                    "배포 전체를 회수하면 모든 수신자가 즉시 열람할 수 없게 됩니다. 회수할까요?",
                  )
                }
              >
                배포 전체 회수
              </button>
            </div>
          </div>
        )}
      </section>

      <section className="card">
        <h2>문서</h2>
        <table>
          <thead>
            <tr>
              <th>파일명</th>
              <th>크기</th>
              <th>상태</th>
              <th>등록일</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.documents.map((doc) => (
              <tr key={doc.id}>
                <td>{doc.fileName}</td>
                <td>{formatBytes(doc.sourceSize)}</td>
                <td>
                  {doc.revokedAt ? (
                    <span className="badge REVOKED">회수됨</span>
                  ) : (
                    <span className={`badge ${doc.status}`}>
                      {DOCUMENT_STATUS_LABELS[doc.status]}
                    </span>
                  )}
                  {doc.failureReason && <div className="error">{doc.failureReason}</div>}
                </td>
                <td>{formatDateTime(doc.createdAt)}</td>
                <td>
                  {!doc.revokedAt && !revoked && (
                    <button
                      type="button"
                      className="danger"
                      disabled={busy}
                      onClick={() =>
                        void run(
                          async () => void (await api.revokeDocument(doc.id)),
                          `"${doc.fileName}" 문서를 회수할까요?`,
                        )
                      }
                    >
                      회수
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!revoked && (
          <>
            <label htmlFor="moreFiles">문서 추가</label>
            <input
              id="moreFiles"
              type="file"
              multiple
              accept=".pdf,.docx,.xlsx,.pptx"
              disabled={busy}
              onChange={(e) => void uploadMore(e.target.files)}
            />
          </>
        )}
      </section>

      <section className="card">
        <h2>수신자</h2>
        <table>
          <thead>
            <tr>
              <th>이메일</th>
              <th>등록일</th>
              <th>상태</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.recipients.map((r) => (
              <tr key={r.recipientId}>
                <td>{r.email}</td>
                <td>{formatDateTime(r.addedAt)}</td>
                <td>
                  {r.revokedAt ? (
                    <span className="badge REVOKED">회수됨</span>
                  ) : (
                    <span className="badge ACTIVE">열람 가능</span>
                  )}
                </td>
                <td>
                  {!r.revokedAt && !revoked && (
                    <button
                      type="button"
                      className="danger"
                      disabled={busy}
                      onClick={() =>
                        void run(
                          () => api.revokeRecipient(id, r.recipientId),
                          `${r.email}의 열람 권한을 회수할까요?`,
                        )
                      }
                    >
                      권한 회수
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!revoked && (
          <>
            <label htmlFor="addRecipients">수신자 추가</label>
            <RecipientInput id="addRecipients" value={newRecipients} onChange={setNewRecipients} />
            <div className="actions">
              <button type="button" disabled={busy} onClick={() => void addRecipients()}>
                수신자 추가
              </button>
            </div>
          </>
        )}
      </section>
    </>
  );
};
