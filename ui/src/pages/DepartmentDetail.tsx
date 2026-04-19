import React, { useEffect, useState } from "react";
import { api } from "../api";

export function DepartmentDetail({ name, navigate }: { name: string; navigate: (t: string) => void }) {
  const [d, setD] = useState<any>(null);
  const refresh = () => api(`/api/departments/${encodeURIComponent(name)}`).then(setD);
  useEffect(() => { refresh(); const t = setInterval(refresh, 5000); return () => clearInterval(t); }, [name]);

  const togglePause = async (relPath: string, paused: boolean) => {
    await api(`/api/cron/${encodeURIComponent(relPath)}/${paused ? "resume" : "pause"}`, { method: "POST" });
    refresh();
  };

  if (!d) return <div className="muted">Loading…</div>;

  return (
    <div className="col">
      <a onClick={() => navigate("/departments")} className="small">← departments</a>
      <h2>{d.name}</h2>
      <div className="small muted">{d.path}</div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Cron tasks</h3>
        {!d.cron?.length && <div className="muted small">No cron files.</div>}
        <table>
          <tbody>
            {d.cron?.map((t: any) => (
              <tr key={t.path}>
                <td><b>{t.name}</b></td>
                <td className="mono small">{t.schedule}</td>
                <td>{t.provider || "—"}</td>
                <td>{t.paused ? <span className="badge warn">paused</span> : <span className="badge ok">active</span>}</td>
                <td><a onClick={() => togglePause(t.relPath, !!t.paused)}>{t.paused ? "resume" : "pause"}</a></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Goals</h3>
        {!d.goals?.length && <div className="muted small">No goals.</div>}
        <table>
          <tbody>
            {d.goals?.map((g: any) => (
              <tr key={g.path}><td><b>{g.name}</b></td><td>{g.status}</td><td>{g.provider || "—"}</td></tr>
            ))}
          </tbody>
        </table>
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
                <td><span className="badge">{r.status}</span></td>
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
          <div key={b.id} className="small">{b.trigger} — queued {new Date(b.queued_at).toLocaleString()}</div>
        ))}
      </div>
    </div>
  );
}
