import React, { useEffect, useState } from "react";
import { api } from "../api";
import { Section } from "../components/Section";
import { IconButton } from "../components/IconButton";

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

  const killAll = async () => {
    await api("/api/controls/kill-all", { method: "POST" });
    refresh();
  };

  return (
    <div className="col">
      <div className="page-header">
        <div>
          <h2>Overview</h2>
          <div className="small muted">
            heartbeat: {controls?.heartbeat?.running ? "on" : "off"}
            {controls?.heartbeat?.lastTickAt ? ` \u00b7 last tick ${new Date(controls.heartbeat.lastTickAt).toLocaleTimeString()}` : ""}
            {controls?.heartbeat?.lastTickError ? ` \u00b7 err: ${controls.heartbeat.lastTickError}` : ""}
          </div>
        </div>
        <div className="page-header-actions">
          <span className={`badge ${controls?.paused ? "warn" : "ok"}`}>
            {controls?.paused ? "paused" : "running"}
          </span>
          <button className="danger" onClick={killAll} disabled={!data?.runs?.length}>
            Kill all + pause
          </button>
          <button className={controls?.paused ? "primary" : "danger"} onClick={togglePause}>
            {controls?.paused ? "Resume" : "Pause all"}
          </button>
        </div>
      </div>

      <Section title="Active claims">
        {!data?.claims?.length ? (
          <div className="muted small">No active claims.</div>
        ) : (
          <div className="col" style={{ gap: 6 }}>
            {data.claims.map((c) => (
              <div key={c.department} className="row small">
                <span className="badge">{c.department}</span>
                <span className="muted">run {c.run_id}</span>
                <span className="spacer" />
                <IconButton onClick={() => navigate(`/runs/${c.run_id}`)}>View</IconButton>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title="Running">
        {!data?.runs?.length ? (
          <div className="muted small">Nothing running right now.</div>
        ) : (
          <div className="col" style={{ gap: 6 }}>
            {data.runs.map((r) => (
              <div key={r.id} className="row small" style={{ justifyContent: "space-between" }}>
                <div className="col" style={{ gap: 2 }}>
                  <div><b>{r.department}</b> \u00b7 {r.trigger}</div>
                  <div className="muted">started {new Date(r.started_at).toLocaleTimeString()}</div>
                </div>
                <button onClick={() => navigate(`/runs/${r.id}`)}>Stream</button>
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}
