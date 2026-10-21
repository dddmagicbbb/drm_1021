import { useState } from "react";
import { parseRecipients } from "../format.js";

interface Props {
  id: string;
  value: string;
  onChange: (value: string) => void;
}

/** 수신자 이메일 입력 (붙여넣기 + CSV 파일 불러오기, FR-102) */
export const RecipientInput = ({ id, value, onChange }: Props) => {
  const [csvError, setCsvError] = useState<string | null>(null);
  const { valid, invalid } = parseRecipients(value);

  const importCsv = async (file: File | undefined) => {
    if (!file) return;
    setCsvError(null);
    try {
      const text = await file.text();
      const imported = parseRecipients(text).valid;
      if (imported.length === 0) {
        setCsvError("CSV에서 이메일 주소를 찾지 못했습니다.");
        return;
      }
      onChange([value.trim(), ...imported].filter(Boolean).join("\n"));
    } catch {
      setCsvError("CSV 파일을 읽지 못했습니다.");
    }
  };

  return (
    <div>
      <textarea
        id={id}
        value={value}
        placeholder={"kim@customer.co.kr\nlee@customer.co.kr"}
        onChange={(e) => onChange(e.target.value)}
      />
      <div className="row" style={{ alignItems: "center" }}>
        <span className="muted">
          유효한 수신자 {valid.length}명
          {invalid.length > 0 && (
            <span className="error"> · 잘못된 주소: {invalid.join(", ")}</span>
          )}
        </span>
        <label className="muted" style={{ flex: 0, whiteSpace: "nowrap", margin: 0 }}>
          CSV 불러오기
          <input
            type="file"
            accept=".csv,text/csv,text/plain"
            aria-label="수신자 CSV 파일"
            style={{ display: "none" }}
            onChange={(e) => void importCsv(e.target.files?.[0])}
          />
        </label>
      </div>
      {csvError && <p className="error">{csvError}</p>}
    </div>
  );
};
