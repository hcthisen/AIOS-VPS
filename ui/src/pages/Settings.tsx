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
  const gitSync = controls?.gitSync;

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
        {gitSync && (
          <div className="grid-2">
            <div className="small"><span className="muted">Git sync</span><br /><b>{gitSync.inProgress ? "running" : gitSync.pendingInboundSync ? "pending" : "idle"}</b></div>
            <div className="small"><span className="muted">Blocked</span><br /><b>{String(!!gitSync.blockedByActiveRuns)}</b></div>
            <div className="small"><span className="muted">Last remote check</span><br /><b>{gitSync.lastRemoteCheckAt ? new Date(gitSync.lastRemoteCheckAt).toLocaleString() : "never"}</b></div>
            <div className="small"><span className="muted">Last success</span><br /><b>{gitSync.lastSuccessAt ? new Date(gitSync.lastSuccessAt).toLocaleString() : "never"}</b></div>
            <div className="small"><span className="muted">Remote commit</span><br /><b>{shortSha(gitSync.lastRemoteCommit)}</b></div>
            <div className="small"><span className="muted">Local commit</span><br /><b>{shortSha(gitSync.lastLocalCommit)}</b></div>
            <div className="small"><span className="muted">Conflict outcome</span><br /><b>{gitSync.lastConflictResolution || "none"}</b></div>
            <div className="small"><span className="muted">Last error</span><br /><b>{gitSync.lastError || "none"}</b></div>
          </div>
        )}
        {syncResult && <pre className="log small">{JSON.stringify(syncResult, null, 2)}</pre>}
      </Section>
    </div>
  );
}

function shortSha(value: string | null | undefined) {
  return value ? value.slice(0, 8) : "unknown";
}
