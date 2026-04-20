import React, { useEffect, useRef, useState } from "react";
import { api } from "../api";

export function ProviderAuth({ onAdvance }: { onAdvance: () => Promise<void> }) {
  const [status, setStatus] = useState<any>(null);
  const timer = useRef<number | null>(null);

  const refresh = async () => {
    try { setStatus(await api("/api/provider-auth/status")); } catch {}
  };

  useEffect(() => {
    refresh();
    timer.current = window.setInterval(refresh, 2000);
    return () => { if (timer.current) window.clearInterval(timer.current); };
  }, []);

  const skip = async () => { await api("/api/provider-auth/skip", { method: "POST" }); await onAdvance(); };

  return (
    <div className="col">
      <div className="grid-2">
        <ClaudeCard status={status} onChange={refresh} />
        <CodexCard status={status} onChange={refresh} />
      </div>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <a className="small muted" onClick={skip}>skip — set up a provider later</a>
        <button className="primary" onClick={onAdvance}>Continue</button>
      </div>
    </div>
  );
}

function ClaudeCard({ status, onChange }: { status: any; onChange: () => void }) {
  const s = status?.anthropic;
  const [starting, setStarting] = useState(false);
  const [session, setSession] = useState<any>(s?.session || null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { if (s?.session) setSession(s.session); }, [s?.session?.id]);

  const start = async () => {
    setStarting(true); setError(null);
    try {
      const r = await api("/api/provider-auth/anthropic/start", { method: "POST" });
      setSession(r);
      window.open(r.verificationUrl, "_blank");
    } catch (e: any) { setError(e.message); }
    finally { setStarting(false); }
  };

  const submit = async () => {
    setError(null);
    try {
      const r = await api("/api/provider-auth/anthropic/submit", { method: "POST", body: JSON.stringify({ code }) });
      if (r.status !== "complete") setError(r.error || "submit failed");
      setSession({ ...session, status: r.status });
      onChange();
    } catch (e: any) { setError(e.message); }
  };

  const cancel = async () => { await api("/api/provider-auth/anthropic/cancel", { method: "POST" }); setSession(null); onChange(); };

  const detected = !!s?.detected;

  return (
    <div className="card col">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h3 style={{ margin: 0 }}>Claude Code</h3>
        {detected ? <span className="badge ok">connected</span> : <span className="badge">not connected</span>}
      </div>
      {s?.snapshot?.email && <div className="small muted">{s.snapshot.email} · {s.snapshot.subscriptionType}</div>}
      {!detected && !session && <button onClick={start} disabled={starting}>{starting ? "…" : "Connect Claude Code"}</button>}
      {session?.status === "waiting" && (
        <div className="col">
          <a href={session.verificationUrl} target="_blank">Open Claude sign-in</a>
          <p className="small muted">After approving, Claude redirects to a page showing <code>code#state</code>. Paste the whole thing here.</p>
          <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="code#state or full redirect URL" />
          <div className="row">
            <button className="primary" onClick={submit} disabled={!code}>Submit</button>
            <a className="small muted" onClick={cancel}>cancel</a>
          </div>
        </div>
      )}
      {error && <div className="badge err">{error}</div>}
    </div>
  );
}

function CodexCard({ status, onChange }: { status: any; onChange: () => void }) {
  const s = status?.openai;
  const [starting, setStarting] = useState(false);
  const [session, setSession] = useState<any>(s?.session || null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { setSession(s?.session || null); }, [s?.session?.id, s?.session?.status]);

  const start = async () => {
    setStarting(true); setError(null);
    try { setSession(await api("/api/provider-auth/openai/start", { method: "POST" })); }
    catch (e: any) { setError(e.message); }
    finally { setStarting(false); }
  };

  const cancel = async () => { await api("/api/provider-auth/openai/cancel", { method: "POST" }); setSession(null); onChange(); };

  const detected = !!s?.detected;

  return (
    <div className="card col">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h3 style={{ margin: 0 }}>Codex</h3>
        {detected ? <span className="badge ok">connected</span> : <span className="badge">not connected</span>}
      </div>
      {!detected && !session && <button onClick={start} disabled={starting}>{starting ? "…" : "Connect Codex"}</button>}
      {session?.status === "waiting" && (
        <div className="col">
          {session.verificationUrl
            ? <a href={session.verificationUrl} target="_blank">Open OpenAI device sign-in</a>
            : <div className="small muted">Spawning codex…</div>}
          {session.userCode && <div className="kbd mono">{session.userCode}</div>}
          <div className="row">
            <a className="small muted" onClick={cancel}>cancel</a>
          </div>
        </div>
      )}
      {session?.status === "failed" && <div className="badge err">{session.error || "failed"}</div>}
      {error && <div className="badge err">{error}</div>}
    </div>
  );
}
