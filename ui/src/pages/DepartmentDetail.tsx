import React, { useEffect, useState } from "react";
import { api } from "../api";

export function DepartmentDetail({ name, navigate }: { name: string; navigate: (t: string) => void }) {
  const [d, setD] = useState<any>(null);
  const [envText, setEnvText] = useState("");
  const [selectedCron, setSelectedCron] = useState<string>("");
  const [cronText, setCronText] = useState("");
  const [selectedGoal, setSelectedGoal] = useState<string>("");
  const [goalText, setGoalText] = useState("");
  const [newCron, setNewCron] = useState({ name: "", schedule: "* * * * *", provider: "", prompt: "" });
  const [newGoal, setNewGoal] = useState({ name: "", status: "active", provider: "", prompt: "" });
  const [msg, setMsg] = useState<string | null>(null);

  const refresh = () => api(`/api/departments/${encodeURIComponent(name)}`).then(setD);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [name]);

  useEffect(() => {
    loadFile(`${name}/.env`, setEnvText, true);
  }, [name]);

  useEffect(() => {
    if (!d?.cron?.length) {
      setSelectedCron("");
      setCronText("");
      return;
    }
    const exists = d.cron.some((t: any) => t.relPath === selectedCron);
    const next = exists ? selectedCron : d.cron[0].relPath;
    setSelectedCron(next);
  }, [d?.cron?.length, selectedCron]);

  useEffect(() => {
    if (!selectedCron) return;
    loadFile(selectedCron, setCronText);
  }, [selectedCron]);

  useEffect(() => {
    if (!d?.goals?.length) {
      setSelectedGoal("");
      setGoalText("");
      return;
    }
    const exists = d.goals.some((g: any) => g.relPath === selectedGoal);
    const next = exists ? selectedGoal : d.goals[0].relPath;
    setSelectedGoal(next);
  }, [d?.goals?.length, selectedGoal]);

  useEffect(() => {
    if (!selectedGoal) return;
    loadFile(selectedGoal, setGoalText);
  }, [selectedGoal]);

  const togglePause = async (relPath: string, paused: boolean) => {
    await api(`/api/cron/${encodeURIComponent(relPath)}/${paused ? "resume" : "pause"}`, { method: "POST" });
    refresh();
  };

  const saveTextFile = async (relPath: string, text: string) => {
    setMsg(null);
    try {
      await api(fileUrl(relPath), {
        method: "PUT",
        headers: { "Content-Type": "text/plain" },
        body: text,
      });
      setMsg(`saved ${relPath}`);
      refresh();
    } catch (e: any) {
      setMsg(e.message);
    }
  };

  const createCron = async () => {
    const fileName = newCron.name.trim().replace(/[^\w.-]+/g, "-");
    if (!fileName || !newCron.prompt.trim()) {
      setMsg("cron name and prompt are required");
      return;
    }
    const relPath = `${name}/cron/${fileName}.md`;
    const providerLine = newCron.provider ? `provider: ${newCron.provider}\n` : "";
    const body = `---\nschedule: "${newCron.schedule}"\n${providerLine}---\n\n${newCron.prompt.trim()}\n`;
    await saveTextFile(relPath, body);
    setSelectedCron(relPath);
    setNewCron({ name: "", schedule: "* * * * *", provider: "", prompt: "" });
  };

  const createGoal = async () => {
    const fileName = newGoal.name.trim().replace(/[^\w.-]+/g, "-");
    if (!fileName || !newGoal.prompt.trim()) {
      setMsg("goal name and prompt are required");
      return;
    }
    const relPath = `${name}/goals/${fileName}.md`;
    const providerLine = newGoal.provider ? `provider: ${newGoal.provider}\n` : "";
    const body = `---\nstatus: ${newGoal.status}\n${providerLine}state: {}\n---\n\n${newGoal.prompt.trim()}\n`;
    await saveTextFile(relPath, body);
    setSelectedGoal(relPath);
    setNewGoal({ name: "", status: "active", provider: "", prompt: "" });
  };

  if (!d) return <div className="muted">Loading...</div>;

  return (
    <div className="col">
      <a onClick={() => navigate("/departments")} className="small">{"<-"} departments</a>
      <h2>{d.name}</h2>
      <div className="small muted">{d.path}</div>
      {msg && <div className={msg.startsWith("saved") ? "badge ok" : "badge err"}>{msg}</div>}

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Cron tasks</h3>
        {!d.cron?.length && <div className="muted small">No cron files.</div>}
        <table>
          <tbody>
            {d.cron?.map((t: any) => (
              <tr key={t.path}>
                <td><b>{t.name}</b></td>
                <td className="mono small">{t.schedule}</td>
                <td>{t.provider || "-"}</td>
                <td>{t.paused ? <span className="badge warn">paused</span> : <span className="badge ok">active</span>}</td>
                <td><a onClick={() => setSelectedCron(t.relPath)}>edit</a></td>
                <td><a onClick={() => togglePause(t.relPath, !!t.paused)}>{t.paused ? "resume" : "pause"}</a></td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="col" style={{ marginTop: 12 }}>
          <div className="row">
            <select value={selectedCron} onChange={(e) => setSelectedCron(e.target.value)}>
              <option value="">-- pick a cron file --</option>
              {d.cron?.map((t: any) => <option key={t.relPath} value={t.relPath}>{t.relPath}</option>)}
            </select>
            <button onClick={() => selectedCron && saveTextFile(selectedCron, cronText)} disabled={!selectedCron}>Save cron</button>
          </div>
          <textarea value={cronText} onChange={(e) => setCronText(e.target.value)} placeholder="Cron markdown" />
        </div>
        <div className="col" style={{ marginTop: 12 }}>
          <h4 style={{ margin: 0 }}>Create cron task</h4>
          <input value={newCron.name} onChange={(e) => setNewCron({ ...newCron, name: e.target.value })} placeholder="task name" />
          <input value={newCron.schedule} onChange={(e) => setNewCron({ ...newCron, schedule: e.target.value })} placeholder="schedule" />
          <select value={newCron.provider} onChange={(e) => setNewCron({ ...newCron, provider: e.target.value })}>
            <option value="">default provider</option>
            <option value="claude-code">Claude Code</option>
            <option value="codex">Codex</option>
          </select>
          <textarea value={newCron.prompt} onChange={(e) => setNewCron({ ...newCron, prompt: e.target.value })} placeholder="Prompt" />
          <button className="primary" onClick={createCron}>Create cron task</button>
        </div>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Goals</h3>
        {!d.goals?.length && <div className="muted small">No goals.</div>}
        <table>
          <tbody>
            {d.goals?.map((g: any) => (
              <tr key={g.path}>
                <td><b>{g.name}</b></td>
                <td>{g.status}</td>
                <td>{g.provider || "-"}</td>
                <td><a onClick={() => setSelectedGoal(g.relPath)}>edit</a></td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="col" style={{ marginTop: 12 }}>
          <div className="row">
            <select value={selectedGoal} onChange={(e) => setSelectedGoal(e.target.value)}>
              <option value="">-- pick a goal file --</option>
              {d.goals?.map((g: any) => <option key={g.relPath} value={g.relPath}>{g.relPath}</option>)}
            </select>
            <button onClick={() => selectedGoal && saveTextFile(selectedGoal, goalText)} disabled={!selectedGoal}>Save goal</button>
          </div>
          <textarea value={goalText} onChange={(e) => setGoalText(e.target.value)} placeholder="Goal markdown" />
        </div>
        <div className="col" style={{ marginTop: 12 }}>
          <h4 style={{ margin: 0 }}>Create goal</h4>
          <input value={newGoal.name} onChange={(e) => setNewGoal({ ...newGoal, name: e.target.value })} placeholder="goal name" />
          <select value={newGoal.status} onChange={(e) => setNewGoal({ ...newGoal, status: e.target.value })}>
            <option value="active">active</option>
            <option value="paused">paused</option>
            <option value="complete">complete</option>
          </select>
          <select value={newGoal.provider} onChange={(e) => setNewGoal({ ...newGoal, provider: e.target.value })}>
            <option value="">default provider</option>
            <option value="claude-code">Claude Code</option>
            <option value="codex">Codex</option>
          </select>
          <textarea value={newGoal.prompt} onChange={(e) => setNewGoal({ ...newGoal, prompt: e.target.value })} placeholder="Goal prompt" />
          <button className="primary" onClick={createGoal}>Create goal</button>
        </div>
      </div>

      <div className="card col">
        <h3 style={{ marginTop: 0 }}>Environment</h3>
        <textarea value={envText} onChange={(e) => setEnvText(e.target.value)} placeholder="KEY=value" />
        <div className="row">
          <button onClick={() => saveTextFile(`${name}/.env`, envText)}>Save .env</button>
        </div>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Recent runs</h3>
        {!d.runs?.length && <div className="muted small">No runs yet.</div>}
        <table>
          <tbody>
            {d.runs?.map((r: any) => (
              <tr key={r.id}>
                <td className="mono small">{new Date(r.started_at).toLocaleString()}</td>
                <td>{r.trigger}</td>
                <td><span className={`badge ${r.status === "succeeded" ? "ok" : r.status === "running" ? "" : "err"}`}>{r.status}</span></td>
                <td><a onClick={() => navigate(`/runs/${r.id}`)}>view</a></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Backlog</h3>
        {!d.backlog?.length && <div className="muted small">Empty.</div>}
        {d.backlog?.map((b: any) => (
          <div key={b.id} className="small">{b.trigger} - queued {new Date(b.queued_at).toLocaleString()}</div>
        ))}
      </div>
    </div>
  );
}

async function loadFile(relPath: string, setter: (text: string) => void, allowMissing = false) {
  try {
    setter(await api<string>(fileUrl(relPath)));
  } catch (e: any) {
    if (allowMissing) setter("");
  }
}

function fileUrl(relPath: string) {
  return `/api/files/${relPath.split("/").map(encodeURIComponent).join("/")}`;
}
