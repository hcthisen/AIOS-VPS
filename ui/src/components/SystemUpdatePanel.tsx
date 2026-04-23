import React, { useEffect, useMemo, useState } from "react";

import { api } from "../api";
import { Banner } from "./Banner";
import { Section } from "./Section";

function shortSha(value?: string | null) {
  return value ? value.slice(0, 7) : "unknown";
}

function formatTime(value?: number | null) {
  return value ? new Date(value).toLocaleString() : "never";
}

export function SystemUpdatePanel() {
  const [status, setStatus] = useState<any>(null);
  const [repoUrl, setRepoUrl] = useState("");
  const [branch, setBranch] = useState("main");
  const [dirty, setDirty] = useState(false);
  const [working, setWorking] = useState<"save" | "check" | "update" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    try {
      const next = await api("/api/settings/system-update/status");
      setStatus(next);
      window.dispatchEvent(new CustomEvent("aios-system-update-status", { detail: next }));
    } catch (e: any) {
      setError(e.message);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  useEffect(() => {
    if (!status) return;
    if (!dirty) {
      setRepoUrl(status.config?.repoUrl || "");
      setBranch(status.config?.branch || "main");
    }
  }, [status, dirty]);

  useEffect(() => {
    if (!status?.state?.inProgress) return;
    const timer = window.setInterval(refresh, 3000);
    return () => window.clearInterval(timer);
  }, [status?.state?.inProgress]);

  const saveConfig = async () => {
    setWorking("save");
    setError(null);
    try {
      const next = await api("/api/settings/system-update/config", {
        method: "POST",
        body: JSON.stringify({ repoUrl, branch }),
      });
      setStatus(next);
      window.dispatchEvent(new CustomEvent("aios-system-update-status", { detail: next }));
      setDirty(false);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setWorking(null);
    }
  };

  const checkNow = async () => {
    setWorking("check");
    setError(null);
    try {
      const next = await api("/api/settings/system-update/check", { method: "POST" });
      setStatus(next);
      window.dispatchEvent(new CustomEvent("aios-system-update-status", { detail: next }));
      setDirty(false);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setWorking(null);
    }
  };

  const startUpdate = async () => {
    setWorking("update");
    setError(null);
    try {
      await api("/api/settings/system-update/start", { method: "POST" });
      await refresh();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setWorking(null);
    }
  };

  const currentSummary = useMemo(() => {
    if (!status?.current) return "Current version unknown";
    return `${status.current.branch || "unknown branch"} @ ${shortSha(status.current.commit)}`;
  }, [status?.current]);

  const latestSummary = useMemo(() => {
    if (!status?.state?.latestCommit) return "Latest version unknown";
    return `${status.config?.branch || branch} @ ${shortSha(status.state.latestCommit)}`;
  }, [status?.state?.latestCommit, status?.config?.branch, branch]);

  const updateState = status?.state;

  return (
    <Section
      title="System update"
      description="Check the configured AIOS-VPS source repo and apply in-place bootstrap + deploy updates without resetting AIOS data."
      actions={!status
        ? <span className="badge">checking</span>
        : !status?.current?.commit
          ? <span className="badge warn">version unknown</span>
        : updateState?.inProgress
          ? <span className="badge warn">updating</span>
          : updateState?.updateAvailable
            ? <span className="badge warn">update available</span>
            : <span className="badge ok">up to date</span>}
    >
      <label className="col">
        <span className="small muted">Updater repo URL</span>
        <input
          value={repoUrl}
          onChange={(e) => { setRepoUrl(e.target.value); setDirty(true); }}
          placeholder="https://github.com/you/AIOS-VPS.git"
        />
      </label>
      <label className="col">
        <span className="small muted">Branch</span>
        <input
          value={branch}
          onChange={(e) => { setBranch(e.target.value); setDirty(true); }}
          placeholder="main"
        />
      </label>

      <div className="small muted">
        Current: <code>{currentSummary}</code><br />
        Latest: <code>{latestSummary}</code><br />
        Last checked: <code>{formatTime(updateState?.lastCheckedAt)}</code><br />
        Active runs: <code>{status?.activeProcesses ?? 0}</code>
      </div>

      {status?.current?.repoUrl && (
        <div className="small muted">Deployed from <code>{status.current.repoUrl}</code></div>
      )}

      {updateState?.lastError && <Banner kind="err">{updateState.lastError}</Banner>}
      {error && <Banner kind="err" onDismiss={() => setError(null)}>{error}</Banner>}
      {updateState?.inProgress && (
        <Banner kind="info">
          {updateState.message || "System update running"} · stage: <code>{updateState.stage}</code>
        </Banner>
      )}
      {!updateState?.inProgress && updateState?.updateAvailable && (
        <Banner kind="warn">
          A newer AIOS-VPS commit is available for <code>{status?.config?.branch || branch}</code>.
        </Banner>
      )}

      <div className="row">
        <button className="primary" onClick={saveConfig} disabled={working !== null || !repoUrl.trim() || !branch.trim() || !dirty}>
          {working === "save" ? "Saving..." : "Save updater source"}
        </button>
        <button onClick={checkNow} disabled={working !== null || !repoUrl.trim() || !branch.trim()}>
          {working === "check" ? "Checking..." : "Check now"}
        </button>
        <button
          className="ghost"
          onClick={startUpdate}
          disabled={working !== null || !status?.canStartUpdate}
        >
          {working === "update" ? "Starting..." : "Update now"}
        </button>
      </div>

      {status?.logTail && (
        <pre className="code-block small">{status.logTail}</pre>
      )}
    </Section>
  );
}
