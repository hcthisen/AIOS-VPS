import React, { useEffect, useState } from "react";

import { api } from "../api";
import { Banner } from "./Banner";
import { Section } from "./Section";

type Provider = "claude-code" | "codex";

interface TelegramAgentStatus {
  enabled: boolean;
  provider: Provider;
  providerAuthorized: boolean;
  providers: {
    claudeCode: { authorized: boolean };
    codex: { authorized: boolean };
  };
  sessionId: string | null;
  paired: boolean;
  chatId: string | null;
  botUsername: string | null;
  queued: number;
  running: number;
  activeRunId: string | null;
}

export function TelegramAgentPanel() {
  const [status, setStatus] = useState<TelegramAgentStatus | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [provider, setProvider] = useState<Provider>("claude-code");
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const providerAuthorized = provider === "codex"
    ? !!status?.providers?.codex?.authorized
    : !!status?.providers?.claudeCode?.authorized;
  const hasAuthorizedProvider = !!status?.providers?.codex?.authorized || !!status?.providers?.claudeCode?.authorized;

  const refresh = async () => {
    const next = await api<TelegramAgentStatus>("/api/settings/telegram-agent/status");
    setStatus(next);
    setEnabled(next.enabled);
    setProvider(next.provider);
  };

  useEffect(() => {
    refresh().catch((e: any) => setMessage({ kind: "err", text: e.message }));
    const timer = window.setInterval(() => {
      refresh().catch(() => {});
    }, 5000);
    return () => window.clearInterval(timer);
  }, []);

  const save = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const next = await api<TelegramAgentStatus>("/api/settings/telegram-agent/config", {
        method: "POST",
        body: JSON.stringify({ enabled, provider }),
      });
      setStatus(next);
      setMessage({ kind: "ok", text: "Telegram Root Agent settings saved." });
    } catch (e: any) {
      setMessage({ kind: "err", text: e.message });
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    setResetting(true);
    setMessage(null);
    try {
      const result = await api<{ killed: number; canceled: number; status: TelegramAgentStatus }>("/api/settings/telegram-agent/reset", {
        method: "POST",
      });
      setStatus(result.status);
      setEnabled(result.status.enabled);
      setProvider(result.status.provider);
      setMessage({ kind: "ok", text: `Session reset. Killed ${result.killed} run(s), canceled ${result.canceled} queued message(s).` });
    } catch (e: any) {
      setMessage({ kind: "err", text: e.message });
    } finally {
      setResetting(false);
    }
  };

  return (
    <Section
      title="Telegram Root Agent"
      description="Receive Telegram messages as chat turns for the Root agent. Messages use the selected operator and continue the same provider session until reset."
    >
      <div className="grid-2">
        <label className="col">
          <span className="small muted">Status</span>
          <select value={enabled ? "enabled" : "disabled"} onChange={(e) => setEnabled(e.target.value === "enabled")}>
            <option value="disabled">Disabled</option>
            <option value="enabled">Enabled</option>
          </select>
        </label>
        <label className="col">
          <span className="small muted">Operator</span>
          <select value={provider} onChange={(e) => setProvider(e.target.value as Provider)}>
            <option value="claude-code" disabled={!status?.providers?.claudeCode?.authorized}>
              Claude Code{status?.providers?.claudeCode?.authorized ? "" : " (not connected)"}
            </option>
            <option value="codex" disabled={!status?.providers?.codex?.authorized}>
              Codex{status?.providers?.codex?.authorized ? "" : " (not connected)"}
            </option>
          </select>
        </label>
      </div>

      <div className="row">
        <span className={status?.paired ? "badge ok" : "badge warn"}>
          {status?.paired ? `Paired${status.botUsername ? ` via @${status.botUsername}` : ""}` : "No Telegram chat paired"}
        </span>
        <span className={providerAuthorized ? "badge ok" : "badge warn"}>
          {provider === "codex" ? "Codex" : "Claude Code"} {providerAuthorized ? "connected" : "not connected"}
        </span>
        <span className="badge">queued {status?.queued ?? 0}</span>
        <span className="badge">running {status?.running ?? 0}</span>
        {status?.activeRunId && <span className="badge">active {status.activeRunId}</span>}
      </div>

      <div className="small muted">
        Session: <code>{status?.sessionId || "none"}</code>
      </div>

      <div className="row">
        <button className="primary" onClick={save} disabled={saving || !status?.paired || !providerAuthorized}>
          {saving ? "Saving..." : "Save Telegram agent settings"}
        </button>
        <button className="danger" onClick={reset} disabled={resetting}>
          {resetting ? "Resetting..." : "Reset session"}
        </button>
      </div>

      {!status?.paired && (
        <div className="small muted">
          Pair a Telegram bot and approve a chat in Notifications before enabling inbound Root agent chat.
        </div>
      )}
      {status?.paired && !hasAuthorizedProvider && (
        <div className="small muted">
          Connect Claude Code or Codex before enabling inbound Root agent chat.
        </div>
      )}

      {message && <Banner kind={message.kind} onDismiss={() => setMessage(null)}>{message.text}</Banner>}
    </Section>
  );
}
