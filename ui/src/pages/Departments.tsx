import React, { useEffect, useState } from "react";
import { api } from "../api";
import { Section } from "../components/Section";
import { IconButton } from "../components/IconButton";

export function DepartmentsPage({ navigate }: { navigate: (t: string) => void }) {
  const [data, setData] = useState<any>(null);
  useEffect(() => { api("/api/departments").then(setData); }, []);
  return (
    <div className="col">
      <h2>Departments</h2>
      <Section>
        {!data && <div className="muted">Loading\u2026</div>}
        {data?.departments?.length === 0 && <div className="muted">No departments in <code>aios.yaml</code>.</div>}
        {!!data?.departments?.length && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Claim</th>
                  <th style={{ textAlign: "right" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {data.departments.map((d: any) => (
                  <tr key={d.name}>
                    <td>
                      <a onClick={() => navigate(`/departments/${encodeURIComponent(d.name)}`)}>
                        <b>{d.name}</b>
                      </a>
                    </td>
                    <td>
                      {d.claim
                        ? <span className="badge warn">claimed</span>
                        : <span className="badge ok">free</span>}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      <IconButton onClick={() => navigate(`/departments/${encodeURIComponent(d.name)}`)}>
                        Open
                      </IconButton>
                    </td>
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
