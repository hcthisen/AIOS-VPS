import React, { useEffect, useState } from "react";
import { api } from "../api";

export function UsagePage() {
  const [data, setData] = useState<any>(null);
  useEffect(() => { api("/api/usage").then(setData); }, []);
  if (!data) return <div className="muted">Loading…</div>;
  return (
    <div className="col">
      <h2>Usage</h2>
      <div className="card">
        <h3 style={{ marginTop: 0 }}>By department</h3>
        <table>
          <thead><tr><th>Dept</th><th>Runs</th><th>Tokens in</th><th>Tokens out</th><th>Cost</th></tr></thead>
          <tbody>
            {data.byDept.map((r: any) => (
              <tr key={r.department}><td>{r.department}</td><td>{r.runs}</td><td>{r.tokens_in}</td><td>{r.tokens_out}</td><td>${r.cost_usd?.toFixed(4)}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="card">
        <h3 style={{ marginTop: 0 }}>By day</h3>
        <table>
          <thead><tr><th>Day</th><th>Tokens in</th><th>Tokens out</th><th>Cost</th></tr></thead>
          <tbody>
            {data.byDay.map((r: any) => (
              <tr key={r.day}><td>{r.day}</td><td>{r.tokens_in}</td><td>{r.tokens_out}</td><td>${r.cost_usd?.toFixed(4)}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
