import React, { useEffect, useState } from "react";
import { api } from "../api";

export function BacklogPage() {
  const [rows, setRows] = useState<any[]>([]);
  useEffect(() => {
    const load = () => api<{ backlog: any[] }>("/api/backlog").then((r) => setRows(r.backlog));
    load(); const t = setInterval(load, 3000); return () => clearInterval(t);
  }, []);
  return (
    <div>
      <h2>Backlog</h2>
      {!rows.length && <div className="muted">Empty.</div>}
      <table>
        <thead><tr><th>Queued</th><th>Dept</th><th>Trigger</th></tr></thead>
        <tbody>
          {rows.map((b) => (
            <tr key={b.id}>
              <td className="mono small">{new Date(b.queued_at).toLocaleString()}</td>
              <td>{b.department}</td><td className="small">{b.trigger}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
