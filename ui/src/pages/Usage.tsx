import React, { useEffect, useState } from "react";
import { api } from "../api";
import { Section } from "../components/Section";

export function UsagePage() {
  const [data, setData] = useState<any>(null);
  useEffect(() => { api("/api/usage").then(setData); }, []);
  if (!data) return <div className="muted">Loading\u2026</div>;
  return (
    <div className="col">
      <h2>Usage</h2>
      <Section title="By department" className="table-cards">
        <div className="table-wrap">
          <table>
            <thead><tr><th>Dept</th><th>Runs</th><th>Tokens in</th><th>Tokens out</th><th>Cost</th></tr></thead>
            <tbody>
              {data.byDept.map((r: any) => (
                <tr key={r.department}>
                  <td data-label="Dept">{r.department}</td>
                  <td data-label="Runs">{r.runs}</td>
                  <td data-label="Tokens in">{r.tokens_in}</td>
                  <td data-label="Tokens out">{r.tokens_out}</td>
                  <td data-label="Cost">{formatUsd(r.cost_usd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
      <Section title="By day" className="table-cards">
        <div className="table-wrap">
          <table>
            <thead><tr><th>Day</th><th>Tokens in</th><th>Tokens out</th><th>Cost</th></tr></thead>
            <tbody>
              {data.byDay.map((r: any) => (
                <tr key={r.day}>
                  <td data-label="Day">{r.day}</td>
                  <td data-label="Tokens in">{r.tokens_in}</td>
                  <td data-label="Tokens out">{r.tokens_out}</td>
                  <td data-label="Cost">{formatUsd(r.cost_usd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
    </div>
  );
}

function formatUsd(value: number | null | undefined) {
  return typeof value === "number" ? `$${value.toFixed(4)}` : "-";
}
