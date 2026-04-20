import React, { useState } from "react";
import { api } from "../api";

export function GithubSetup({ onAdvance }: { onAdvance: () => Promise<void> }) {
  const [mode, setMode] = useState<"pat" | "deploy_key">("pat");
  const [token, setToken] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [login, setLogin] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = mode === "pat" ? { mode, token } : { mode, privateKey };
      const r = await api<{ login?: string }>("/api/onboarding/github/connect", {
        method: "POST",
        body: JSON.stringify(body),
      });
      setLogin(r.login || null);
      await onAdvance();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card col">
      <h2 style={{ marginTop: 0 }}>Connect GitHub</h2>
      <div className="row">
        <label><input type="radio" checked={mode === "pat"} onChange={() => setMode("pat")} /> PAT</label>
        <label><input type="radio" checked={mode === "deploy_key"} onChange={() => setMode("deploy_key")} /> Deploy key</label>
      </div>
      {mode === "pat" ? (
        <>
          <p className="small muted">
            Use a personal access token with <code>repo</code> scope to list repos and create a new AIOS repo.
          </p>
          <input type="password" placeholder="ghp_..." value={token} onChange={(e) => setToken(e.target.value)} />
        </>
      ) : (
        <>
          <p className="small muted">
            Paste a private SSH key for an existing repo deploy key. This mode is for attaching an existing repo.
          </p>
          <textarea value={privateKey} onChange={(e) => setPrivateKey(e.target.value)} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" />
        </>
      )}
      <div className="row">
        <button className="primary" onClick={connect} disabled={busy || (mode === "pat" ? !token : !privateKey)}>
          {busy ? "..." : "Connect"}
        </button>
        {login && <span className="badge ok">@{login}</span>}
      </div>
      {error && <div className="badge err">{error}</div>}
    </div>
  );
}
