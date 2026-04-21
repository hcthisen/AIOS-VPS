import React, { useEffect, useState } from "react";
import { api } from "../api";
import { Section } from "../components/Section";

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
  const killAll = async () => { await api("/api/controls/kill-all", { method: "POST" }); refresh(); };

  return (
    <div className="col">
      <h2>Settings</h2>

      <Section
        title="Controls"
        description={`heartbeat ${controls?.heartbeat?.running ? "on" : "off"} \u00b7 active processes ${controls?.activeProcesses ?? 0} \u00b7 paused: ${String(!!controls?.paused)}`}
      >
        <div className="row">
          <button onClick={runSync}>Run sync</button>
          <button onClick={runHeartbeat}>Trigger heartbeat tick</button>
          <button className="danger" onClick={killAll}>Kill all + pause</button>
        </div>
        {syncResult && <pre className="log small">{JSON.stringify(syncResult, null, 2)}</pre>}
      </Section>

      <Section
        title="Notifications"
        description={<>To change, run the onboarding notifications step again by POSTing to <code>/api/onboarding/notifications/save</code>.</>}
      >
        <pre className="code-block small">{JSON.stringify(notif || {}, null, 2)}</pre>
      </Section>
    </div>
  );
}
