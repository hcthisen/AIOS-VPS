import React, { useEffect, useState } from "react";
import { api } from "../api";

export function SettingsPage() {
  const [controls, setControls] = useState<any>(null);
  const [syncResult, setSyncResult] = useState<any>(null);
  const [notif, setNotif] = useState<any>(null);

  const refresh = async () => {
    setControls(await api("/api/controls/status").catch(() => null));
    setNotif(await api("/api/onboarding/notifications/config").catch(() => null));
  };
  useEffect(() => { refresh(); }, []);

  const runSync = async () => { setSyncResult(await api("/api/controls/sync", { method: "POST" })); };
  const runHeartbeat = async () => { await api("/api/controls/heartbeat", { method: "POST" }); refresh(); };

  return (
    <div className="col">
      <h2>Settings</h2>

      <div className="card col">
        <h3 style={{ margin: 0 }}>Controls</h3>
        <div className="small muted">
          heartbeat {controls?.heartbeat?.running ? "on" : "off"} ·
          active processes {controls?.activeProcesses ?? 0} ·
          paused: <b>{String(!!controls?.paused)}</b>
        </div>
        <div className="row">
          <button onClick={runSync}>Run sync</button>
          <button onClick={runHeartbeat}>Trigger heartbeat tick</button>
        </div>
        {syncResult && <pre className="log small">{JSON.stringify(syncResult, null, 2)}</pre>}
      </div>

      <div className="card col">
        <h3 style={{ margin: 0 }}>Notifications</h3>
        <div className="small mono">{JSON.stringify(notif || {}, null, 2)}</div>
        <p className="small muted">To change, run the onboarding notifications step again by POSTing to <code>/api/onboarding/notifications/save</code>.</p>
      </div>
    </div>
  );
}
