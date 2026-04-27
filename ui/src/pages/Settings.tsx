import React, { useEffect, useState } from "react";

import { api } from "../api";
import { Section } from "../components/Section";
import { SystemUpdatePanel } from "../components/SystemUpdatePanel";
import { TelegramAgentPanel } from "../components/TelegramAgentPanel";
import { ProviderAuth } from "./ProviderAuth";
import { GithubSetup } from "./GithubSetup";
import { NotificationsSetup } from "./NotificationsSetup";

export function SettingsPage() {
  const [controls, setControls] = useState<any>(null);
  const [syncResult, setSyncResult] = useState<any>(null);

  const refresh = async () => {
    setControls(await api("/api/controls/status").catch(() => null));
  };
  useEffect(() => { refresh(); }, []);

  const runSync = async () => { setSyncResult(await api("/api/controls/sync", { method: "POST" })); };
  const runHeartbeat = async () => { await api("/api/controls/heartbeat", { method: "POST" }); refresh(); };
  const killAll = async () => { await api("/api/controls/kill-all", { method: "POST" }); refresh(); };

  return (
    <div className="col">
      <h2>Settings</h2>

      <SystemUpdatePanel />

      <ProviderAuth mode="settings" />

      <GithubSetup mode="settings" basePath="/api/settings/github" />

      <NotificationsSetup mode="settings" basePath="/api/settings/notifications" />

      <TelegramAgentPanel />

      <Section
        title="Controls"
        description={`heartbeat ${controls?.heartbeat?.running ? "on" : "off"} · active processes ${controls?.activeProcesses ?? 0} · paused: ${String(!!controls?.paused)}`}
      >
        <div className="row">
          <button onClick={runSync}>Pull GitHub + sync</button>
          <button onClick={runHeartbeat}>Trigger heartbeat tick</button>
          <button className="danger" onClick={killAll}>Kill all + pause</button>
        </div>
        {syncResult && <pre className="log small">{JSON.stringify(syncResult, null, 2)}</pre>}
      </Section>
    </div>
  );
}
