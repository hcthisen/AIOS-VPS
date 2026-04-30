import React, { useEffect, useState } from "react";

import { api, getActiveCompanySlug } from "../api";
import { Banner } from "../components/Banner";
import { Section } from "../components/Section";
import { SystemUpdatePanel } from "../components/SystemUpdatePanel";
import { TelegramAgentPanel } from "../components/TelegramAgentPanel";
import { ProviderAuth } from "./ProviderAuth";
import { GithubSetup } from "./GithubSetup";
import { NotificationsSetup } from "./NotificationsSetup";
import { formatFixedOffsetTime } from "../components/ServerClock";

interface Company {
  id: number;
  slug: string;
  displayName: string;
  repoFullName: string | null;
  setupPhase: string;
  isDefault: boolean;
}

export function SettingsPage({ onCompaniesChanged }: { onCompaniesChanged: () => Promise<void> }) {
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

      <TimeSettings />

      <SystemUpdatePanel />

      <ProviderAuth mode="settings" />

      <GithubSetup mode="settings" basePath="/api/settings/github" />

      <NotificationsSetup mode="settings" basePath="/api/settings/notifications" />

      <TelegramAgentPanel />

      <CompaniesSettings onChanged={onCompaniesChanged} />

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

function CompaniesSettings({ onChanged }: { onChanged: () => Promise<void> }) {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [nameEdits, setNameEdits] = useState<Record<string, string>>({});
  const [busySlug, setBusySlug] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const activeSlug = getActiveCompanySlug();

  const load = async () => {
    const result = await api<{ companies: Company[] }>("/api/companies");
    const rows = result.companies || [];
    setCompanies(rows);
    setNameEdits(Object.fromEntries(rows.map((company) => [company.slug, company.displayName])));
  };

  useEffect(() => { load().catch((e) => setError(e.message)); }, []);

  const removeCompany = async (company: Company) => {
    const confirmed = window.confirm(
      `Remove ${company.displayName}? This removes its AIOS data and local cloned repo from this VPS. The GitHub repository itself is not deleted.`,
    );
    if (!confirmed) return;

    setBusySlug(company.slug);
    setError(null);
    try {
      await api(`/api/companies/${encodeURIComponent(company.slug)}`, { method: "DELETE" });
      await load();
      await onChanged();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusySlug(null);
    }
  };

  const saveName = async (company: Company) => {
    const displayName = String(nameEdits[company.slug] || "").trim();
    setBusySlug(company.slug);
    setError(null);
    try {
      await api(`/api/companies/${encodeURIComponent(company.slug)}`, {
        method: "PATCH",
        body: JSON.stringify({ displayName }),
      });
      await load();
      await onChanged();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusySlug(null);
    }
  };

  return (
    <Section
      title="Companies"
      description="Rename dashboard labels or remove connected companies from this VPS. The GitHub repository remains on GitHub and can be attached again later."
    >
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Company</th>
              <th>Repository</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {companies.map((company) => {
              const editName = nameEdits[company.slug] ?? company.displayName;
              const isDirty = editName.trim() !== company.displayName;
              return (
                <tr key={company.slug}>
                  <td>
                    <div className="col" style={{ gap: 6 }}>
                      <input
                        value={editName}
                        onChange={(e) => setNameEdits({ ...nameEdits, [company.slug]: e.target.value })}
                        aria-label={`${company.displayName} display name`}
                      />
                      <div>
                        <code>{company.slug}</code>
                        {company.slug === activeSlug ? <span className="badge ok" style={{ marginLeft: 8 }}>active</span> : null}
                      </div>
                    </div>
                  </td>
                  <td className="small muted">{company.repoFullName || "not connected"}</td>
                  <td className="small muted">{company.isDefault ? "default" : company.setupPhase}</td>
                  <td>
                    <div className="row" style={{ justifyContent: "flex-end" }}>
                      <button
                        className="icon-btn"
                        onClick={() => saveName(company)}
                        disabled={busySlug === company.slug || !editName.trim() || !isDirty}
                      >
                        {busySlug === company.slug ? "Saving..." : "Save"}
                      </button>
                      <button
                        className="icon-btn danger"
                        onClick={() => removeCompany(company)}
                        disabled={company.isDefault || busySlug === company.slug}
                        title={company.isDefault ? "The default company cannot be removed" : "Remove company"}
                      >
                        Remove
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {error ? <Banner kind="err" onDismiss={() => setError(null)}>{error}</Banner> : null}
    </Section>
  );
}

function shortSha(value: string | null | undefined) {
  return value ? value.slice(0, 8) : "unknown";
}

interface TimeSnapshot {
  serverNow: number;
  timezoneOffsetMinutes: number;
  timezoneLabel: string;
  cronTimezone: string;
}

function TimeSettings() {
  const [snapshot, setSnapshot] = useState<TimeSnapshot | null>(null);
  const [offset, setOffset] = useState(0);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const next = await api<TimeSnapshot>("/api/settings/time");
    setSnapshot(next);
    setOffset(next.timezoneOffsetMinutes);
  };

  useEffect(() => { load().catch((e) => setError(e.message)); }, []);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await api<TimeSnapshot>("/api/settings/time", {
        method: "POST",
        body: JSON.stringify({ timezoneOffsetMinutes: offset }),
      });
      setSnapshot(next);
      setOffset(next.timezoneOffsetMinutes);
      setSavedAt(Date.now());
      window.dispatchEvent(new Event("aios-time-settings-changed"));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section
      title="Time"
      description="Cron tasks and goal wake schedules use this fixed UTC offset. The clock in the sidebar shows the same scheduler time."
      actions={savedAt ? <span className="small muted">Saved {new Date(savedAt).toLocaleTimeString()}</span> : null}
    >
      <div className="grid-2">
        <label className="col">
          <span className="small muted">Scheduler timezone</span>
          <select value={offset} onChange={(e) => setOffset(Number(e.target.value))}>
            {timezoneOptions().map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
        <div className="small">
          <span className="muted">Current scheduler time</span><br />
          <b>{snapshot ? `${formatFixedOffsetTime(snapshot.serverNow, offset)} ${formatOffsetLabel(offset)}` : "Loading..."}</b>
          {snapshot ? <div className="muted">cron timezone: {offset === snapshot.timezoneOffsetMinutes ? snapshot.cronTimezone : "will update after save"}</div> : null}
        </div>
      </div>
      <div className="row">
        <button className="primary" onClick={save} disabled={busy || !snapshot || offset === snapshot.timezoneOffsetMinutes}>
          {busy ? "Saving..." : "Save timezone"}
        </button>
        {error ? <span className="small" style={{ color: "var(--danger)" }}>{error}</span> : null}
      </div>
    </Section>
  );
}

function timezoneOptions() {
  const out: Array<{ value: number; label: string }> = [];
  for (let hour = -12; hour <= 14; hour++) {
    out.push({ value: hour * 60, label: formatOffsetLabel(hour * 60) });
  }
  return out;
}

function formatOffsetLabel(offsetMinutes: number): string {
  if (offsetMinutes === 0) return "UTC";
  const sign = offsetMinutes > 0 ? "+" : "-";
  const hours = Math.floor(Math.abs(offsetMinutes) / 60);
  return `UTC${sign}${String(hours).padStart(2, "0")}`;
}
