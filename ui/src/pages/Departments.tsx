import React, { useEffect, useState } from "react";
import { api } from "../api";

export function DepartmentsPage({ navigate }: { navigate: (t: string) => void }) {
  const [data, setData] = useState<any>(null);
  useEffect(() => { api("/api/departments").then(setData); }, []);
  return (
    <div>
      <h2>Departments</h2>
      {!data && <div className="muted">Loading…</div>}
      {data?.departments?.length === 0 && <div className="muted">No departments in <code>aios.yaml</code>.</div>}
      <table>
        <thead><tr><th>Name</th><th>Claim</th><th></th></tr></thead>
        <tbody>
          {data?.departments?.map((d: any) => (
            <tr key={d.name}>
              <td><b>{d.name}</b></td>
              <td>{d.claim ? <span className="badge warn">claimed</span> : <span className="badge ok">free</span>}</td>
              <td><a onClick={() => navigate(`/departments/${encodeURIComponent(d.name)}`)}>view</a></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
