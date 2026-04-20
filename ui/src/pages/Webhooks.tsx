import React, { useEffect, useState } from "react";
import { api } from "../api";

export function WebhooksPage() {
  const [rows, setRows] = useState<any[]>([]);
  useEffect(() => {
    const load = () => api<{ deliveries: any[] }>("/api/webhooks/deliveries").then((r) => setRows(r.deliveries));
    load(); const t = setInterval(load, 5000); return () => clearInterval(t);
  }, []);
  return (
    <div>
      <h2>Webhook deliveries</h2>
      <p className="small muted">POST to <code>/webhooks/&lt;dept&gt;/&lt;name&gt;</code> — handler files live at <code>&lt;dept&gt;/webhooks/&lt;name&gt;.md</code>.</p>
      {!rows.length && <div className="muted">No deliveries yet.</div>}
      <table>
        <thead><tr><th>Received</th><th>Endpoint</th><th>Outcome</th></tr></thead>
        <tbody>
          {rows.map((d) => (
            <tr key={d.id}>
              <td className="mono small">{new Date(d.received_at).toLocaleString()}</td>
              <td>{d.endpoint}</td>
              <td><span className="badge">{d.outcome}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
