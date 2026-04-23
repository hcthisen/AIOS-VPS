import React, { useEffect, useState } from "react";
import { api } from "../api";
import { Section } from "../components/Section";
import { Banner } from "../components/Banner";

export function GithubSetup({
  onAdvance,
  mode: pageMode = "onboarding",
  basePath = "/api/onboarding/github",
}: {
  onAdvance?: () => Promise<void>;
  mode?: "onboarding" | "settings";
  basePath?: string;
}) {
  const [mode, setMode] = useState<"pat" | "deploy_key">("pat");
  const [token, setToken] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [login, setLogin] = useState<string | null>(null);
  const [connected, setConnected] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const advance = onAdvance || (async () => {});

  const refresh = async () => {
    try {
      const status = await api(`${basePath}/status`);
      setConnected(status);
      setLogin(status?.username || null);
      if (status?.mode === "deploy_key") setMode("deploy_key");
    } catch {}
  };

  useEffect(() => {
    refresh();
  }, [basePath]);

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = mode === "pat" ? { mode, token } : { mode, privateKey };
      const r = await api<{ login?: string }>(`${basePath}/connect`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      setLogin(r.login || null);
      setToken("");
      setPrivateKey("");
      await refresh();
      if (pageMode === "onboarding") await advance();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      title="Connect GitHub"
      actions={connected?.connected
        ? <span className="badge ok">{connected.mode === "deploy_key" ? "deploy key connected" : `@${connected.username}`}</span>
        : <span className="badge">not connected</span>}
    >
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
          {busy ? "..." : connected?.connected ? "Reconnect" : "Connect"}
        </button>
        {login && <span className="badge ok">@{login}</span>}
      </div>
      {error && <Banner kind="err" onDismiss={() => setError(null)}>{error}</Banner>}
    </Section>
  );
}
