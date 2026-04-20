import React, { useEffect, useState } from "react";
import { api } from "../api";

export function RepoSetup({ onAdvance }: { onAdvance: () => Promise<void> }) {
  const [github, setGithub] = useState<{ mode: "pat" | "deploy_key" | null }>({ mode: null });
  const [mode, setMode] = useState<"create" | "attach">("create");
  const [repos, setRepos] = useState<Array<{ fullName: string; private: boolean }>>([]);
  const [selected, setSelected] = useState("");
  const [manualFullName, setManualFullName] = useState("");
  const [name, setName] = useState("aios-repo");
  const [isPrivate, setIsPrivate] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ mode: "pat" | "deploy_key" | null }>("/api/onboarding/github/status")
      .then(setGithub)
      .catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    if (github.mode === "deploy_key") setMode("attach");
  }, [github.mode]);

  useEffect(() => {
    if (mode === "attach" && github.mode === "pat" && repos.length === 0) {
      api<{ repos: any[] }>("/api/onboarding/github/repos")
        .then((r) => setRepos(r.repos || []))
        .catch((e) => setError(e.message));
    }
  }, [mode, github.mode]);

  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      if (mode === "create") {
        await api("/api/onboarding/repo/create", { method: "POST", body: JSON.stringify({ name, private: isPrivate }) });
      } else {
        const fullName = github.mode === "pat" ? selected : manualFullName.trim();
        if (!fullName) throw new Error("select or enter a repo");
        await api("/api/onboarding/repo/attach", { method: "POST", body: JSON.stringify({ fullName }) });
      }
      await onAdvance();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card col">
      <h2 style={{ marginTop: 0 }}>Choose a repo</h2>
      <div className="row">
        <label><input type="radio" checked={mode === "create"} onChange={() => setMode("create")} disabled={github.mode === "deploy_key"} /> Create new</label>
        <label><input type="radio" checked={mode === "attach"} onChange={() => setMode("attach")} /> Attach existing</label>
      </div>
      {github.mode === "deploy_key" && (
        <div className="small muted">
          Deploy-key mode supports attaching an existing repo. Use PAT mode if you want AIOS to create a new repo for you.
        </div>
      )}
      {mode === "create" && (
        <div className="col">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="repo name" />
          <label className="small"><input type="checkbox" checked={isPrivate} onChange={(e) => setIsPrivate(e.target.checked)} /> private</label>
          <p className="small muted">A fresh repo will be created and scaffolded with <code>aios.yaml</code> and a sample department.</p>
        </div>
      )}
      {mode === "attach" && github.mode === "pat" && (
        <select value={selected} onChange={(e) => setSelected(e.target.value)}>
          <option value="">-- pick a repo --</option>
          {repos.map((r) => <option key={r.fullName} value={r.fullName}>{r.fullName}{r.private ? " (private)" : ""}</option>)}
        </select>
      )}
      {mode === "attach" && github.mode === "deploy_key" && (
        <input value={manualFullName} onChange={(e) => setManualFullName(e.target.value)} placeholder="owner/repo" />
      )}
      <div className="row">
        <button
          className="primary"
          onClick={go}
          disabled={busy || (mode === "attach" && github.mode === "pat" ? !selected : mode === "attach" && github.mode === "deploy_key" ? !manualFullName.trim() : false)}
        >
          {busy ? "..." : mode === "create" ? "Create and clone" : "Attach and validate"}
        </button>
      </div>
      {error && <div className="badge err">{error}</div>}
    </div>
  );
}
