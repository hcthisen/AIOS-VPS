// Execution engine: spawn the provider CLI inside a department folder, stream
// stdout/stderr to disk, commit + push on success, release claims, process backlog.

import { spawn, ChildProcess } from "child_process";
import { mkdir, writeFile, appendFile, readFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";

import { config } from "../config";
import { log } from "../log";
import {
  buildAnthropicAuthEnv, buildOpenAiAuthEnv, buildCommonAuthEnv,
  anthropicAuthDetected, codexAuthDetected,
} from "./provider-auth";
import { Run, createRun, updateRun, runEvents, popBacklog, enqueueBacklog, getRun } from "./runs";
import { claimDepartments, releaseClaimsForRun, expireStaleClaims } from "./claims";
import { pullRepo, gitRun } from "./repo";

export type Provider = "claude-code" | "codex";

export interface RunRequest {
  departments: string[];
  trigger: string;            // e.g. "cron:sample/hello.md"
  prompt: string;
  provider?: Provider;
  metadata?: Record<string, unknown>;
  commitOnSuccess?: boolean;
}

const activeProcesses = new Map<string, ChildProcess>();
let globalPaused = false;

export function setGlobalPause(paused: boolean) {
  globalPaused = paused;
  log.info(`global-pause: ${paused}`);
}

export function isGlobalPaused() { return globalPaused; }

function getDefaultProvider(): Provider {
  return (process.env.AIOS_DEFAULT_PROVIDER as Provider) || "claude-code";
}

async function pickProvider(requested?: Provider): Promise<Provider> {
  const def = requested || getDefaultProvider();
  if (def === "claude-code") {
    if (await anthropicAuthDetected()) return "claude-code";
    if (await codexAuthDetected()) return "codex";
  } else {
    if (await codexAuthDetected()) return "codex";
    if (await anthropicAuthDetected()) return "claude-code";
  }
  return def;
}

function buildEnv(provider: Provider): NodeJS.ProcessEnv {
  return provider === "claude-code" ? buildAnthropicAuthEnv() : buildOpenAiAuthEnv();
}

function cliArgs(provider: Provider, prompt: string): { bin: string; args: string[]; stdin?: string } {
  // Both CLIs accept a headless prompt path. Use stdin to avoid argv-length/escape concerns.
  if (provider === "claude-code") {
    return { bin: "claude", args: ["--print", "--permission-mode", "acceptEdits"], stdin: prompt };
  }
  return { bin: "codex", args: ["exec", "--skip-git-repo-check", "-"], stdin: prompt };
}

export interface StartRunResult { run: Run; accepted: boolean; queued?: boolean; reason?: string; }

export async function startRun(req: RunRequest): Promise<StartRunResult> {
  if (globalPaused) {
    return { run: createRun({ department: req.departments[0] || "unknown", trigger: req.trigger, provider: null, prompt: req.prompt, status: "canceled" }), accepted: false, reason: "global pause" };
  }
  expireStaleClaims();
  const depts = req.departments.length ? req.departments : ["_root"];
  const run = createRun({
    department: depts[0],
    trigger: req.trigger,
    provider: req.provider || null,
    prompt: req.prompt,
    status: "queued",
  });

  const claimed = claimDepartments(depts, run.id);
  if (!claimed) {
    // Queue for the first conflicting dept (heartbeat will retry).
    for (const d of depts) enqueueBacklog(d, req.trigger, { runId: run.id, prompt: req.prompt, provider: req.provider, departments: depts });
    updateRun(run.id, { status: "queued", error: "department busy; queued to backlog" });
    return { run: getRun(run.id)!, accepted: false, queued: true };
  }

  // Kick off async; respond "accepted".
  void actuallyRun(run.id, depts, req).catch((e) => {
    log.error("run error", run.id, e?.message || e);
  });
  return { run: getRun(run.id)!, accepted: true };
}

async function actuallyRun(runId: string, depts: string[], req: RunRequest) {
  const provider = await pickProvider(req.provider);
  const logDir = join(config.logsDir, "runs", runId.slice(0, 2));
  const logPath = join(logDir, `${runId}.log`);
  await mkdir(logDir, { recursive: true });
  await writeFile(logPath, `# run ${runId}\n# trigger ${req.trigger}\n# provider ${provider}\n# dept ${depts.join(",")}\n# started ${new Date().toISOString()}\n\n`);
  updateRun(runId, { status: "running", log_path: logPath, provider });

  // Primary department folder is the cwd.
  const cwd = depts[0] === "_root" ? config.repoDir : join(config.repoDir, depts[0]);
  if (!existsSync(cwd)) {
    await finalize(runId, depts, { exitCode: 1, error: `cwd missing: ${cwd}` });
    return;
  }

  const env = buildEnv(provider);
  const { bin, args, stdin } = cliArgs(provider, req.prompt);

  let child: ChildProcess;
  try {
    child = spawn(bin, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  } catch (e: any) {
    await finalize(runId, depts, { exitCode: 1, error: `spawn failed: ${e?.message || e}` });
    return;
  }
  activeProcesses.set(runId, child);

  const pipe = (chunk: Buffer) => {
    appendFile(logPath, chunk).catch(() => {});
    runEvents.emit("run.output", { runId, chunk: chunk.toString("utf-8") });
  };
  child.stdout?.on("data", pipe);
  child.stderr?.on("data", pipe);

  if (stdin && child.stdin) {
    child.stdin.write(stdin);
    child.stdin.end();
  }

  const exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }> = new Promise((r) => {
    child.on("exit", (code, signal) => r({ code, signal }));
  });
  const { code, signal } = await exit;
  activeProcesses.delete(runId);

  let commitSha: string | null = null;
  if (code === 0 && req.commitOnSuccess !== false) {
    commitSha = await tryCommitAndPush(runId, depts[0], req.trigger).catch((e) => {
      log.warn("commit/push failed", runId, e?.message || e);
      return null;
    });
  }

  const killed = signal === "SIGTERM" || signal === "SIGKILL";
  const status = killed ? "killed" : code === 0 ? "succeeded" : "failed";
  await finalize(runId, depts, {
    exitCode: code ?? -1,
    error: code === 0 ? null : `exit ${code}${signal ? ` sig ${signal}` : ""}`,
    commitSha,
    status,
  });
}

async function finalize(runId: string, depts: string[], info: { exitCode: number; error?: string | null; commitSha?: string | null; status?: Run["status"] }) {
  updateRun(runId, {
    status: info.status ?? (info.exitCode === 0 ? "succeeded" : "failed"),
    ended_at: Date.now(),
    exit_code: info.exitCode,
    error: info.error ?? null,
    commit_sha: info.commitSha ?? null,
  });
  releaseClaimsForRun(runId);
  runEvents.emit("run.finished", { runId });

  // Process any backlog items for these departments.
  for (const d of depts) {
    const next = popBacklog(d);
    if (!next) continue;
    try {
      const payload = JSON.parse(next.payload);
      await startRun({
        departments: payload.departments || [d],
        trigger: `backlog:${next.trigger}`,
        prompt: payload.prompt,
        provider: payload.provider,
      });
    } catch (e: any) {
      log.warn("failed to dispatch backlog item", next.id, e?.message || e);
    }
  }
}

async function tryCommitAndPush(runId: string, dept: string, trigger: string): Promise<string | null> {
  try {
    // Stage everything and check if there's something to commit.
    await gitRun(["add", "-A"]);
    const { stdout: status } = await gitRun(["status", "--porcelain"]);
    if (!status.trim()) return null;
    await gitRun(["commit", "-m", `aios: run ${runId} (${trigger})`]);
    await gitRun(["push", "origin", "HEAD"]).catch(() => {});
    const { stdout } = await gitRun(["rev-parse", "HEAD"]);
    return stdout.trim();
  } catch (e: any) {
    log.warn("git commit/push failed", runId, e?.message || e);
    return null;
  }
}

export function killRun(runId: string): boolean {
  const proc = activeProcesses.get(runId);
  if (!proc) return false;
  try { proc.kill("SIGTERM"); } catch {}
  return true;
}

export function activeProcessCount() { return activeProcesses.size; }
