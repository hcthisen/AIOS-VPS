import React, { useEffect, useState } from "react";
import { api } from "../api";
import { Section } from "../components/Section";

export function ManualRunPage() {
  const [scopes, setScopes] = useState<Array<{ name: string; label: string }>>([]);
  const [providers, setProviders] = useState<any>(null);
  const [dept, setDept] = useState("");
  const [provider, setProvider] = useState<"" | "claude-code" | "codex">("");
  const [prompt, setPrompt] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    api("/api/departments").then((r: any) => setScopes([
      { name: r.root?.name || "_root", label: r.root?.displayName || "Root" },
      ...r.departments.map((d: any) => ({ name: d.name, label: d.name })),
    ]));
    api("/api/controls/status").then((r: any) => setProviders(r.providers)).catch(() => {});
  }, []);

  const claudeAuthorized = !!providers?.claudeCode?.authorized;
  const codexAuthorized = !!providers?.codex?.authorized;
  const hasAuthorizedProvider = claudeAuthorized || codexAuthorized;
  const selectedProviderAuthorized = !provider
    || (provider === "claude-code" ? claudeAuthorized : codexAuthorized);

  const fire = async () => {
    setMsg(null);
    try {
      const r = await api<{ run: any; accepted: boolean }>("/api/manual-run", {
        method: "POST",
        body: JSON.stringify({ department: dept, prompt, provider: provider || undefined }),
      });
      setMsg(r.accepted ? `started ${r.run.id}` : `queued (${r.run.id})`);
      setPrompt("");
    } catch (e: any) { setMsg(e.message); }
  };

  return (
    <div className="col narrow">
      <h2>Manual run</h2>
      <Section description="Fire a one-off prompt at Root or a department. If the scope is busy, the request is queued.">
        <label className="col">
          <span className="small muted">Scope</span>
          <select value={dept} onChange={(e) => setDept(e.target.value)}>
            <option value="">-- select scope --</option>
            {scopes.map((scope) => <option key={scope.name} value={scope.name}>{scope.label}</option>)}
          </select>
        </label>
        <label className="col">
          <span className="small muted">Provider</span>
          <select value={provider} onChange={(e) => setProvider(e.target.value as any)}>
            <option value="">Default provider</option>
            <option value="claude-code" disabled={!claudeAuthorized}>Claude Code{claudeAuthorized ? "" : " (not connected)"}</option>
            <option value="codex" disabled={!codexAuthorized}>Codex{codexAuthorized ? "" : " (not connected)"}</option>
          </select>
        </label>
        {!hasAuthorizedProvider && <div className="small muted">Connect Claude Code or Codex in Settings before running agents.</div>}
        <label className="col">
          <span className="small muted">Prompt</span>
          <textarea placeholder="What should this run do?" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
        </label>
        <div className="row">
          <button className="primary" onClick={fire} disabled={!dept || !prompt || !hasAuthorizedProvider || !selectedProviderAuthorized}>Fire</button>
          {msg && <span className="small muted">{msg}</span>}
        </div>
      </Section>
    </div>
  );
}
