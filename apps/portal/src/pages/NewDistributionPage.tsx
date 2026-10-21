import {
  DEFAULT_POLICY_VALUES,
  DEFAULT_VALIDITY_DAYS,
  MAX_UPLOAD_BYTES,
  PolicySchema,
  type Policy,
} from "@drm/contracts";
import { useState, type FormEvent } from "react";
import { ApiError } from "../api/client.js";
import { useApi } from "../api/context.js";
import { RecipientInput } from "../components/RecipientInput.js";
import { formatBytes, fromLocalInput, parseRecipients, toLocalInput } from "../format.js";
import { navigate } from "../router.js";

const ACCEPT = ".pdf,.docx,.xlsx,.pptx";
const DAY_MS = 86_400_000;

interface UploadProgress {
  name: string;
  ratio: number;
  error?: string;
}

/** 배포 등록 (S1, FR-101~104) */
export const NewDistributionPage = () => {
  const api = useApi();
  const now = Date.now();
  const [title, setTitle] = useState("");
  const [recipientsText, setRecipientsText] = useState("");
  const [validFrom, setValidFrom] = useState(toLocalInput(new Date(now).toISOString()));
  const [validUntil, setValidUntil] = useState(
    toLocalInput(new Date(now + DEFAULT_VALIDITY_DAYS * DAY_MS).toISOString()),
  );
  const [allowWeb, setAllowWeb] = useState<boolean>(DEFAULT_POLICY_VALUES.allowWeb);
  const [maxDevices, setMaxDevices] = useState<number>(DEFAULT_POLICY_VALUES.maxDevices);
  const [files, setFiles] = useState<File[]>([]);
  const [progress, setProgress] = useState<UploadProgress[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const recipients = parseRecipients(recipientsText);
  const oversized = files.filter((f) => f.size > MAX_UPLOAD_BYTES);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (recipients.valid.length === 0) return setError("수신자를 1명 이상 입력하세요.");
    if (recipients.invalid.length > 0) return setError("잘못된 수신자 주소를 고쳐 주세요.");
    if (files.length === 0) return setError("배포할 문서를 1개 이상 선택하세요.");
    if (oversized.length > 0) return setError("2GB를 넘는 파일은 업로드할 수 없습니다.");

    const policy: Policy = {
      ...DEFAULT_POLICY_VALUES,
      validFrom: fromLocalInput(validFrom),
      validUntil: fromLocalInput(validUntil),
      allowWeb,
      maxDevices,
    };
    const checked = PolicySchema.safeParse(policy);
    if (!checked.success) {
      return setError(checked.error.issues[0]?.message ?? "열람 기간을 확인하세요.");
    }

    setBusy(true);
    try {
      const distribution = await api.createDistribution({
        title: title.trim(),
        recipients: recipients.valid,
        policy: checked.data,
      });
      setProgress(files.map((f) => ({ name: f.name, ratio: 0 })));
      // 파일마다 순서대로 업로드하고, 실패한 파일은 표시만 하고 계속 진행합니다.
      for (const [index, file] of files.entries()) {
        const update = (patch: Partial<UploadProgress>) =>
          setProgress((prev) => prev.map((p, i) => (i === index ? { ...p, ...patch } : p)));
        try {
          await api.uploadDocument(distribution.id, file, (ratio) => update({ ratio }));
          update({ ratio: 1 });
        } catch (err) {
          update({ error: err instanceof ApiError ? err.message : "업로드 실패" });
        }
      }
      navigate({ name: "detail", id: distribution.id });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "배포를 만들지 못했습니다.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card" onSubmit={submit} aria-label="새 배포">
      <h2>새 배포</h2>

      <label htmlFor="title">배포 제목</label>
      <input
        id="title"
        value={title}
        maxLength={200}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="예: A사 2차 설계 도면 송부"
        required
      />

      <label htmlFor="recipients">수신자 이메일 (한 줄에 하나, 쉼표·세미콜론 구분 가능)</label>
      <RecipientInput id="recipients" value={recipientsText} onChange={setRecipientsText} />

      <div className="row">
        <div>
          <label htmlFor="validFrom">열람 시작</label>
          <input
            id="validFrom"
            type="datetime-local"
            value={validFrom}
            onChange={(e) => setValidFrom(e.target.value)}
            required
          />
        </div>
        <div>
          <label htmlFor="validUntil">열람 만료</label>
          <input
            id="validUntil"
            type="datetime-local"
            value={validUntil}
            onChange={(e) => setValidUntil(e.target.value)}
            required
          />
        </div>
        <div>
          <label htmlFor="maxDevices">수신자당 기기 수</label>
          <input
            id="maxDevices"
            type="number"
            min={1}
            max={10}
            value={maxDevices}
            onChange={(e) => setMaxDevices(Number(e.target.value))}
          />
        </div>
      </div>

      <label>
        <input
          type="checkbox"
          checked={allowWeb}
          onChange={(e) => setAllowWeb(e.target.checked)}
          style={{ width: "auto", marginRight: 8 }}
        />
        웹 열람 허용 (웹 뷰어 제공 후 적용)
      </label>

      <label htmlFor="files">문서 (PDF, DOCX, XLSX, PPTX · 파일당 최대 2GB)</label>
      <input
        id="files"
        type="file"
        multiple
        accept={ACCEPT}
        onChange={(e) => setFiles([...(e.target.files ?? [])])}
      />
      {files.length > 0 && (
        <ul className="muted">
          {files.map((f, i) => (
            <li key={`${f.name}-${i}`}>
              {f.name} ({formatBytes(f.size)})
              {progress[i] && (
                <>
                  {" "}
                  <progress value={progress[i].ratio} max={1} aria-label={`${f.name} 업로드`} />
                  {progress[i].error && <span className="error"> {progress[i].error}</span>}
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="actions">
        <a href="#/">
          <button type="button">취소</button>
        </a>
        <button className="primary" type="submit" disabled={busy}>
          {busy ? "등록 중…" : "배포 등록"}
        </button>
      </div>
    </form>
  );
};
