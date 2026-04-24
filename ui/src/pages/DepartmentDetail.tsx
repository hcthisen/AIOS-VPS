import React, { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { ScheduleField } from "../components/ScheduleField";
import { Section } from "../components/Section";
import { Tabs } from "../components/Tabs";
import { Drawer } from "../components/Drawer";
import { Banner } from "../components/Banner";
import { IconButton } from "../components/IconButton";
import { FeedbackButton, useActionRunner } from "../components/FeedbackButton";
import { DirtyDot } from "../components/DirtyDot";
import { SavedAt } from "../components/SavedAt";
import { describeCronSchedule } from "../lib/cron";
import { FilesTab } from "./files/FilesTab";
import { FilesQuery } from "./files/types";

interface CronTask {
  name: string;
  relPath: string;
  path: string;
  schedule: string;
  provider?: string;
  paused?: boolean;
}

interface Goal {
  name: string;
  relPath: string;
  path: string;
  status: string;
  schedule: string;
  provider?: string;
}

interface Run {
  id: string;
  started_at: string;
  trigger: string;
  status: string;
}

interface BacklogEntry {
  id: string;
  trigger: string;
  queued_at: string;
}

interface Claim {
  owner?: string;
  acquired_at?: string;
  stale?: boolean;
}

interface Department {
  name: string;
  displayName?: string;
  isRoot?: boolean;
  path: string;
  claim: Claim | null;
  cron: CronTask[];
  goals: Goal[];
  runs: Run[];
  backlog: BacklogEntry[];
}

type TabId = "tasks" | "goals" | "files" | "env" | "runs" | "backlog";

type EditorMode = "create" | "edit";

interface CronEditorState {
  mode: EditorMode;
  relPath: string | null;
  name: string;
  schedule: string;
  provider: string;
  prompt: string;
}

interface GoalEditorState {
  mode: EditorMode;
  relPath: string | null;
  name: string;
  status: string;
  schedule: string;
  provider: string;
  prompt: string;
}

export function DepartmentDetail({ name, navigate }: { name: string; navigate: (t: string) => void }) {
  const isRootScope = name === "_root";
  const [d, setD] = useState<Department | null>(null);
  const [tab, setTabState] = useState<TabId>(() => readTabFromUrl());
  const [filesQuery, setFilesQueryState] = useState<FilesQuery>(() => readFilesQueryFromUrl());
  const [notice, setNotice] = useState<string | null>(null);

  const setTab = (next: TabId) => {
    setTabState(next);
    writeUrlParams({ tab: next, files: next === "files" ? filesQuery : undefined });
  };

  const setFilesQuery = (next: FilesQuery) => {
    setFilesQueryState(next);
    writeUrlParams({ tab, files: next });
  };

  useEffect(() => {
    const onPop = () => {
      setTabState(readTabFromUrl());
      setFilesQueryState(readFilesQueryFromUrl());
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const [envText, setEnvText] = useState("");
  const [envInitial, setEnvInitial] = useState("");
  const [envSavedAt, setEnvSavedAt] = useState<number | null>(null);
  const [envReveal, setEnvReveal] = useState(false);
  const [envRaw, setEnvRaw] = useState(false);

  const [cronEditor, setCronEditor] = useState<CronEditorState | null>(null);
  const [goalEditor, setGoalEditor] = useState<GoalEditorState | null>(null);

  const { actions, run: runAction } = useActionRunner();

  const envDirty = envText !== envInitial;
  const dirty = envDirty || cronEditor != null || goalEditor != null;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  const refresh = async () => {
    const next = await api<Department>(`/api/departments/${encodeURIComponent(name)}`);
    setD(next);
  };

  useEffect(() => {
    refresh().catch((e) => setNotice(e?.message || String(e)));
    const timer = setInterval(() => {
      if (dirtyRef.current) return;
      refresh().catch(() => {});
    }, 5000);
    return () => clearInterval(timer);
  }, [name]);

  useEffect(() => {
    loadFile(scopedRelPath(name, ".env"), (text) => {
      setEnvText(text);
      setEnvInitial(text);
    }, true);
  }, [name]);

  const saveTextFile = async (relPath: string, text: string) => {
    await api(fileUrl(relPath), {
      method: "PUT",
      headers: { "Content-Type": "text/plain" },
      body: text,
    });
  };

  const togglePause = (task: CronTask) =>
    runAction(
      `cron-${task.relPath}-pause`,
      async () => {
        await api(`/api/cron/${encodeURIComponent(task.relPath)}/${task.paused ? "resume" : "pause"}`, { method: "POST" });
        await refresh();
      },
      setNotice,
    );

  const openCreateCron = () => setCronEditor({
    mode: "create", relPath: null, name: "", schedule: "0 * * * *", provider: "", prompt: "",
  });
  const openEditCron = async (task: CronTask) => {
    const text = await api<string>(fileUrl(task.relPath)).catch(() => "");
    const prompt = stripFrontmatter(text);
    setCronEditor({
      mode: "edit",
      relPath: task.relPath,
      name: task.name,
      schedule: task.schedule || "0 * * * *",
      provider: task.provider || "",
      prompt,
    });
  };
  const saveCron = () =>
    runAction("cron-save", async () => {
      if (!cronEditor) return;
      const prompt = cronEditor.prompt.trim();
      if (!prompt) throw new Error("prompt is required");
      const providerLine = cronEditor.provider ? `provider: ${cronEditor.provider}\n` : "";
      const body = `---\nschedule: "${cronEditor.schedule}"\n${providerLine}---\n\n${prompt}\n`;
      const relPath = cronEditor.mode === "create"
        ? buildRelPath(name, "cron", cronEditor.name)
        : cronEditor.relPath!;
      if (cronEditor.mode === "create" && !cronEditor.name.trim()) throw new Error("task name is required");
      await saveTextFile(relPath, body);
      await refresh();
      setCronEditor(null);
    }, setNotice);

  const openCreateGoal = () => setGoalEditor({
    mode: "create", relPath: null, name: "", status: "active", schedule: "0 9 * * *", provider: "", prompt: "",
  });
  const openEditGoal = async (goal: Goal) => {
    const text = await api<string>(fileUrl(goal.relPath)).catch(() => "");
    const prompt = stripFrontmatter(text);
    setGoalEditor({
      mode: "edit",
      relPath: goal.relPath,
      name: goal.name,
      status: goal.status,
      schedule: goal.schedule || "0 9 * * *",
      provider: goal.provider || "",
      prompt,
    });
  };
  const saveGoal = () =>
    runAction("goal-save", async () => {
      if (!goalEditor) return;
      const prompt = goalEditor.prompt.trim();
      if (!prompt) throw new Error("prompt is required");
      const providerLine = goalEditor.provider ? `provider: ${goalEditor.provider}\n` : "";
      const body = `---\nstatus: ${goalEditor.status}\nschedule: "${goalEditor.schedule}"\n${providerLine}state: {}\n---\n\n${prompt}\n`;
      const relPath = goalEditor.mode === "create"
        ? buildRelPath(name, "goals", goalEditor.name)
        : goalEditor.relPath!;
      if (goalEditor.mode === "create" && !goalEditor.name.trim()) throw new Error("goal name is required");
      await saveTextFile(relPath, body);
      await refresh();
      setGoalEditor(null);
    }, setNotice);

  const saveEnv = () =>
    runAction("env-save", async () => {
      await saveTextFile(scopedRelPath(name, ".env"), envText);
      setEnvInitial(envText);
      setEnvSavedAt(Date.now());
    }, setNotice);

  const claimBadge = useMemo(() => {
    const claim = d?.claim;
    if (!claim) return <span className="badge ok">free</span>;
    if (claim.stale) return <span className="badge warn">stale claim</span>;
    return <span className="badge warn">claimed{claim.owner ? ` by ${claim.owner}` : ""}</span>;
  }, [d?.claim]);

  if (!d) return <div className="muted">Loading...</div>;

  const tabs = [
    { id: "tasks", label: `Tasks${d.cron?.length ? ` (${d.cron.length})` : ""}` },
    { id: "goals", label: `Goals${d.goals?.length ? ` (${d.goals.length})` : ""}` },
    { id: "files", label: "Files" },
    { id: "env", label: "Environment" },
    { id: "runs", label: "Runs" },
    { id: "backlog", label: `Backlog${d.backlog?.length ? ` (${d.backlog.length})` : ""}` },
  ];

  return (
    <div className="col">
      <a onClick={() => navigate("/departments")} className="small">{"\u2190"} Departments</a>

      <div className="page-header">
        <div>
          <h2>{d.displayName || d.name} {claimBadge}</h2>
          {isRootScope && <div className="small muted">Root execution scope</div>}
          <div className="path mono">{d.path}</div>
        </div>
        <div className="page-header-actions">
          <button className="ghost" onClick={() => navigate("/manual")}>Run now</button>
        </div>
      </div>

      {notice && <Banner kind="err" onDismiss={() => setNotice(null)}>{notice}</Banner>}

      <Tabs tabs={tabs} active={tab} onChange={(id) => setTab(id as TabId)} />

      {tab === "tasks" && (
        <Section
          title="Scheduled tasks"
          description={isRootScope ? "Cron files under the root cron/ folder." : "Cron files under this department's cron/ folder."}
          actions={<button className="primary" onClick={openCreateCron}>Add task</button>}
        >
          {!d.cron?.length ? (
            <div className="muted small">No scheduled tasks yet.</div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Schedule</th>
                    <th>Provider</th>
                    <th>Status</th>
                    <th style={{ textAlign: "right" }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {d.cron.map((task) => (
                    <tr key={task.path}>
                      <td><b>{task.name}</b></td>
                      <td title={task.schedule}>{describeCronSchedule(task.schedule)}</td>
                      <td>{task.provider || "-"}</td>
                      <td>
                        {task.paused
                          ? <span className="badge warn">paused</span>
                          : <span className="badge ok">active</span>}
                      </td>
                      <td style={{ textAlign: "right" }}>
                        <div className="row" style={{ justifyContent: "flex-end", gap: 6 }}>
                          <IconButton onClick={() => openEditCron(task)}>Edit</IconButton>
                          <IconButton onClick={() => togglePause(task)}>
                            {task.paused ? "Resume" : "Pause"}
                          </IconButton>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
      )}

      {tab === "goals" && (
        <Section
          title="Goals"
          description={isRootScope ? "Long-running goals under the root goals/ folder." : "Long-running goals under this department's goals/ folder."}
          actions={<button className="primary" onClick={openCreateGoal}>Add goal</button>}
        >
          {!d.goals?.length ? (
            <div className="muted small">No goals yet.</div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Wake schedule</th>
                    <th>Status</th>
                    <th>Provider</th>
                    <th style={{ textAlign: "right" }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {d.goals.map((goal) => (
                    <tr key={goal.path}>
                      <td><b>{goal.name}</b></td>
                      <td title={goal.schedule}>{describeCronSchedule(goal.schedule || "0 9 * * *")}</td>
                      <td>{goal.status}</td>
                      <td>{goal.provider || "-"}</td>
                      <td style={{ textAlign: "right" }}>
                        <IconButton onClick={() => openEditGoal(goal)}>Edit</IconButton>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
      )}

      {tab === "env" && (
        <Section
          title={<span>Environment <DirtyDot dirty={envDirty} /></span>}
          description="One KEY=value per line. Secrets are masked by default."
          actions={
            <>
              <SavedAt at={envSavedAt} />
              <button className="ghost" onClick={() => setEnvRaw((v) => !v)}>
                {envRaw ? "Structured" : "Edit raw"}
              </button>
              {!envRaw && (
                <button className="ghost" onClick={() => setEnvReveal((v) => !v)}>
                  {envReveal ? "Hide values" : "Reveal values"}
                </button>
              )}
              <FeedbackButton
                className="primary"
                state={actions["env-save"] || "idle"}
                idleLabel="Save"
                workingLabel="Saving..."
                okLabel="Saved"
                onClick={saveEnv}
                disabled={!envDirty}
              />
            </>
          }
        >
          {envRaw ? (
            <textarea
              value={envText}
              onChange={(e) => setEnvText(e.target.value)}
              placeholder="KEY=value"
              spellCheck={false}
              className="mono"
            />
          ) : (
            <EnvStructuredEditor value={envText} onChange={setEnvText} reveal={envReveal} />
          )}
        </Section>
      )}

      {tab === "runs" && (
        <Section
          title="Recent runs"
          actions={<a className="small" onClick={() => navigate("/runs")}>View all runs</a>}
        >
          {!d.runs?.length ? (
            <div className="muted small">No runs yet.</div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Started</th>
                    <th>Trigger</th>
                    <th>Status</th>
                    <th style={{ textAlign: "right" }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {d.runs.map((r) => (
                    <tr key={r.id}>
                      <td className="mono small">{new Date(r.started_at).toLocaleString()}</td>
                      <td>{r.trigger}</td>
                      <td>
                        <span className={`badge ${r.status === "succeeded" ? "ok" : r.status === "running" ? "" : "err"}`}>
                          {r.status}
                        </span>
                      </td>
                      <td style={{ textAlign: "right" }}>
                        <IconButton onClick={() => navigate(`/runs/${r.id}`)}>View</IconButton>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
      )}

      {tab === "backlog" && (
        <Section title="Backlog" description="Runs waiting for a free claim.">
          {!d.backlog?.length ? (
            <div className="muted small">Empty.</div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Queued</th>
                    <th>Trigger</th>
                  </tr>
                </thead>
                <tbody>
                  {d.backlog.map((b) => (
                    <tr key={b.id}>
                      <td className="mono small">{new Date(b.queued_at).toLocaleString()}</td>
                      <td>{b.trigger}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
      )}

      {tab === "files" && (
        <FilesTab
          deptName={name}
          query={filesQuery}
          onQueryChange={setFilesQuery}
        />
      )}

      <Drawer
        open={cronEditor != null}
        title={cronEditor?.mode === "create" ? "Add scheduled task" : "Edit scheduled task"}
        onClose={() => setCronEditor(null)}
        footer={cronEditor && (
          <>
            <button className="ghost" onClick={() => setCronEditor(null)}>Cancel</button>
            <FeedbackButton
              className="primary"
              state={actions["cron-save"] || "idle"}
              idleLabel="Save"
              workingLabel="Saving..."
              okLabel="Saved"
              onClick={saveCron}
            />
          </>
        )}
      >
        {cronEditor && (
          <>
            <label className="col">
              <span className="small muted">Name</span>
              <input
                value={cronEditor.name}
                disabled={cronEditor.mode === "edit"}
                onChange={(e) => setCronEditor({ ...cronEditor, name: e.target.value })}
                placeholder="daily-summary"
              />
            </label>
            <ScheduleField
              value={cronEditor.schedule}
              onChange={(schedule) => setCronEditor({ ...cronEditor, schedule })}
            />
            <label className="col">
              <span className="small muted">Provider</span>
              <select
                value={cronEditor.provider}
                onChange={(e) => setCronEditor({ ...cronEditor, provider: e.target.value })}
              >
                <option value="">Default provider</option>
                <option value="claude-code">Claude Code</option>
                <option value="codex">Codex</option>
              </select>
            </label>
            <label className="col drawer-fill">
              <span className="small muted">Prompt</span>
              <textarea
                className="prompt-input"
                value={cronEditor.prompt}
                onChange={(e) => setCronEditor({ ...cronEditor, prompt: e.target.value })}
                placeholder="What should this task do?"
              />
            </label>
          </>
        )}
      </Drawer>

      <Drawer
        open={goalEditor != null}
        title={goalEditor?.mode === "create" ? "Add goal" : "Edit goal"}
        onClose={() => setGoalEditor(null)}
        footer={goalEditor && (
          <>
            <button className="ghost" onClick={() => setGoalEditor(null)}>Cancel</button>
            <FeedbackButton
              className="primary"
              state={actions["goal-save"] || "idle"}
              idleLabel="Save"
              workingLabel="Saving..."
              okLabel="Saved"
              onClick={saveGoal}
            />
          </>
        )}
      >
        {goalEditor && (
          <>
            <label className="col">
              <span className="small muted">Name</span>
              <input
                value={goalEditor.name}
                disabled={goalEditor.mode === "edit"}
                onChange={(e) => setGoalEditor({ ...goalEditor, name: e.target.value })}
                placeholder="ship-v2"
              />
            </label>
            <label className="col">
              <span className="small muted">Status</span>
              <select
                value={goalEditor.status}
                onChange={(e) => setGoalEditor({ ...goalEditor, status: e.target.value })}
              >
                <option value="active">active</option>
                <option value="paused">paused</option>
                <option value="complete">complete</option>
              </select>
            </label>
            <ScheduleField
              label="Wake schedule"
              value={goalEditor.schedule}
              onChange={(schedule) => setGoalEditor({ ...goalEditor, schedule })}
            />
            <label className="col">
              <span className="small muted">Provider</span>
              <select
                value={goalEditor.provider}
                onChange={(e) => setGoalEditor({ ...goalEditor, provider: e.target.value })}
              >
                <option value="">Default provider</option>
                <option value="claude-code">Claude Code</option>
                <option value="codex">Codex</option>
              </select>
            </label>
            <label className="col drawer-fill">
              <span className="small muted">Prompt</span>
              <textarea
                className="prompt-input"
                value={goalEditor.prompt}
                onChange={(e) => setGoalEditor({ ...goalEditor, prompt: e.target.value })}
                placeholder="What outcome should this goal achieve?"
              />
            </label>
          </>
        )}
      </Drawer>
    </div>
  );
}

function EnvStructuredEditor({
  value,
  onChange,
  reveal,
}: {
  value: string;
  onChange: (next: string) => void;
  reveal: boolean;
}) {
  const lines = value.split(/\r?\n/);
  const updateLine = (index: number, nextLine: string) => {
    const copy = lines.slice();
    copy[index] = nextLine;
    onChange(copy.join("\n"));
  };
  const addLine = () => onChange(value.endsWith("\n") || value === "" ? value + "KEY=" : value + "\nKEY=");

  return (
    <div className="col" style={{ gap: 8 }}>
      {lines.map((line, i) => {
        const eq = line.indexOf("=");
        const isPair = eq > 0 && !line.trim().startsWith("#");
        if (!isPair) {
          return (
            <input
              key={i}
              value={line}
              onChange={(e) => updateLine(i, e.target.value)}
              placeholder="# comment or KEY=value"
              className="mono small"
            />
          );
        }
        const key = line.slice(0, eq);
        const val = line.slice(eq + 1);
        return (
          <div key={i} className="row nowrap" style={{ gap: 8 }}>
            <input
              value={key}
              onChange={(e) => updateLine(i, `${e.target.value}=${val}`)}
              placeholder="KEY"
              className="mono"
              style={{ maxWidth: 220 }}
            />
            <input
              type={reveal ? "text" : "password"}
              value={val}
              onChange={(e) => updateLine(i, `${key}=${e.target.value}`)}
              placeholder="value"
              className="mono"
              autoComplete="off"
            />
          </div>
        );
      })}
      <div>
        <button className="ghost" onClick={addLine}>+ Add line</button>
      </div>
    </div>
  );
}

async function loadFile(relPath: string, setter: (text: string) => void, allowMissing = false) {
  try {
    setter(await api<string>(fileUrl(relPath)));
  } catch {
    if (allowMissing) setter("");
  }
}

function fileUrl(relPath: string) {
  return `/api/files/${relPath.split("/").map(encodeURIComponent).join("/")}`;
}

function stripFrontmatter(text: string): string {
  const m = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return m ? text.slice(m[0].length).replace(/^\r?\n/, "").trimEnd() : text.trimEnd();
}

function buildRelPath(dept: string, sub: "cron" | "goals", name: string) {
  const file = name.trim().replace(/[^\w.-]+/g, "-");
  if (dept === "_root") return `${sub}/${file}.md`;
  return `${dept}/${sub}/${file}.md`;
}

function scopedRelPath(dept: string, relPath: string) {
  return dept === "_root" ? relPath : `${dept}/${relPath}`;
}

const VALID_TABS: TabId[] = ["tasks", "goals", "files", "env", "runs", "backlog"];

function readTabFromUrl(): TabId {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get("tab");
  if (raw && VALID_TABS.includes(raw as TabId)) return raw as TabId;
  return "tasks";
}

function readFilesQueryFromUrl(): FilesQuery {
  const params = new URLSearchParams(window.location.search);
  const visibility = params.get("visibility");
  const prefix = params.get("prefix") || undefined;
  const highlight = params.get("highlight") || undefined;
  return {
    visibility: visibility === "private" ? "private" : visibility === "public" ? "public" : undefined,
    prefix,
    highlight,
  };
}

function writeUrlParams(opts: { tab: TabId; files?: FilesQuery }) {
  const url = new URL(window.location.href);
  const params = url.searchParams;
  if (opts.tab === "tasks") params.delete("tab"); else params.set("tab", opts.tab);
  const f = opts.tab === "files" ? opts.files : undefined;
  if (f?.visibility) params.set("visibility", f.visibility); else params.delete("visibility");
  if (f?.prefix) params.set("prefix", f.prefix); else params.delete("prefix");
  if (f?.highlight) params.set("highlight", f.highlight); else params.delete("highlight");
  const next = `${url.pathname}${params.toString() ? `?${params.toString()}` : ""}`;
  window.history.replaceState({}, "", next);
}

