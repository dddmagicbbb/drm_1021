import { useState, type FormEvent } from "react";
import type { AuthStatus } from "../../shared/ipc.js";
import { useBridge } from "../bridge.js";

/** 이메일 OTP 로그인 (FR-302) */
export const LoginScreen = ({ onLoggedIn }: { onLoggedIn: (status: AuthStatus) => void }) => {
  const drm = useBridge();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"email" | "code">("email");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const sendCode = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await drm.requestOtp(email);
    setBusy(false);
    if (!res.ok) return setError(res.error.message);
    setStep("code");
  };

  const verify = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await drm.verifyOtp(email, code);
    setBusy(false);
    if (!res.ok) return setError(res.error.message);
    onLoggedIn(res.value);
  };

  return (
    <main className="center">
      <form className="panel" onSubmit={step === "email" ? sendCode : verify} aria-label="로그인">
        <h1>DRM 보안 뷰어</h1>
        {step === "email" ? (
          <>
            <p className="muted">문서를 받은 이메일 주소로 로그인하세요.</p>
            <label htmlFor="email">이메일</label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoFocus
              required
            />
          </>
        ) : (
          <>
            <p className="muted">{email}로 보낸 인증 코드 6자리를 입력하세요. (5분간 유효)</p>
            <label htmlFor="code">인증 코드</label>
            <input
              id="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              autoFocus
              required
            />
          </>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="actions">
          {step === "code" && (
            <button type="button" onClick={() => setStep("email")} disabled={busy}>
              이메일 변경
            </button>
          )}
          <button className="primary" type="submit" disabled={busy}>
            {step === "email" ? "인증 코드 받기" : "로그인"}
          </button>
        </div>
      </form>
    </main>
  );
};
