import React, { useState } from "react";
import { api } from "../api";

export function GithubSetup({ onAdvance }: { onAdvance: () => Promise<void> }) {
  const [token, setToken] = useState("");
  const [login, setLogin] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const connect = async () => {
    setBusy(true); setError(null);
    try {
      const r = await api<{ login: string }>("/api/onboarding/github/connect",
        { method: "POST", body: JSON.stringify({ mode: "pat", token }) });
      setLogin(r.login);
      await onAdvance();
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  };

  return (
    <div className="card col">
      <h2 style={{ marginTop: 0 }}>Connect GitHub</h2>
      <p className="small muted">
        Paste a personal access token with <code>repo</code> scope. v1 supports PAT; OAuth app support follows.
      </p>
      <input type="password" placeholder="ghp_…" value={token} onChange={(e) => setToken(e.target.value)} />
      <div className="row">
        <button className="primary" onClick={connect} disabled={busy || !token}>{busy ? "…" : "Connect"}</button>
        {login && <span className="badge ok">@{login}</span>}
      </div>
      {error && <div className="badge err">{error}</div>}
    </div>
  );
}
