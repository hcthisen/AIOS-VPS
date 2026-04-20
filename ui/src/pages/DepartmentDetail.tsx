import React, { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { ScheduleField } from "../components/ScheduleField";
import { describeCronSchedule } from "../lib/cron";

type ActionState = "idle" | "working" | "ok" | "error";

export function DepartmentDetail({ name, navigate }: { name: string; navigate: (t: string) => void }) {
  const [d, setD] = useState<any>(null);
  const [envText, setEnvText] = useState("");
  const [selectedCron, setSelectedCron] = useState<string>("");
  const [cronText, setCronText] = useState("");
  const [selectedGoal, setSelectedGoal] = useState<string>("");
  const [goalText, setGoalText] = useState("");
  const [newCron, setNewCron] = useState({ name: "", schedule: "0 * * * *", provider: "", prompt: "" });
  const [newGoal, setNewGoal] = useState({ name: "", status: "active", provider: "", prompt: "" });
  const [notice, setNotice] = useState<string | null>(null);
  const [actions, setActions] = useState<Record<string, ActionState>>({});

  const refresh = () => api(`/api/departments/${encodeURIComponent(name)}`).then(setD);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [name]);

  useEffect(() => {
    loadFile(`${name}/.env`, setEnvText, true);
  }, [name]);

  useEffect(() => {
    if (!d?.cron?.length) {
      setSelectedCron("");
      setCronText("");
      return;
    }
    const exists = d.cron.some((task: any) => task.relPath === selectedCron);
    setSelectedCron(exists ? selectedCron : d.cron[0].relPath);
  }, [d?.cron?.length, selectedCron]);

  useEffect(() => {
    if (!selectedCron) return;
    loadFile(selectedCron, setCronText);
  }, [selectedCron]);

  useEffect(() => {
    if (!d?.goals?.length) {
      setSelectedGoal("");
      setGoalText("");
      return;
    }
    const exists = d.goals.some((goal: any) => goal.relPath === selectedGoal);
    setSelectedGoal(exists ? selectedGoal : d.goals[0].relPath);
  }, [d?.goals?.length, selectedGoal]);

  useEffect(() => {
    if (!selectedGoal) return;
    loadFile(selectedGoal, setGoalText);
  }, [selectedGoal]);

  const selectedCronTask = useMemo(
    () => d?.cron?.find((task: any) => task.relPath === selectedCron) || null,
    [d?.cron, selectedCron],
  );
  const selectedCronSchedule = readScheduleFromMarkdown(cronText) || selectedCronTask?.schedule || "0 * * * *";

  const setActionState = (key: string, state: ActionState) => {
    setActions((current) => ({ ...current, [key]: state }));
  };

  const runAction = async (key: string, work: () => Promise<void>) => {
    setNotice(null);
    setActionState(key, "working");
    try {
      await work();
      setActionState(key, "ok");
      window.setTimeout(() => setActionState(key, "idle"), 1400);
      return true;
    } catch (e: any) {
      setNotice(e.message || String(e));
      setActionState(key, "error");
      window.setTimeout(() => setActionState(key, "idle"), 1800);
      return false;
    }
  };

  const saveTextFile = async (relPath: string, text: string) => {
    await api(fileUrl(relPath), {
      method: "PUT",
      headers: { "Content-Type": "text/plain" },
      body: text,
    });
    await refresh();
  };

  const togglePause = async (relPath: string, paused: boolean) => {
    setNotice(null);
    try {
      await api(`/api/cron/${encodeURIComponent(relPath)}/${paused ? "resume" : "pause"}`, { method: "POST" });
      await refresh();
    } catch (e: any) {
      setNotice(e.message || String(e));
    }
  };

  const createCron = async () => {
    await runAction("cron-create", async () => {
      const fileName = newCron.name.trim().replace(/[^\w.-]+/g, "-");
      if (!fileName || !newCron.prompt.trim()) throw new Error("task name and prompt are required");
      const relPath = `${name}/cron/${fileName}.md`;
      const providerLine = newCron.provider ? `provider: ${newCron.provider}\n` : "";
      const body = `---\nschedule: "${newCron.schedule}"\n${providerLine}---\n\n${newCron.prompt.trim()}\n`;
      await saveTextFile(relPath, body);
      setSelectedCron(relPath);
      setNewCron({ name: "", schedule: "0 * * * *", provider: "", prompt: "" });
    });
  };

  const createGoal = async () => {
    await runAction("goal-create", async () => {
      const fileName = newGoal.name.trim().replace(/[^\w.-]+/g, "-");
      if (!fileName || !newGoal.prompt.trim()) throw new Error("goal name and prompt are required");
      const relPath = `${name}/goals/${fileName}.md`;
      const providerLine = newGoal.provider ? `provider: ${newGoal.provider}\n` : "";
      const body = `---\nstatus: ${newGoal.status}\n${providerLine}state: {}\n---\n\n${newGoal.prompt.trim()}\n`;
      await saveTextFile(relPath, body);
      setSelectedGoal(relPath);
      setNewGoal({ name: "", status: "active", provider: "", prompt: "" });
    });
  };

  if (!d) return <div className="muted">Loading...</div>;

  return (
    <div className="col">
      <a onClick={() => navigate("/departments")} className="small">{"<-"} departments</a>
      <h2>{d.name}</h2>
      <div className="small muted">{d.path}</div>
      {notice && <div className="badge err">{notice}</div>}

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Cron tasks</h3>
        {!d.cron?.length && <div className="muted small">No cron files.</div>}
        {!!d.cron?.length && (
          <table>
            <tbody>
              {d.cron.map((task: any) => (
                <tr key={task.path}>
                  <td><b>{task.name}</b></td>
                  <td>
                    <div>{describeCronSchedule(task.schedule)}</div>
                    <div className="mono small muted">{task.schedule}</div>
                  </td>
                  <td>{task.provider || "-"}</td>
                  <td>{task.paused ? <span className="badge warn">paused</span> : <span className="badge ok">active</span>}</td>
                  <td><a onClick={() => setSelectedCron(task.relPath)}>edit</a></td>
                  <td><a onClick={() => togglePause(task.relPath, !!task.paused)}>{task.paused ? "resume" : "pause"}</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div className="col" style={{ marginTop: 12 }}>
          <div className="row">
            <select value={selectedCron} onChange={(e) => setSelectedCron(e.target.value)}>
              <option value="">-- pick a cron file --</option>
              {d.cron?.map((task: any) => <option key={task.relPath} value={task.relPath}>{task.relPath}</option>)}
            </select>
            <FeedbackButton
              state={actions["cron-save"] || "idle"}
              idleLabel="Save cron"
              workingLabel="Saving..."
              okLabel="Saved"
              onClick={() => selectedCron && runAction("cron-save", async () => { await saveTextFile(selectedCron, cronText); })}
              disabled={!selectedCron}
            />
          </div>
          {!!selectedCron && (
            <ScheduleField
              label="Schedule"
              value={selectedCronSchedule}
              onChange={(next) => setCronText((current) => upsertScheduleInMarkdown(current, next))}
            />
          )}
          <textarea value={cronText} onChange={(e) => setCronText(e.target.value)} placeholder="Cron markdown" />
        </div>

        <div className="col" style={{ marginTop: 12 }}>
          <h4 style={{ margin: 0 }}>Create scheduled task</h4>
          <input value={newCron.name} onChange={(e) => setNewCron({ ...newCron, name: e.target.value })} placeholder="task name" />
          <ScheduleField value={newCron.schedule} onChange={(schedule) => setNewCron({ ...newCron, schedule })} />
          <select value={newCron.provider} onChange={(e) => setNewCron({ ...newCron, provider: e.target.value })}>
            <option value="">default provider</option>
            <option value="claude-code">Claude Code</option>
            <option value="codex">Codex</option>
          </select>
          <textarea value={newCron.prompt} onChange={(e) => setNewCron({ ...newCron, prompt: e.target.value })} placeholder="Prompt" />
          <FeedbackButton
            className="primary"
            state={actions["cron-create"] || "idle"}
            idleLabel="Add scheduled task"
            workingLabel="Adding..."
            okLabel="Added"
            onClick={createCron}
          />
        </div>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Goals</h3>
        {!d.goals?.length && <div className="muted small">No goals.</div>}
        {!!d.goals?.length && (
          <table>
            <tbody>
              {d.goals.map((goal: any) => (
                <tr key={goal.path}>
                  <td><b>{goal.name}</b></td>
                  <td>{goal.status}</td>
                  <td>{goal.provider || "-"}</td>
                  <td><a onClick={() => setSelectedGoal(goal.relPath)}>edit</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div className="col" style={{ marginTop: 12 }}>
          <div className="row">
            <select value={selectedGoal} onChange={(e) => setSelectedGoal(e.target.value)}>
              <option value="">-- pick a goal file --</option>
              {d.goals?.map((goal: any) => <option key={goal.relPath} value={goal.relPath}>{goal.relPath}</option>)}
            </select>
            <FeedbackButton
              state={actions["goal-save"] || "idle"}
              idleLabel="Save goal"
              workingLabel="Saving..."
              okLabel="Saved"
              onClick={() => selectedGoal && runAction("goal-save", async () => { await saveTextFile(selectedGoal, goalText); })}
              disabled={!selectedGoal}
            />
          </div>
          <textarea value={goalText} onChange={(e) => setGoalText(e.target.value)} placeholder="Goal markdown" />
        </div>

        <div className="col" style={{ marginTop: 12 }}>
          <h4 style={{ margin: 0 }}>Create goal</h4>
          <input value={newGoal.name} onChange={(e) => setNewGoal({ ...newGoal, name: e.target.value })} placeholder="goal name" />
          <select value={newGoal.status} onChange={(e) => setNewGoal({ ...newGoal, status: e.target.value })}>
            <option value="active">active</option>
            <option value="paused">paused</option>
            <option value="complete">complete</option>
          </select>
          <select value={newGoal.provider} onChange={(e) => setNewGoal({ ...newGoal, provider: e.target.value })}>
            <option value="">default provider</option>
            <option value="claude-code">Claude Code</option>
            <option value="codex">Codex</option>
          </select>
          <textarea value={newGoal.prompt} onChange={(e) => setNewGoal({ ...newGoal, prompt: e.target.value })} placeholder="Goal prompt" />
          <FeedbackButton
            className="primary"
            state={actions["goal-create"] || "idle"}
            idleLabel="Add goal"
            workingLabel="Adding..."
            okLabel="Added"
            onClick={createGoal}
          />
        </div>
      </div>

      <div className="card col">
        <h3 style={{ marginTop: 0 }}>Environment</h3>
        <textarea value={envText} onChange={(e) => setEnvText(e.target.value)} placeholder="KEY=value" />
        <div className="row">
          <FeedbackButton
            className="primary"
            state={actions["env-save"] || "idle"}
            idleLabel="Save .env"
            workingLabel="Saving..."
            okLabel="Saved"
            onClick={() => runAction("env-save", async () => { await saveTextFile(`${name}/.env`, envText); })}
          />
        </div>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Recent runs</h3>
        {!d.runs?.length && <div className="muted small">No runs yet.</div>}
        {!!d.runs?.length && (
          <table>
            <tbody>
              {d.runs.map((run: any) => (
                <tr key={run.id}>
                  <td className="mono small">{new Date(run.started_at).toLocaleString()}</td>
                  <td>{run.trigger}</td>
                  <td><span className={`badge ${run.status === "succeeded" ? "ok" : run.status === "running" ? "" : "err"}`}>{run.status}</span></td>
                  <td><a onClick={() => navigate(`/runs/${run.id}`)}>view</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Backlog</h3>
        {!d.backlog?.length && <div className="muted small">Empty.</div>}
        {d.backlog?.map((entry: any) => (
          <div key={entry.id} className="small">{entry.trigger} - queued {new Date(entry.queued_at).toLocaleString()}</div>
        ))}
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

function readScheduleFromMarkdown(text: string): string | null {
  const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!frontmatter) return null;
  const match = frontmatter[1].match(/^(schedule|cron):\s*"?([^"\r\n]+)"?\s*$/m);
  return match?.[2]?.trim() || null;
}

function upsertScheduleInMarkdown(text: string, schedule: string) {
  const nextSchedule = schedule.trim() || "0 * * * *";
  const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n?[\s\S]*)$/);
  if (!frontmatter) {
    const body = text.trim();
    return `---\nschedule: "${nextSchedule}"\n---\n\n${body}${body ? "\n" : ""}`;
  }

  let meta = frontmatter[1];
  const body = frontmatter[2].replace(/^\r?\n/, "\n");
  if (/^schedule:/m.test(meta)) {
    meta = meta.replace(/^schedule:\s*.*$/m, `schedule: "${nextSchedule}"`);
  } else if (/^cron:/m.test(meta)) {
    meta = meta.replace(/^cron:\s*.*$/m, `schedule: "${nextSchedule}"`);
  } else {
    meta = `schedule: "${nextSchedule}"\n${meta}`;
  }
  return `---\n${meta}\n---${body.startsWith("\n") ? body : `\n${body}`}`;
}

function FeedbackButton({
  state,
  idleLabel,
  workingLabel,
  okLabel,
  onClick,
  disabled,
  className,
}: {
  state: ActionState;
  idleLabel: string;
  workingLabel: string;
  okLabel: string;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
}) {
  const label = state === "working" ? workingLabel : state === "ok" ? okLabel : idleLabel;
  const classes = [className || "", state === "ok" ? "flash-ok" : "", state === "working" ? "is-working" : ""]
    .filter(Boolean)
    .join(" ");
  return (
    <button className={classes} onClick={onClick} disabled={disabled || state === "working"}>
      {label}
    </button>
  );
}
