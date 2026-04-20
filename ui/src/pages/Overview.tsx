import React, { useEffect, useState } from "react";
import { api } from "../api";

export function Overview({ navigate }: { navigate: (t: string) => void }) {
  const [data, setData] = useState<{ runs: any[]; claims: any[] } | null>(null);
  const [controls, setControls] = useState<any>(null);

  const refresh = async () => {
    try {
      setData(await api("/api/runs/active"));
      setControls(await api("/api/controls/status"));
    } catch {}
  };

  useEffect(() => { refresh(); const t = setInterval(refresh, 3000); return () => clearInterval(t); }, []);

  const togglePause = async () => {
    if (controls?.paused) await api("/api/controls/resume", { method: "POST" });
    else await api("/api/controls/pause", { method: "POST" });
    refresh();
  };

  return (
    <div className="col">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h2 style={{ margin: 0 }}>Overview</h2>
        <div className="row">
          <span className={`badge ${controls?.paused ? "warn" : "ok"}`}>
            {controls?.paused ? "paused" : "running"}
          </span>
          <button className={controls?.paused ? "primary" : "danger"} onClick={togglePause}>
            {controls?.paused ? "Resume" : "Pause all"}
          </button>
        </div>
      </div>
      <div className="small muted">
        heartbeat: {controls?.heartbeat?.running ? "on" : "off"}
        {controls?.heartbeat?.lastTickAt ? ` · last tick ${new Date(controls.heartbeat.lastTickAt).toLocaleTimeString()}` : ""}
        {controls?.heartbeat?.lastTickError ? ` · err: ${controls.heartbeat.lastTickError}` : ""}
      </div>

      <div className="card col">
        <h3 style={{ margin: 0 }}>Active claims</h3>
        {!data?.claims?.length && <div className="muted small">No active claims.</div>}
        {data?.claims?.map((c) => (
          <div key={c.department} className="row small">
            <span className="badge">{c.department}</span>
            <span className="muted">run {c.run_id}</span>
            <a onClick={() => navigate(`/runs/${c.run_id}`)}>view</a>
          </div>
        ))}
      </div>

      <div className="card col">
        <h3 style={{ margin: 0 }}>Running</h3>
        {!data?.runs?.length && <div className="muted small">Nothing running right now.</div>}
        {data?.runs?.map((r) => (
          <div key={r.id} className="row small" style={{ justifyContent: "space-between" }}>
            <div className="col" style={{ gap: 2 }}>
              <div><b>{r.department}</b> · {r.trigger}</div>
              <div className="muted">started {new Date(r.started_at).toLocaleTimeString()}</div>
            </div>
            <button onClick={() => navigate(`/runs/${r.id}`)}>Stream</button>
          </div>
        ))}
      </div>
    </div>
  );
}
