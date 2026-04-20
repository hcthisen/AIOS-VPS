import React, { useEffect, useState } from "react";
import { api } from "../api";
import { Section } from "../components/Section";

export function BacklogPage() {
  const [rows, setRows] = useState<any[]>([]);
  useEffect(() => {
    const load = () => api<{ backlog: any[] }>("/api/backlog").then((r) => setRows(r.backlog));
    load(); const t = setInterval(load, 3000); return () => clearInterval(t);
  }, []);
  return (
    <div className="col">
      <h2>Backlog</h2>
      <Section description="Runs waiting for a free claim.">
        {!rows.length ? (
          <div className="muted small">Empty.</div>
        ) : (
          <div className="table-wrap">
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
        )}
      </Section>
    </div>
  );
}
