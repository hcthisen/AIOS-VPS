import React, { useState } from "react";
import { api } from "../api";
import { Banner } from "../components/Banner";

export function AuthPage({ onAuthed, firstRun, setupPhase }: { onAuthed: () => void; firstRun: boolean; setupPhase: string }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mode: "login" | "signup" = firstRun ? "signup" : "login";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      await api(`/api/auth/${mode}`, { method: "POST", body: JSON.stringify({ email, password }) });
      onAuthed();
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  };

  return (
    <div className="auth-wrap">
      <div className="auth-card card col">
        <h2 style={{ margin: 0 }}>
          {firstRun ? "Create first admin" : "Log in"}
        </h2>
        <p className="small muted">Setup phase: <code>{setupPhase}</code></p>
        <form onSubmit={submit} className="col">
          <input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          <input type="password" placeholder="Password (8+ chars)" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} />
          {error && <Banner kind="err" onDismiss={() => setError(null)}>{error}</Banner>}
          <button className="primary" disabled={busy} type="submit">
            {busy ? "…" : mode === "signup" ? "Create admin" : "Log in"}
          </button>
        </form>
      </div>
    </div>
  );
}
