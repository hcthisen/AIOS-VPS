// Runs + backlog DAO + tiny in-memory event bus for live streaming.

import { randomBytes } from "crypto";
import { EventEmitter } from "events";
import { db } from "../db";
import { getCurrentCompanyId } from "../company-context";

export type RunStatus = "queued" | "running" | "succeeded" | "failed" | "killed" | "canceled";

export interface Run {
  id: string;
  company_id?: number;
  department: string;
  trigger: string;
  provider: string | null;
  prompt: string | null;
  status: RunStatus;
  started_at: number;
  ended_at: number | null;
  exit_code: number | null;
  error: string | null;
  log_path: string | null;
  commit_sha: string | null;
}

export const runEvents = new EventEmitter();
runEvents.setMaxListeners(128);

export function createRun(input: Omit<Run, "id" | "started_at" | "ended_at" | "exit_code" | "error" | "log_path" | "commit_sha" | "status"> & { status?: RunStatus }): Run {
  const id = randomBytes(8).toString("hex");
  const row: Run = {
    id,
    company_id: getCurrentCompanyId(),
    department: input.department,
    trigger: input.trigger,
    provider: input.provider ?? null,
    prompt: input.prompt ?? null,
    status: input.status ?? "queued",
    started_at: Date.now(),
    ended_at: null,
    exit_code: null,
    error: null,
    log_path: null,
    commit_sha: null,
  };
  db.prepare(`INSERT INTO runs(id, company_id, department, trigger, provider, prompt, status, started_at)
              VALUES(?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, row.company_id, row.department, row.trigger, row.provider, row.prompt, row.status, row.started_at);
  runEvents.emit("run.created", row);
  return row;
}

export function updateRun(id: string, patch: Partial<Run>) {
  const keys = Object.keys(patch) as (keyof Run)[];
  if (!keys.length) return;
  const setClause = keys.map((k) => `${String(k)} = ?`).join(", ");
  const values = keys.map((k) => patch[k] as any);
  db.prepare(`UPDATE runs SET ${setClause} WHERE id = ? AND company_id = ?`).run(...values, id, getCurrentCompanyId());
  runEvents.emit("run.updated", { id, patch });
}

export function getRun(id: string): Run | null {
  return (db.prepare("SELECT * FROM runs WHERE id = ? AND company_id = ?").get(id, getCurrentCompanyId()) as Run | undefined) || null;
}

export function listRuns(opts: { department?: string; limit?: number; offset?: number } = {}): Run[] {
  const limit = Math.min(opts.limit ?? 50, 500);
  const offset = opts.offset ?? 0;
  if (opts.department) {
    return db.prepare("SELECT * FROM runs WHERE company_id = ? AND department = ? ORDER BY started_at DESC LIMIT ? OFFSET ?")
      .all(getCurrentCompanyId(), opts.department, limit, offset) as Run[];
  }
  return db.prepare("SELECT * FROM runs WHERE company_id = ? ORDER BY started_at DESC LIMIT ? OFFSET ?")
    .all(getCurrentCompanyId(), limit, offset) as Run[];
}

export function activeRuns(): Run[] {
  return db.prepare("SELECT * FROM runs WHERE company_id = ? AND status = 'running' ORDER BY started_at DESC")
    .all(getCurrentCompanyId()) as Run[];
}

// ---------- Backlog ----------

export interface BacklogItem {
  id: number;
  company_id?: number;
  department: string;
  trigger: string;
  payload: string;
  queued_at: number;
}

export function enqueueBacklog(department: string, trigger: string, payload: unknown): BacklogItem {
  const queued_at = Date.now();
  const companyId = getCurrentCompanyId();
  const r = db.prepare("INSERT INTO backlog(company_id, department, trigger, payload, queued_at) VALUES(?, ?, ?, ?, ?)")
    .run(companyId, department, trigger, JSON.stringify(payload), queued_at);
  return { id: Number(r.lastInsertRowid), company_id: companyId, department, trigger, payload: JSON.stringify(payload), queued_at };
}

export function popBacklog(department: string): BacklogItem | null {
  const row = db.prepare("SELECT * FROM backlog WHERE company_id = ? AND department = ? ORDER BY id ASC LIMIT 1")
    .get(getCurrentCompanyId(), department) as BacklogItem | undefined;
  if (!row) return null;
  db.prepare("DELETE FROM backlog WHERE id = ?").run(row.id);
  return row;
}

export function listBacklog(): BacklogItem[] {
  return db.prepare("SELECT * FROM backlog WHERE company_id = ? ORDER BY queued_at ASC")
    .all(getCurrentCompanyId()) as BacklogItem[];
}

export function clearBacklog(department?: string) {
  if (department) db.prepare("DELETE FROM backlog WHERE company_id = ? AND department = ?").run(getCurrentCompanyId(), department);
  else db.prepare("DELETE FROM backlog WHERE company_id = ?").run(getCurrentCompanyId());
}
