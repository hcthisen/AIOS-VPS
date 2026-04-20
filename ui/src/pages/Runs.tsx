import React, { useEffect, useState } from "react";
import { api } from "../api";

export function RunsPage({ navigate }: { navigate: (t: string) => void }) {
  const [runs, setRuns] = useState<any[]>([]);
  useEffect(() => {
    const load = () => api<{ runs: any[] }>("/api/runs?limit=100").then((r) => setRuns(r.runs));
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, []);
  return (
    <div>
      <h2>Runs</h2>
      <table>
        <thead><tr><th>Started</th><th>Dept</th><th>Trigger</th><th>Provider</th><th>Status</th><th></th></tr></thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id}>
              <td className="mono small">{new Date(r.started_at).toLocaleString()}</td>
              <td>{r.department}</td>
              <td className="small">{r.trigger}</td>
              <td>{r.provider || "—"}</td>
              <td><span className={`badge ${statusClass(r.status)}`}>{r.status}</span></td>
              <td><a onClick={() => navigate(`/runs/${r.id}`)}>view</a></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function statusClass(s: string) {
  if (s === "succeeded") return "ok";
  if (s === "running" || s === "queued") return "";
  return "err";
}
