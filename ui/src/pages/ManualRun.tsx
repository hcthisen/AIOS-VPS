import React, { useEffect, useState } from "react";
import { api } from "../api";
import { Section } from "../components/Section";

export function ManualRunPage() {
  const [depts, setDepts] = useState<string[]>([]);
  const [dept, setDept] = useState("");
  const [provider, setProvider] = useState<"" | "claude-code" | "codex">("");
  const [prompt, setPrompt] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => { api("/api/departments").then((r: any) => setDepts(r.departments.map((d: any) => d.name))); }, []);

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
      <Section description="Fire a one-off prompt at a department. If the department is busy, the request is queued.">
        <label className="col">
          <span className="small muted">Department</span>
          <select value={dept} onChange={(e) => setDept(e.target.value)}>
            <option value="">-- select department --</option>
            {depts.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
        </label>
        <label className="col">
          <span className="small muted">Provider</span>
          <select value={provider} onChange={(e) => setProvider(e.target.value as any)}>
            <option value="">Default provider</option>
            <option value="claude-code">Claude Code</option>
            <option value="codex">Codex</option>
          </select>
        </label>
        <label className="col">
          <span className="small muted">Prompt</span>
          <textarea placeholder="What should this run do?" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
        </label>
        <div className="row">
          <button className="primary" onClick={fire} disabled={!dept || !prompt}>Fire</button>
          {msg && <span className="small muted">{msg}</span>}
        </div>
      </Section>
    </div>
  );
}
