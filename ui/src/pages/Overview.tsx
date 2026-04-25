import React, { useEffect, useState } from "react";
import { api } from "../api";
import { Section } from "../components/Section";
import { IconButton } from "../components/IconButton";

interface OwnerNotification {
  id: number;
  source_scope: string;
  source_path: string;
  title: string;
  body: string;
  priority: "info" | "warning" | "critical";
  tags: string;
  status: "pending" | "delivered" | "failed" | "no_channel";
  delivery_attempts: number;
  last_error: string | null;
  created_at: number;
  delivered_at: number | null;
  read_at: number | null;
}

export function Overview({ navigate }: { navigate: (t: string) => void }) {
  const [data, setData] = useState<{ runs: any[]; claims: any[] } | null>(null);
  const [controls, setControls] = useState<any>(null);
  const [notifications, setNotifications] = useState<{ notifications: OwnerNotification[]; total: number } | null>(null);
  const [notificationOffset, setNotificationOffset] = useState(0);
  const [notificationQuery, setNotificationQuery] = useState("");
  const [notificationScope, setNotificationScope] = useState("");
  const [notificationPriority, setNotificationPriority] = useState("");
  const [notificationStatus, setNotificationStatus] = useState("");
  const [notificationBusy, setNotificationBusy] = useState<string | null>(null);
  const notificationLimit = 50;

  const refresh = async () => {
    try {
      setData(await api("/api/runs/active"));
      setControls(await api("/api/controls/status"));
    } catch {}
  };

  useEffect(() => { refresh(); const t = setInterval(refresh, 3000); return () => clearInterval(t); }, []);
  useEffect(() => {
    let canceled = false;
    const load = async () => {
      const params = new URLSearchParams({
        limit: String(notificationLimit),
        offset: String(notificationOffset),
      });
      if (notificationQuery.trim()) params.set("query", notificationQuery.trim());
      if (notificationScope) params.set("scope", notificationScope);
      if (notificationPriority) params.set("priority", notificationPriority);
      if (notificationStatus) params.set("status", notificationStatus);
      try {
        const next = await api<{ notifications: OwnerNotification[]; total: number }>(`/api/notifications?${params.toString()}`);
        if (!canceled) setNotifications(next);
      } catch {}
    };
    load();
    const t = setInterval(load, 5000);
    return () => { canceled = true; clearInterval(t); };
  }, [notificationOffset, notificationQuery, notificationScope, notificationPriority, notificationStatus]);

  const togglePause = async () => {
    if (controls?.paused) await api("/api/controls/resume", { method: "POST" });
    else await api("/api/controls/pause", { method: "POST" });
    refresh();
  };

  const killAll = async () => {
    await api("/api/controls/kill-all", { method: "POST" });
    refresh();
  };

  const reloadNotifications = async () => {
    const params = new URLSearchParams({
      limit: String(notificationLimit),
      offset: String(notificationOffset),
    });
    if (notificationQuery.trim()) params.set("query", notificationQuery.trim());
    if (notificationScope) params.set("scope", notificationScope);
    if (notificationPriority) params.set("priority", notificationPriority);
    if (notificationStatus) params.set("status", notificationStatus);
    setNotifications(await api(`/api/notifications?${params.toString()}`));
  };

  const notificationAction = async (id: number, action: "read" | "unread" | "retry") => {
    const key = `${action}-${id}`;
    setNotificationBusy(key);
    try {
      await api(`/api/notifications/${id}/${action}`, { method: "POST" });
      await reloadNotifications();
    } finally {
      setNotificationBusy(null);
    }
  };

  const resetNotificationFilters = () => {
    setNotificationOffset(0);
    setNotificationQuery("");
    setNotificationScope("");
    setNotificationPriority("");
    setNotificationStatus("");
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

      <Section
        title="Notifications"
        description="Owner notifications created from root or department outbox files."
        actions={(
          <div className="row">
            <button className="ghost" onClick={resetNotificationFilters}>Reset filters</button>
            <button onClick={reloadNotifications}>Refresh</button>
          </div>
        )}
      >
        <div className="row">
          <input
            style={{ minWidth: 220, flex: "1 1 260px" }}
            placeholder="Search notifications"
            value={notificationQuery}
            onChange={(e) => { setNotificationOffset(0); setNotificationQuery(e.target.value); }}
          />
          <input
            style={{ minWidth: 160, flex: "0 1 180px" }}
            placeholder="Scope"
            value={notificationScope}
            onChange={(e) => { setNotificationOffset(0); setNotificationScope(e.target.value); }}
          />
          <select
            style={{ width: 150 }}
            value={notificationPriority}
            onChange={(e) => { setNotificationOffset(0); setNotificationPriority(e.target.value); }}
          >
            <option value="">Any priority</option>
            <option value="info">Info</option>
            <option value="warning">Warning</option>
            <option value="critical">Critical</option>
          </select>
          <select
            style={{ width: 160 }}
            value={notificationStatus}
            onChange={(e) => { setNotificationOffset(0); setNotificationStatus(e.target.value); }}
          >
            <option value="">Any status</option>
            <option value="delivered">Delivered</option>
            <option value="no_channel">No channel</option>
            <option value="failed">Failed</option>
            <option value="pending">Pending</option>
          </select>
        </div>
        {!notifications?.notifications?.length ? (
          <div className="muted small">No notifications yet.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Message</th>
                  <th>Scope</th>
                  <th>Priority</th>
                  <th>Status</th>
                  <th>Created</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {notifications.notifications.map((notification) => (
                  <tr key={notification.id}>
                    <td>
                      <div className="col" style={{ gap: 4 }}>
                        <div className={notification.read_at ? "" : "mono"}>
                          <b>{notification.title}</b>
                        </div>
                        <div className="small muted">{preview(notification.body)}</div>
                        {notification.last_error ? <div className="small" style={{ color: "var(--danger)" }}>{notification.last_error}</div> : null}
                      </div>
                    </td>
                    <td>{notification.source_scope === "_root" ? "Root" : notification.source_scope}</td>
                    <td><span className={`badge ${priorityClass(notification.priority)}`}>{notification.priority}</span></td>
                    <td><span className={`badge ${statusClass(notification.status)}`}>{formatStatus(notification.status)}</span></td>
                    <td className="small muted">{new Date(notification.created_at).toLocaleString()}</td>
                    <td>
                      <div className="row" style={{ gap: 6 }}>
                        <IconButton
                          onClick={() => notificationAction(notification.id, notification.read_at ? "unread" : "read")}
                          disabled={notificationBusy === `${notification.read_at ? "unread" : "read"}-${notification.id}`}
                        >
                          {notification.read_at ? "Unread" : "Read"}
                        </IconButton>
                        {(notification.status === "failed" || notification.status === "no_channel" || notification.status === "pending") && (
                          <IconButton
                            onClick={() => notificationAction(notification.id, "retry")}
                            disabled={notificationBusy === `retry-${notification.id}`}
                          >
                            Retry
                          </IconButton>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="row">
          <div className="small muted">
            Showing {notifications?.notifications?.length || 0} of {notifications?.total || 0}
          </div>
          <span className="spacer" />
          <button
            disabled={notificationOffset <= 0}
            onClick={() => setNotificationOffset(Math.max(0, notificationOffset - notificationLimit))}
          >
            Previous
          </button>
          <button
            disabled={!notifications || notificationOffset + notificationLimit >= notifications.total}
            onClick={() => setNotificationOffset(notificationOffset + notificationLimit)}
          >
            Next
          </button>
        </div>
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

function preview(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > 180 ? `${normalized.slice(0, 177)}...` : normalized;
}

function priorityClass(priority: OwnerNotification["priority"]): string {
  if (priority === "critical") return "err";
  if (priority === "warning") return "warn";
  return "";
}

function statusClass(status: OwnerNotification["status"]): string {
  if (status === "delivered") return "ok";
  if (status === "failed") return "err";
  if (status === "no_channel") return "warn";
  return "";
}

function formatStatus(status: OwnerNotification["status"]): string {
  return status.replace(/_/g, " ");
}
