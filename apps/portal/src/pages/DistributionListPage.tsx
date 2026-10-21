import { useApi } from "../api/context.js";
import { STATE_LABELS, formatDateTime } from "../format.js";
import { hrefOf } from "../router.js";
import { useAsync } from "../useAsync.js";

export const DistributionListPage = () => {
  const api = useApi();
  const { data, error, loading } = useAsync(() => api.listDistributions(1, 50), [api]);

  return (
    <section className="card">
      <div className="row" style={{ alignItems: "center" }}>
        <h2 style={{ margin: 0 }}>배포 목록</h2>
        <div style={{ flex: 0 }}>
          <a href={hrefOf({ name: "new" })}>
            <button className="primary" type="button">
              새 배포
            </button>
          </a>
        </div>
      </div>
      {loading && <p className="muted">불러오는 중…</p>}
      {error && (
        <p className="error" role="alert">
          {error.message}
        </p>
      )}
      {data && data.length === 0 && <p className="muted">아직 배포한 문서가 없습니다.</p>}
      {data && data.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>제목</th>
              <th>상태</th>
              <th>열람 기간</th>
              <th>수신자</th>
              <th>문서</th>
              <th>등록일</th>
            </tr>
          </thead>
          <tbody>
            {data.map((d) => (
              <tr key={d.id}>
                <td>
                  <a href={hrefOf({ name: "detail", id: d.id })}>{d.title}</a>
                </td>
                <td>
                  <span className={`badge ${d.state}`}>{STATE_LABELS[d.state]}</span>
                </td>
                <td>
                  {formatDateTime(d.policy.validFrom)} ~ {formatDateTime(d.policy.validUntil)}
                </td>
                <td>{d.recipientCount}명</td>
                <td>{d.documentCount}건</td>
                <td>{formatDateTime(d.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
};
