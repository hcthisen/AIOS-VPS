import React, { useState } from "react";
import { api } from "../api";
import { Section } from "../components/Section";
import { Banner } from "../components/Banner";

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
    <Section title="Connect GitHub">
      <div className="row">
        <label className="row" style={{ gap: 6 }}>
          <input type="radio" checked={mode === "pat"} onChange={() => setMode("pat")} style={{ width: "auto", minHeight: 0 }} /> PAT
        </label>
        <label className="row" style={{ gap: 6 }}>
          <input type="radio" checked={mode === "deploy_key"} onChange={() => setMode("deploy_key")} style={{ width: "auto", minHeight: 0 }} /> Deploy key
        </label>
      </div>
      {mode === "pat" ? (
        <label className="col">
          <span className="small muted">Personal access token (<code>repo</code> scope)</span>
          <input type="password" placeholder="ghp_..." value={token} onChange={(e) => setToken(e.target.value)} />
        </label>
      ) : (
        <label className="col">
          <span className="small muted">Private SSH key for an existing repo deploy key</span>
          <textarea value={privateKey} onChange={(e) => setPrivateKey(e.target.value)} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" />
        </label>
      )}
      <div className="row">
        <button className="primary" onClick={connect} disabled={busy || (mode === "pat" ? !token : !privateKey)}>
          {busy ? "..." : "Connect"}
        </button>
        {login && <span className="badge ok">@{login}</span>}
      </div>
      {error && <Banner kind="err" onDismiss={() => setError(null)}>{error}</Banner>}
    </Section>
  );
}
