import type { RecipientDocument } from "@drm/contracts";
import { useCallback, useEffect, useState } from "react";
import type { ViewerError } from "../../shared/ipc.js";
import { useBridge } from "../bridge.js";

const DATE = new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "short" });

interface Props {
  email: string;
  onOpen: (doc: RecipientDocument) => void;
  onLogout: () => void;
  onError: (error: ViewerError) => void;
}

/** 열람 가능한 문서 목록 */
export const DocumentListScreen = ({ email, onOpen, onLogout, onError }: Props) => {
  const drm = useBridge();
  const [docs, setDocs] = useState<RecipientDocument[] | null>(null);

  const load = useCallback(async () => {
    const res = await drm.listDocuments();
    if (res.ok) setDocs(res.value);
    else onError(res.error);
  }, [drm, onError]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <main className="page">
      <header className="topbar">
        <strong>DRM 보안 뷰어</strong>
        <span className="muted-light">{email}</span>
        <span className="spacer" />
        <button type="button" onClick={() => void load()}>
          새로고침
        </button>
        <button type="button" onClick={onLogout}>
          로그아웃
        </button>
      </header>
      <section className="panel wide">
        <h2>받은 문서</h2>
        {docs === null && <p className="muted">불러오는 중…</p>}
        {docs?.length === 0 && <p className="muted">지금 열람할 수 있는 문서가 없습니다.</p>}
        {docs && docs.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>문서</th>
                <th>배포</th>
                <th>보낸 사람</th>
                <th>열람 기한</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {docs.map((d) => (
                <tr key={d.docId}>
                  <td>{d.fileName}</td>
                  <td>{d.distributionTitle}</td>
                  <td>
                    {d.sender.name} ({d.sender.email})
                  </td>
                  <td>{DATE.format(new Date(d.validUntil))}</td>
                  <td>
                    <button type="button" className="primary" onClick={() => onOpen(d)}>
                      열기
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
};
