import React, { useEffect, useState } from "react";
import { api } from "../api";
import { Section } from "../components/Section";
import { IconButton } from "../components/IconButton";
import { Banner } from "../components/Banner";
import { FeedbackButton, useActionRunner } from "../components/FeedbackButton";

export function DepartmentsPage({ navigate }: { navigate: (t: string) => void }) {
  const [data, setData] = useState<any>(null);
  const [name, setName] = useState("");
  const [rootName, setRootName] = useState("Root");
  const [notice, setNotice] = useState<string | null>(null);
  const { actions, run: runAction } = useActionRunner();
  const slug = normalizeDepartmentName(name);

  const refresh = () => api("/api/departments").then((next: any) => {
    setData(next);
    setRootName(next.root?.displayName || "Root");
  });

  useEffect(() => { refresh().catch((e) => setNotice(e?.message || String(e))); }, []);

  const createDepartment = () =>
    runAction("department-create", async () => {
      if (!slug) throw new Error("department name is required");
      const result = await api<{ department: { name: string } }>("/api/departments", {
        method: "POST",
        body: JSON.stringify({ name }),
      });
      setName("");
      await refresh();
      navigate(`/departments/${encodeURIComponent(result.department.name)}`);
    }, setNotice);

  const saveRootName = () =>
    runAction("root-save", async () => {
      const result = await api<{ root: { displayName: string } }>("/api/root", {
        method: "PUT",
        body: JSON.stringify({ displayName: rootName }),
      });
      setRootName(result.root.displayName || "Root");
      await refresh();
    }, setNotice);

  const root = data?.root;
  const rootDirty = root && rootName.trim() !== (root.displayName || "Root");

  return (
    <div className="col">
      <h2>Departments</h2>
      {notice && <Banner kind="err" onDismiss={() => setNotice(null)}>{notice}</Banner>}
      <Section
        title={root?.displayName || "Root"}
        description="Top-level workspace for maintenance and cross-department runs. Agents start in the repository root and can use root cron, goals, skills, webhooks, and environment files."
        actions={
          <>
            {root?.claim
              ? <span className="badge warn">claimed</span>
              : <span className="badge ok">free</span>}
            <IconButton onClick={() => navigate(`/departments/${encodeURIComponent(root?.name || "_root")}`)}>
              Open
            </IconButton>
          </>
        }
      >
        <div className="row nowrap">
          <label className="col" style={{ flex: 1 }}>
            <span className="small muted">Dashboard name</span>
            <input
              value={rootName}
              onChange={(e) => setRootName(e.target.value)}
              placeholder="Root"
              onKeyDown={(e) => {
                if (e.key === "Enter" && rootDirty) saveRootName();
              }}
            />
          </label>
          <FeedbackButton
            className="ghost"
            state={actions["root-save"] || "idle"}
            idleLabel="Save name"
            workingLabel="Saving..."
            okLabel="Saved"
            onClick={saveRootName}
            disabled={!rootDirty}
          />
        </div>
        <div className="small muted">Path: <code>{root?.path || "repository root"}</code></div>
      </Section>
      <Section
        title="Add department"
        description="Creates the folder, updates aios.yaml, writes CLAUDE.md and AGENTS.md, and prepares cron, goals, skills, webhooks, and logs directories."
        actions={
          <FeedbackButton
            className="primary"
            state={actions["department-create"] || "idle"}
            idleLabel="Create"
            workingLabel="Creating..."
            okLabel="Created"
            onClick={createDepartment}
            disabled={!slug}
          />
        }
      >
        <label className="col">
          <span className="small muted">Department name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Marketing"
            onKeyDown={(e) => {
              if (e.key === "Enter" && slug) createDepartment();
            }}
          />
        </label>
        <div className="small muted">
          Folder name: <code>{slug || "department-name"}</code>
        </div>
      </Section>
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

function normalizeDepartmentName(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "");
}
