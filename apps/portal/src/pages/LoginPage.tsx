import { useState, type FormEvent } from "react";
import { ApiError } from "../api/client.js";
import { useApi } from "../api/context.js";
import { navigate } from "../router.js";

export const LoginPage = () => {
  const api = useApi();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(email, password);
      navigate({ name: "list" });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "로그인 중 오류가 발생했습니다.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card login" onSubmit={submit} aria-label="로그인">
      <h2>DRM 배포 포털 로그인</h2>
      <label htmlFor="email">이메일</label>
      <input
        id="email"
        type="email"
        autoComplete="username"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        required
      />
      <label htmlFor="password">비밀번호</label>
      <input
        id="password"
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        required
      />
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="actions">
        <button className="primary" type="submit" disabled={busy}>
          {busy ? "로그인 중…" : "로그인"}
        </button>
      </div>
    </form>
  );
};
