// Repo management: clone/pull, scaffold new repo, validate aios.yaml.

import { randomBytes } from "crypto";
import { execFile, spawn } from "child_process";
import { promisify } from "util";
import { mkdir, writeFile, readFile, stat, rm } from "fs/promises";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "fs";
import { join, dirname, relative, resolve, sep } from "path";
import matter from "gray-matter";

import { config } from "../config";
import { outboxInstructionsBody } from "./outboxInstructionsBody";
import { anthropicAuthDetected, buildAnthropicAuthEnv, buildCommonAuthEnv, buildOpenAiAuthEnv, codexAuthDetected } from "./provider-auth";
import { cloneUrlWithPat, getGithubCreds, GithubCreds } from "./github";
import { sendNotification } from "./notifications";
import { log } from "../log";

const execFileAsync = promisify(execFile);

export interface AiosYaml {
  version?: string | number;
  rootName?: string;
  root_name?: string;
  departments?: string[];
  ignored?: string[];
  mirrors?: Array<{ source: string; target: string }>;
  notifications?: { default?: string };
}

export interface AiosContextInput {
  organizationName: string;
  deploymentScope: string;
  parentScope?: string;
  scopeSummary: string;
  outsideRepoContext: string;
  sharedConventions: string;
}

export interface RepoSyncResult {
  ok: boolean;
  changed: boolean;
  before: string | null;
  after: string | null;
  upstream: string | null;
  stashed: boolean;
  pushed: boolean;
  remoteWins: boolean;
  blocked?: boolean;
  llmResolved?: boolean;
  error?: string;
}

export interface GitSyncStatus {
  lastRemoteCheckAt: number | null;
  lastRemoteCommit: string | null;
  lastLocalCommit: string | null;
  pendingInboundSync: boolean;
  inProgress: boolean;
  blockedByActiveRuns: boolean;
  lastSuccessAt: number | null;
  lastError: string | null;
  lastConflictResolution: string | null;
}

const DEFAULT_REMOTE_POLL_INTERVAL_MS = Number(process.env.AIOS_GIT_POLL_INTERVAL_MS || 60_000);
const LLM_CONFLICT_TIMEOUT_MS = Number(process.env.AIOS_GIT_CONFLICT_TIMEOUT_MS || 5 * 60_000);
const LLM_CONFLICT_MAX_FILE_BYTES = Number(process.env.AIOS_GIT_CONFLICT_MAX_FILE_BYTES || 200_000);
let gitAskpassPath: string | null = null;
let worktreeBlocked = () => false;
let gitQueue: Promise<unknown> = Promise.resolve();
const gitSyncStatus: GitSyncStatus = {
  lastRemoteCheckAt: null,
  lastRemoteCommit: null,
  lastLocalCommit: null,
  pendingInboundSync: false,
  inProgress: false,
  blockedByActiveRuns: false,
  lastSuccessAt: null,
  lastError: null,
  lastConflictResolution: null,
};

async function pathExists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

export async function gitRun(args: string[], cwd = config.repoDir, env: NodeJS.ProcessEnv = buildGitEnv()) {
  return execFileAsync("git", args, { cwd, env });
}

function repoPathspecs(paths: string[]): string[] {
  const repoRoot = resolve(config.repoDir);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of paths) {
    const abs = resolve(repoRoot, raw);
    const rel = relative(repoRoot, abs);
    if (!rel || rel === "" || rel.startsWith("..") || resolve(repoRoot, rel) !== abs) continue;
    const spec = rel.split(sep).join("/");
    if (seen.has(spec)) continue;
    seen.add(spec);
    out.push(spec);
  }
  return out;
}

export async function commitRepoPaths(paths: string[], message: string): Promise<string | null> {
  if (worktreeBlocked()) throw new Error("repo is busy with active agent work");
  const pathspecs = repoPathspecs(paths);
  if (!pathspecs.length) return null;

  const { stdout: status } = await gitRun(["status", "--porcelain", "--", ...pathspecs]);
  if (!status.trim()) return null;

  const tmpDir = join(config.dataDir, "tmp");
  await mkdir(tmpDir, { recursive: true });
  const tmpIndex = join(tmpDir, `git-index-${Date.now()}-${randomBytes(4).toString("hex")}`);
  const tempEnv = {
    ...buildGitEnv(),
    GIT_INDEX_FILE: tmpIndex,
  };

  try {
    try {
      await gitRun(["rev-parse", "--verify", "HEAD"], config.repoDir, tempEnv);
      await gitRun(["read-tree", "HEAD"], config.repoDir, tempEnv);
    } catch {
      // Empty repository; commit from an empty temporary index.
    }

    await gitRun(["add", "--", ...pathspecs], config.repoDir, tempEnv);
    const { stdout: staged } = await gitRun(["diff", "--cached", "--name-only", "--", ...pathspecs], config.repoDir, tempEnv);
    if (!staged.trim()) return null;

    await gitRun(["commit", "-m", message], config.repoDir, tempEnv);
    await gitRun(["add", "--", ...pathspecs]).catch(() => {});
    await syncRepoWithRemote({ notifyOnRemoteWins: true });
    const { stdout: head } = await gitRun(["rev-parse", "HEAD"]);
    return head.trim();
  } finally {
    await rm(tmpIndex, { force: true }).catch(() => {});
  }
}

export async function commitRepoSnapshot(message: string): Promise<string | null> {
  if (worktreeBlocked()) throw new Error("repo is busy with active agent work");
  await gitRun(["add", "-A"]);
  const { stdout: status } = await gitRun(["status", "--porcelain"]);
  if (!status.trim()) return null;
  await gitRun(["commit", "-m", message]);
  const sync = await syncRepoWithRemote({ notifyOnRemoteWins: true });
  if (!sync.ok) throw new Error(sync.error || "git sync failed after commit");
  const { stdout } = await gitRun(["rev-parse", "HEAD"]);
  return stdout.trim();
}

export function setGitWorktreeBlocked(fn: () => boolean) {
  worktreeBlocked = fn;
}

export function isGitWorktreeBlocked(): boolean {
  return worktreeBlocked();
}

export function getGitSyncStatus(): GitSyncStatus {
  return { ...gitSyncStatus, blockedByActiveRuns: worktreeBlocked() };
}

export function markInboundSyncPending(reason = "inbound change") {
  gitSyncStatus.pendingInboundSync = true;
  gitSyncStatus.lastConflictResolution = reason;
}

export async function checkRemoteForUpdates(opts: { force?: boolean } = {}): Promise<{
  checked: boolean;
  changed: boolean;
  blocked: boolean;
  remoteCommit: string | null;
  localCommit: string | null;
}> {
  const now = Date.now();
  if (!opts.force && gitSyncStatus.lastRemoteCheckAt && now - gitSyncStatus.lastRemoteCheckAt < DEFAULT_REMOTE_POLL_INTERVAL_MS) {
    return {
      checked: false,
      changed: gitSyncStatus.pendingInboundSync,
      blocked: worktreeBlocked(),
      remoteCommit: gitSyncStatus.lastRemoteCommit,
      localCommit: gitSyncStatus.lastLocalCommit,
    };
  }

  return withGitQueue(async () => {
    if (!existsSync(join(config.repoDir, ".git"))) {
      gitSyncStatus.lastError = "repo not cloned";
      return { checked: true, changed: false, blocked: worktreeBlocked(), remoteCommit: null, localCommit: null };
    }
    gitSyncStatus.lastRemoteCheckAt = Date.now();
    await gitRun(["fetch", "origin", "--prune"]);
    const upstream = await resolveUpstream();
    const [remoteCommit, localCommit] = await Promise.all([
      revParse(upstream),
      revParse("HEAD"),
    ]);
    gitSyncStatus.lastRemoteCommit = remoteCommit;
    gitSyncStatus.lastLocalCommit = localCommit;
    const changed = remoteCommit !== localCommit;
    if (changed) gitSyncStatus.pendingInboundSync = true;
    return {
      checked: true,
      changed,
      blocked: worktreeBlocked(),
      remoteCommit,
      localCommit,
    };
  });
}

export async function reconcilePendingRepoSync(reason = "pending sync"): Promise<RepoSyncResult | null> {
  if (!gitSyncStatus.pendingInboundSync) return null;
  if (worktreeBlocked()) {
    gitSyncStatus.blockedByActiveRuns = true;
    return {
      ok: true,
      changed: false,
      before: await repoHead(),
      after: await repoHead(),
      upstream: null,
      stashed: false,
      pushed: false,
      remoteWins: false,
      blocked: true,
    };
  }
  gitSyncStatus.lastConflictResolution = reason;
  return syncRepoWithRemote({ notifyOnRemoteWins: true });
}

async function withGitQueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = gitQueue.then(fn, fn);
  gitQueue = run.then(() => undefined, () => undefined);
  return run;
}

function buildGitEnv(): NodeJS.ProcessEnv {
  const creds = getGithubCreds();
  const env = buildCommonAuthEnv();
  const gitName = process.env.GIT_AUTHOR_NAME
    || process.env.GIT_COMMITTER_NAME
    || creds?.username
    || "AIOS";
  const gitEmail = process.env.GIT_AUTHOR_EMAIL
    || process.env.GIT_COMMITTER_EMAIL
    || (creds?.username ? `${creds.username}@users.noreply.github.com` : "aios@local.invalid");
  const gitEnv: NodeJS.ProcessEnv = {
    ...env,
    GIT_AUTHOR_NAME: gitName,
    GIT_AUTHOR_EMAIL: gitEmail,
    GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || gitName,
    GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL || gitEmail,
  };
  if (creds?.mode === "deploy_key" && creds.privateKeyPath) {
    return {
      ...gitEnv,
      GIT_SSH_COMMAND: `ssh -i "${creds.privateKeyPath}" -o StrictHostKeyChecking=accept-new`,
    };
  }
  if (creds?.mode === "pat" && creds.username && creds.token) {
    return {
      ...gitEnv,
      GIT_ASKPASS: ensureGitAskpassScript(),
      GIT_TERMINAL_PROMPT: "0",
      AIOS_GIT_USERNAME: creds.username,
      AIOS_GIT_PASSWORD: creds.token,
    };
  }
  return gitEnv;
}

function ensureGitAskpassScript(): string {
  if (gitAskpassPath && existsSync(gitAskpassPath)) return gitAskpassPath;
  const suffix = process.platform === "win32" ? ".cmd" : ".sh";
  const path = join(config.dataDir, `git-askpass${suffix}`);
  if (process.platform === "win32") {
    try { mkdirSync(dirname(path), { recursive: true }); } catch {}
    writeFileSync(path, [
      "@echo off",
      "echo %1 | findstr /i \"username\" >nul",
      "if %errorlevel%==0 (",
      "  echo %AIOS_GIT_USERNAME%",
      ") else (",
      "  echo %AIOS_GIT_PASSWORD%",
      ")",
      "",
    ].join("\r\n"), "utf-8");
  } else {
    try { mkdirSync(dirname(path), { recursive: true }); } catch {}
    writeFileSync(path, [
      "#!/usr/bin/env sh",
      "case \"$1\" in",
      "  *sername*) printf '%s\\n' \"$AIOS_GIT_USERNAME\" ;;",
      "  *) printf '%s\\n' \"$AIOS_GIT_PASSWORD\" ;;",
      "esac",
      "",
    ].join("\n"), "utf-8");
    try { chmodSync(path, 0o700); } catch {}
  }
  gitAskpassPath = path;
  return path;
}

export async function cloneRepo(input: {
  cloneUrl: string; creds: GithubCreds;
}): Promise<{ ok: true; commit: string } | { ok: false; error: string }> {
  try {
    await mkdir(dirname(config.repoDir), { recursive: true });
    const useDeployKey = input.creds.mode === "deploy_key" && !!input.creds.privateKeyPath;
    const url = input.creds.mode === "pat" && input.creds.username && input.creds.token
      ? cloneUrlWithPat(input.cloneUrl, input.creds.username, input.creds.token)
      : useDeployKey && input.cloneUrl.startsWith("https://github.com/")
        ? input.cloneUrl.replace(/^https:\/\/github\.com\//, "git@github.com:")
        : input.cloneUrl;
    const env = useDeployKey
      ? {
          ...buildCommonAuthEnv(),
          GIT_SSH_COMMAND: `ssh -i "${input.creds.privateKeyPath}" -o StrictHostKeyChecking=accept-new`,
        }
      : buildGitEnv();
    if (existsSync(join(config.repoDir, ".git"))) {
      await gitRun(["pull", "--ff-only"], config.repoDir, env);
    } else {
      await execFileAsync("git", ["clone", url, config.repoDir], { env });
    }
    const { stdout } = await gitRun(["rev-parse", "HEAD"], config.repoDir, env);
    return { ok: true, commit: stdout.trim() };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e).slice(0, 300) };
  }
}

export async function pullRepo(): Promise<{ ok: true; changed: boolean; commit: string } | { ok: false; error: string }> {
  const sync = await syncRepoWithRemote({ notifyOnRemoteWins: true });
  if (!sync.ok) return { ok: false, error: sync.error || "git sync failed" };
  return { ok: true, changed: sync.changed, commit: sync.after || "" };
}

export async function syncRepoWithRemote(opts: { notifyOnRemoteWins?: boolean; allowWhenBlocked?: boolean } = {}): Promise<RepoSyncResult> {
  return withGitQueue(async () => {
    if (!opts.allowWhenBlocked && worktreeBlocked()) {
      gitSyncStatus.pendingInboundSync = true;
      gitSyncStatus.blockedByActiveRuns = true;
      return {
        ok: true,
        changed: false,
        before: await repoHead(),
        after: await repoHead(),
        upstream: null,
        stashed: false,
        pushed: false,
        remoteWins: false,
        blocked: true,
      };
    }

    gitSyncStatus.inProgress = true;
    gitSyncStatus.blockedByActiveRuns = false;
    try {
      const result = await syncRepoWithRemoteUnlocked(opts);
      gitSyncStatus.lastLocalCommit = result.after;
      if (result.upstream) gitSyncStatus.lastRemoteCommit = await revParse(result.upstream).catch(() => gitSyncStatus.lastRemoteCommit);
      if (result.ok) {
        gitSyncStatus.pendingInboundSync = false;
        gitSyncStatus.lastSuccessAt = Date.now();
        gitSyncStatus.lastError = null;
      } else {
        gitSyncStatus.lastError = result.error || "git sync failed";
      }
      if (result.remoteWins) gitSyncStatus.lastConflictResolution = "remote-wins";
      if (result.llmResolved) gitSyncStatus.lastConflictResolution = "llm-resolved";
      return result;
    } finally {
      gitSyncStatus.inProgress = false;
    }
  });
}

async function syncRepoWithRemoteUnlocked(opts: { notifyOnRemoteWins?: boolean; allowWhenBlocked?: boolean } = {}): Promise<RepoSyncResult> {
  let before: string | null = null;
  let upstream: string | null = null;
  let stashRef: string | null = null;
  let stashed = false;
  let pushed = false;
  try {
    if (!existsSync(join(config.repoDir, ".git"))) {
      return {
        ok: false,
        changed: false,
        before: null,
        after: null,
        upstream: null,
        stashed: false,
        pushed: false,
        remoteWins: false,
        error: "repo not cloned",
      };
    }
    before = (await gitRun(["rev-parse", "HEAD"])).stdout.trim();
    await gitRun(["fetch", "origin", "--prune"]);
    upstream = await resolveUpstream();

    const status = (await gitRun(["status", "--porcelain"])).stdout;
    if (status.trim()) {
      const message = `aios-pre-sync-${Date.now()}`;
      const stashOut = await gitRun(["stash", "push", "-u", "-m", message]);
      if (!/No local changes/i.test(stashOut.stdout)) {
        const top = (await gitRun(["stash", "list", "--format=%H%x00%gs", "-n", "1"])).stdout.trim();
        if (top.includes(message)) {
          stashRef = "stash@{0}";
          stashed = true;
        }
      }
    }

    await gitRun(["rebase", upstream]);
    if (stashed) {
      await gitRun(["stash", "pop", stashRef || "stash@{0}"]);
      stashRef = null;
    }

    const ahead = await isAheadOf(upstream);
    if (ahead) {
      pushed = await pushWithRetry(upstream);
    }

    const after = (await gitRun(["rev-parse", "HEAD"])).stdout.trim();
    return {
      ok: true,
      changed: before !== after || pushed,
      before,
      after,
      upstream,
      stashed,
      pushed,
      remoteWins: false,
    };
  } catch (e: any) {
    const error = gitError(e);
    if (upstream) {
      const llm = await tryResolveConflictsWithLlm(upstream, error);
      if (llm.resolved) {
        const ahead = await isAheadOf(upstream);
        if (ahead) pushed = await pushWithRetry(upstream);
        const after = (await gitRun(["rev-parse", "HEAD"])).stdout.trim();
        return {
          ok: true,
          changed: true,
          before,
          after,
          upstream,
          stashed,
          pushed,
          remoteWins: false,
          llmResolved: true,
        };
      }
      const reset = await resetToRemote(upstream, stashRef, error, opts.notifyOnRemoteWins !== false);
      return {
        ...reset,
        before,
        upstream,
        stashed,
        pushed,
      };
    }
    return {
      ok: false,
      changed: false,
      before,
      after: before,
      upstream,
      stashed,
      pushed,
      remoteWins: false,
      error,
    };
  }
}

async function resolveUpstream(): Promise<string> {
  const configured = await gitRun(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])
    .then((r) => r.stdout.trim())
    .catch(() => "");
  if (configured) return configured;

  const branch = await gitRun(["branch", "--show-current"])
    .then((r) => r.stdout.trim())
    .catch(() => "");
  if (branch && await refExists(`origin/${branch}`)) return `origin/${branch}`;

  const originHead = await gitRun(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"])
    .then((r) => r.stdout.trim())
    .catch(() => "");
  if (originHead) return originHead;

  throw new Error("cannot determine Git upstream");
}

async function refExists(ref: string): Promise<boolean> {
  return gitRun(["rev-parse", "--verify", ref])
    .then(() => true)
    .catch(() => false);
}

async function revParse(ref: string): Promise<string> {
  const { stdout } = await gitRun(["rev-parse", ref]);
  return stdout.trim();
}

async function isAheadOf(upstream: string): Promise<boolean> {
  const { stdout } = await gitRun(["rev-list", "--left-right", "--count", `${upstream}...HEAD`]);
  const [, ahead] = stdout.trim().split(/\s+/).map((n) => Number(n) || 0);
  return ahead > 0;
}

async function pushWithRetry(upstream: string): Promise<boolean> {
  try {
    await gitRun(["push", "origin", "HEAD"]);
    return true;
  } catch {
    await gitRun(["fetch", "origin", "--prune"]);
    await gitRun(["rebase", upstream]);
    await gitRun(["push", "origin", "HEAD"]);
    return true;
  }
}

async function tryResolveConflictsWithLlm(upstream: string, error: string): Promise<{ resolved: boolean; error?: string }> {
  const files = await conflictedTextFiles();
  if (!files.ok) return { resolved: false, error: files.error };
  if (!files.paths.length) return { resolved: false, error: "no resolvable conflicts" };

  const provider = await chooseConflictProvider();
  if (!provider) return { resolved: false, error: "no authorized CLI provider for conflict resolution" };

  const prompt = [
    "You are resolving Git merge conflicts in an AIOS repository.",
    "Only edit the conflicted files listed below. Do not make unrelated changes.",
    "Preserve operator-authored intent from both sides where possible.",
    "Remove all conflict markers, leave valid text/markdown/json/yaml/typescript as appropriate, and stage the resolved files with git add.",
    "",
    `Upstream: ${upstream}`,
    `Git failure: ${error}`,
    "",
    "Conflicted files:",
    ...files.paths.map((p) => `- ${p}`),
    "",
    "After resolving, run lightweight checks if useful, but do not commit or push.",
  ].join("\n");

  const run = await runConflictCli(provider, prompt);
  if (!run.ok) {
    await writeConflictBundle(error, files.paths, run.error || "LLM resolver failed").catch(() => {});
    return { resolved: false, error: run.error || "LLM resolver failed" };
  }

  try {
    await gitRun(["add", "--", ...files.paths]);
    await verifyConflictResolution(files.paths);
    if (await rebaseInProgress()) {
      await gitRun(["-c", "core.editor=true", "rebase", "--continue"]);
    } else {
      const { stdout } = await gitRun(["status", "--porcelain"]);
      if (stdout.trim()) {
        await gitRun(["commit", "-m", "aios: resolve GitHub sync conflict"]);
      }
    }
    return { resolved: true };
  } catch (e: any) {
    const detail = gitError(e);
    await writeConflictBundle(error, files.paths, detail).catch(() => {});
    return { resolved: false, error: detail };
  }
}

async function conflictedTextFiles(): Promise<{ ok: true; paths: string[] } | { ok: false; paths: string[]; error: string }> {
  const { stdout } = await gitRun(["diff", "--name-only", "--diff-filter=U"]);
  const paths = stdout.split(/\r?\n/).map((p) => p.trim()).filter(Boolean);
  const accepted: string[] = [];
  for (const rel of paths) {
    const abs = resolve(config.repoDir, rel);
    if (!abs.startsWith(resolve(config.repoDir))) return { ok: false, paths: accepted, error: `path escapes repo: ${rel}` };
    if (/(^|\/)\.env($|\.)|secret|private[_-]?key/i.test(rel.replace(/\\/g, "/"))) {
      return { ok: false, paths: accepted, error: `refusing secret-like conflict path: ${rel}` };
    }
    const s = await stat(abs).catch(() => null);
    if (!s?.isFile()) return { ok: false, paths: accepted, error: `not a regular file: ${rel}` };
    if (s.size > LLM_CONFLICT_MAX_FILE_BYTES) return { ok: false, paths: accepted, error: `conflict file too large: ${rel}` };
    const sample = await readFile(abs);
    if (sample.includes(0)) return { ok: false, paths: accepted, error: `binary conflict file: ${rel}` };
    accepted.push(rel);
  }
  return { ok: true, paths: accepted };
}

async function chooseConflictProvider(): Promise<"codex" | "claude-code" | null> {
  const configured = String(process.env.AIOS_GIT_CONFLICT_PROVIDER || "").trim();
  if (configured === "codex" && await codexAuthDetected()) return "codex";
  if (configured === "claude-code" && await anthropicAuthDetected()) return "claude-code";
  if (await codexAuthDetected()) return "codex";
  if (await anthropicAuthDetected()) return "claude-code";
  return null;
}

async function runConflictCli(provider: "codex" | "claude-code", prompt: string): Promise<{ ok: boolean; error?: string }> {
  const env = provider === "codex" ? buildOpenAiAuthEnv() : buildAnthropicAuthEnv();
  const bin = provider === "codex" ? "codex" : "claude";
  const args = provider === "codex"
    ? ["exec", "--skip-git-repo-check", "--sandbox", "danger-full-access", "-"]
    : ["--print", "--permission-mode", "acceptEdits"];

  return new Promise((resolveRun) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(bin, args, { cwd: config.repoDir, env, stdio: ["pipe", "pipe", "pipe"] });
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      resolveRun({ ok: false, error: "LLM conflict resolver timed out" });
    }, LLM_CONFLICT_TIMEOUT_MS);
    child.stdout?.on("data", (chunk) => { stdout += chunk.toString("utf-8"); });
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString("utf-8"); });
    child.on("error", (e) => {
      clearTimeout(timeout);
      resolveRun({ ok: false, error: String(e?.message || e) });
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) resolveRun({ ok: true });
      else resolveRun({ ok: false, error: `LLM resolver exit ${code}${signal ? ` sig ${signal}` : ""}\n${stderr || stdout}`.slice(0, 1000) });
    });
    child.stdin?.write(prompt);
    child.stdin?.end();
  });
}

async function verifyConflictResolution(paths: string[]) {
  const unresolved = (await gitRun(["diff", "--name-only", "--diff-filter=U"])).stdout.trim();
  if (unresolved) throw new Error(`unmerged files remain: ${unresolved}`);
  await gitRun(["diff", "--check"]);
  for (const rel of paths) {
    const raw = await readFile(join(config.repoDir, rel), "utf-8").catch(() => "");
    if (/^(<<<<<<<|=======|>>>>>>>) /m.test(raw)) {
      throw new Error(`conflict markers remain in ${rel}`);
    }
  }
}

async function rebaseInProgress(): Promise<boolean> {
  const rebaseMerge = await gitRun(["rev-parse", "--git-path", "rebase-merge"]).then((r) => r.stdout.trim()).catch(() => "");
  const rebaseApply = await gitRun(["rev-parse", "--git-path", "rebase-apply"]).then((r) => r.stdout.trim()).catch(() => "");
  return (!!rebaseMerge && existsSync(resolveGitPath(rebaseMerge)))
    || (!!rebaseApply && existsSync(resolveGitPath(rebaseApply)));
}

function resolveGitPath(path: string): string {
  return resolve(path) === path ? path : join(config.repoDir, path);
}

async function writeConflictBundle(error: string, paths: string[], resolverError: string) {
  const dir = join(config.logsDir, "git-conflicts");
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${Date.now()}.json`);
  await writeFile(path, `${JSON.stringify({ error, resolverError, paths, at: new Date().toISOString() }, null, 2)}\n`, "utf-8");
}

async function resetToRemote(
  upstream: string,
  stashRef: string | null,
  error: string,
  notify: boolean,
): Promise<RepoSyncResult> {
  await gitRun(["rebase", "--abort"]).catch(() => {});
  await gitRun(["merge", "--abort"]).catch(() => {});
  await gitRun(["reset", "--hard", upstream]);
  await gitRun(["clean", "-fd"]);
  if (stashRef) await gitRun(["stash", "drop", stashRef]).catch(() => {});
  const after = (await gitRun(["rev-parse", "HEAD"])).stdout.trim();
  const message = [
    "AIOS Git sync could not reconcile local VPS changes with GitHub.",
    "",
    `Remote won: reset checkout to ${upstream} at ${after}.`,
    `Failure: ${error}`,
  ].join("\n");
  log.warn("repo sync: remote won", error);
  if (notify) {
    await sendNotification(message, "AIOS Git sync reset to GitHub").catch(() => {});
  }
  return {
    ok: true,
    changed: true,
    before: null,
    after,
    upstream,
    stashed: !!stashRef,
    pushed: false,
    remoteWins: true,
    error,
  };
}

function gitError(e: any): string {
  const text = [e?.message, e?.stderr, e?.stdout]
    .filter(Boolean)
    .join("\n")
    .trim();
  return text.slice(0, 1000) || String(e || "git failed");
}

export async function readAiosYaml(): Promise<AiosYaml | null> {
  const path = join(config.repoDir, "aios.yaml");
  if (!existsSync(path)) return null;
  const raw = await readFile(path, "utf-8");
  return parseSimpleYaml(raw);
}

// --- intentionally tiny YAML parser, scoped to aios.yaml shape ---
// aios.yaml is shallow: keys, lists, and simple scalars. Keeps us off a dep.
function parseSimpleYaml(text: string): AiosYaml {
  const out: any = {};
  const lines = text.split(/\r?\n/);
  let currentList: any[] | null = null;
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const listMatch = line.match(/^\s+-\s+(.+)$/);
    if (listMatch && currentList) {
      currentList.push(stripQuotes(listMatch[1]));
      continue;
    }
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!kv) continue;
    const [, key, value] = kv;
    if (value === "" || value === null) {
      currentList = [];
      out[key] = currentList;
    } else if (/^\[.*\]$/.test(value.trim())) {
      out[key] = value.trim().slice(1, -1).split(",").map((s) => stripQuotes(s.trim())).filter(Boolean);
      currentList = null;
    } else {
      out[key] = coerce(stripQuotes(value));
      currentList = null;
    }
  }
  return out;
}

function stripQuotes(s: string) {
  if ((s.startsWith("\"") && s.endsWith("\"")) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function coerce(s: string): any {
  if (s === "true") return true;
  if (s === "false") return false;
  if (/^-?\d+$/.test(s)) return Number(s);
  return s;
}

function yamlQuote(value: string) {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function trimParagraph(value: string, fallback: string) {
  const trimmed = String(value || "").trim();
  return trimmed || fallback;
}

function buildDefaultContext(name: string): AiosContextInput {
  return {
    organizationName: name,
    deploymentScope: name,
    parentScope: "",
    scopeSummary: `This AIOS deployment manages ${name}. Use it as the source of truth for the teams and automations that live in this repository.`,
    outsideRepoContext: "Describe the broader organization, adjacent teams, systems, or responsibilities that exist outside this repository.",
    sharedConventions: "Document shared conventions, approval rules, tone, compliance requirements, and other guidance every department should inherit.",
  };
}

export function rootDisplayNameFromYaml(y: AiosYaml | null | undefined): string {
  return String(y?.rootName || y?.root_name || "Root").trim() || "Root";
}

function buildRootOrgMd(input: AiosContextInput): string {
  const parentScope = String(input.parentScope || "").trim();
  return `---
organization_name: ${yamlQuote(input.organizationName)}
deployment_scope: ${yamlQuote(input.deploymentScope)}
parent_scope: ${yamlQuote(parentScope)}
---
# Organization context

## Organization
${trimParagraph(input.organizationName, "Describe the organization this AIOS belongs to.")}

## AIOS deployment scope
${trimParagraph(input.scopeSummary, "Describe the part of the organization this AIOS is responsible for.")}

## Parent organization or department
${trimParagraph(parentScope, "This AIOS is deployed at the organization root.")}

## Outside this repository
${trimParagraph(input.outsideRepoContext, "List the teams, systems, or responsibilities that sit outside this repository but may matter to the work here.")}

## Shared conventions
${trimParagraph(input.sharedConventions, "List the conventions, constraints, and expectations every department in this AIOS should follow.")}
`;
}

function buildRootContextMd(input: AiosContextInput): string {
  const parentScope = String(input.parentScope || "").trim();
  const parentLine = parentScope
    ? `- This AIOS sits inside ${parentScope}.`
    : "- This AIOS is the root operating scope for this repository.";
  return `# Root context - ${input.deploymentScope}

One-line summary: AIOS workspace for ${input.deploymentScope} in ${input.organizationName}.

## Scope of this repository
- This repository serves ${input.deploymentScope}.
${parentLine}
- Root-level folders listed in \`aios.yaml\` are departments within this AIOS deployment.

## Shared context files
- \`org.md\` is the authored organization and deployment context for the whole AIOS.
- Every department receives a synced copy of \`org.md\` so shared context is available from inside the folder.
- Every department also receives an auto-generated \`_org.md\` listing sibling departments and their one-line summaries.

## Department conventions
- Keep department-specific instructions in each department's \`CLAUDE.md\` and \`AGENTS.md\`.
- Put scheduled prompts in \`cron/*.md\` with a \`schedule\` frontmatter field.
- Put long-running objectives and recurring work in \`goals/\`.
- Put reusable local skills in \`skills/\`.

## Cross-department work
- Start from the local department folder and only leave it when the task clearly requires cross-department context or collaboration.
- Use \`org.md\` to understand the larger business context.
- Use \`_org.md\` to discover which sibling departments exist before reading outside the current folder.

${managedOwnerNotificationsBlock()}
`;
}

export function buildDepartmentContextMd(name: string): string {
  return `# ${name} department - Department responsible for ${name} work in this AIOS deployment

One-line summary: ${name} is a department inside this AIOS deployment and owns the work routed into this folder.

## Role in this deployment
- This folder is one department inside a larger AIOS deployment, which may itself be only one part of a larger company or parent department.
- Keep the information this department always needs inside this folder.
- Use shared context files when work needs organizational awareness outside this folder.

## Local structure
- \`cron/\`: scheduled prompts for recurring work. Each markdown file is a task with frontmatter such as \`schedule: "0 * * * *"\`.
- \`goals/\`: long-running goals, standing objectives, or recurring work definitions.
- \`skills/\`: reusable local skills and operating procedures for this department.
- \`logs/\`: optional local logs or generated artifacts when the department needs them.

## Shared context
- \`org.md\`: authored organization and deployment-scope context copied from the repo root.
- \`_org.md\`: auto-generated map of sibling departments and their one-line summaries.
- Read both before coordinating outside this folder.

## Cross-department work
- Start from this folder's files and solve the task locally when possible.
- If the task depends on another department, use \`_org.md\` to discover the right folder and then inspect that folder directly.
- Do not assume shared knowledge that is not written in this folder, \`org.md\`, or the target department's files.

${managedOwnerNotificationsBlock()}
`;
}

function managedOwnerNotificationsBlock(): string {
  return `<!-- aios:managed:owner-notifications start -->
${outboxInstructionsBody()}
<!-- aios:managed:owner-notifications end -->`;
}

function extractSection(content: string, heading: string): string | undefined {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = content.match(new RegExp(`## ${escaped}\\r?\\n([\\s\\S]*?)(?=\\n## |$)`));
  return match?.[1]?.trim() || undefined;
}

export async function readRepoContext(dir: string, fallbackName = "AIOS deployment"): Promise<AiosContextInput> {
  const defaults = buildDefaultContext(fallbackName);
  const orgPath = join(dir, "org.md");
  if (!existsSync(orgPath)) return defaults;
  const raw = await readFile(orgPath, "utf-8");
  const parsed = matter(raw);
  const frontmatter = parsed.data as Record<string, unknown>;
  return {
    organizationName: String(frontmatter.organization_name || defaults.organizationName).trim(),
    deploymentScope: String(frontmatter.deployment_scope || defaults.deploymentScope).trim(),
    parentScope: String(frontmatter.parent_scope || "").trim(),
    scopeSummary: extractSection(parsed.content, "AIOS deployment scope") || defaults.scopeSummary,
    outsideRepoContext: extractSection(parsed.content, "Outside this repository") || defaults.outsideRepoContext,
    sharedConventions: extractSection(parsed.content, "Shared conventions") || defaults.sharedConventions,
  };
}

export async function writeRepoContext(dir: string, input: AiosContextInput): Promise<void> {
  const normalized: AiosContextInput = {
    organizationName: trimParagraph(input.organizationName, "AIOS deployment"),
    deploymentScope: trimParagraph(input.deploymentScope, trimParagraph(input.organizationName, "AIOS deployment")),
    parentScope: String(input.parentScope || "").trim(),
    scopeSummary: trimParagraph(input.scopeSummary, "Describe what this AIOS deployment is responsible for."),
    outsideRepoContext: trimParagraph(input.outsideRepoContext, "Describe the broader organization outside this repository."),
    sharedConventions: trimParagraph(input.sharedConventions, "Describe the conventions every department should follow."),
  };
  await writeFile(join(dir, "org.md"), buildRootOrgMd(normalized));
  const rootContext = buildRootContextMd(normalized);
  await writeFile(join(dir, "CLAUDE.md"), rootContext);
  await writeFile(join(dir, "AGENTS.md"), rootContext);
}

export function buildDefaultReadmeMd(name: string): string {
  return `# ${name}

AIOS turns this Git repository into an autonomous operating workspace: the root scope and each department folder contain the instructions, schedules, goals, skills, environment files, and outputs used by dashboard-triggered Claude Code or Codex runs, while Git remains the source of truth.

## How AIOS Operates

- Heartbeat: runs about once per minute after onboarding is complete. Each tick pulls the repo, runs sync, scans due cron tasks, checks scheduled goal wakeups, and starts or queues runs if the target scope is free.
- Sync: runs after each successful pull and after successful agent runs. It mirrors \`CLAUDE.md\` and \`AGENTS.md\`, copies root \`org.md\` into departments, regenerates \`_org.md\`, and mirrors \`skills/\` into provider-specific skill folders.
- Cron: put scheduled prompts in \`cron/*.md\` with frontmatter like \`schedule: "0 * * * *"\`, required \`provider: claude-code|codex\`, and optional \`paused: true\`.
- Goals: put long-running objectives in \`goals/*.md\` with \`status: active|paused|complete\`, \`schedule: "0 9 * * *"\`, required \`provider: claude-code|codex\`, and \`state: {}\`. Goals are checked once per heartbeat but only run when their own schedule is due; use daily/weekly schedules for strategy or growth work and shorter intervals only for lightweight monitoring.
- Skills: put reusable procedures in \`skills/<name>/SKILL.md\`. AIOS syncs them for both Claude Code and Codex so agents can reliably create, edit, and pause cron tasks and goals.
- Outbox: agents write owner-facing notifications to \`outbox/*.md\` only when explicitly requested or when an important incident happens. AIOS stores the message, clears the file, shows it in Overview, and delivers it through Telegram/email when configured.
- Root scope: root-level \`cron/\`, \`goals/\`, \`skills/\`, and \`outbox/\` are for maintenance or cross-department work that should start from the repository root.
`;
}

export async function ensureAutomationWorkspace(dir: string): Promise<string[]> {
  const changed: string[] = [];
  for (const folder of ["cron", "goals", "skills", "webhooks", "logs", "outbox"]) {
    await mkdir(join(dir, folder), { recursive: true });
  }
  for (const file of ["cron/.gitkeep", "goals/.gitkeep", "webhooks/.gitkeep", "outbox/.gitkeep"]) {
    const abs = join(dir, file);
    if (!existsSync(abs)) {
      await writeFile(abs, "", "utf-8");
      changed.push(abs);
    }
  }
  const defaults: Array<[string, string]> = [
    ["skills/cron-management/SKILL.md", buildCronManagementSkillMd()],
    ["skills/goal-management/SKILL.md", buildGoalManagementSkillMd()],
    ["skills/outbox-notifications/SKILL.md", buildOutboxNotificationsSkillMd()],
  ];
  for (const [rel, body] of defaults) {
    const abs = join(dir, rel);
    if (existsSync(abs)) {
      const current = await readFile(abs, "utf-8").catch(() => "");
      if (!shouldRefreshDefaultSkill(rel, current)) continue;
    }
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, body, "utf-8");
    changed.push(abs);
  }
  return changed;
}

function shouldRefreshDefaultSkill(rel: string, current: string): boolean {
  if (!current.trim()) return true;
  if (rel === "skills/cron-management/SKILL.md") {
    return current.includes("otherwise omit it") || current.includes("Never delete a cron job");
  }
  if (rel === "skills/goal-management/SKILL.md") {
    return current.includes("Active goals are evaluated about once per heartbeat")
      || current.includes("otherwise omit it")
      || current.includes("Never delete a goal");
  }
  return false;
}

function buildCronManagementSkillMd(): string {
  return `---
name: cron-management
description: Create, edit, pause, and inspect AIOS cron tasks in cron/*.md files.
---
# Cron Management

Use this skill when creating or changing scheduled AIOS work.

Cron tasks live in \`cron/*.md\`. Each file is a prompt with YAML frontmatter.

\`\`\`md
---
schedule: "0 * * * *"
provider: claude-code
paused: false
---

Do the scheduled work.
\`\`\`

Rules:
- Use \`provider: claude-code\` or \`provider: codex\`; provider is required.
- If a task should stop running but remain available, set \`paused: true\`.
- Keep the filename stable when editing an existing task so run history and references remain understandable.
- Use standard five-field cron expressions unless the existing task already uses another supported form.
- Keep prompts specific, bounded, and safe to run unattended.
- When re-enabling a paused task, set \`paused: false\` or remove the paused field.
`;
}

function buildGoalManagementSkillMd(): string {
  return `---
name: goal-management
description: Create, edit, pause, and inspect AIOS long-running goals in goals/*.md files.
---
# Goal Management

Use this skill when creating or changing long-running AIOS objectives.

Goals live in \`goals/*.md\`. Each file is a prompt with YAML frontmatter.

\`\`\`md
---
status: active
schedule: "0 9 * * *"
provider: claude-code
state: {}
---

Advance this objective by taking the next smallest useful step.
\`\`\`

Rules:
- Use \`provider: claude-code\` or \`provider: codex\`; provider is required.
- If a goal should stop running but remain available, set \`status: paused\`.
- Mark a goal \`status: complete\` only when its definition of done is satisfied.
- Keep \`state\` small and factual so future runs can resume without rereading unrelated history.
- Each active goal has a \`schedule\` field that controls when AIOS wakes it up. AIOS checks goals every heartbeat, but only starts a goal when its own schedule is due.
- Tune \`schedule\` to match the goal. Use daily, every-few-days, or weekly schedules for research, growth, and strategy work. Use shorter intervals only for lightweight monitoring.
- Do not set wake intervals below 10 minutes unless the goal is very short monitoring work; frequent wakeups can create backlog and waste budget.
- If no useful work is due when woken, exit cleanly after updating \`state\` only if that helps future runs.
- Keep goals outcome-oriented; put recurring fixed-time work in cron instead.
`;
}

function buildOutboxNotificationsSkillMd(): string {
  return `---
name: outbox-notifications
description: Create owner-facing AIOS notifications by writing markdown files to outbox/*.md for dashboard, Telegram, or email delivery.
---
# Outbox Notifications

Use this skill when a task, cron job, goal, or direct owner request requires notifying the owner, or when an emergency or important incident happens.

Agents must not call Telegram or email directly. Write a markdown file to \`outbox/*.md\`; AIOS stores it, deletes the outbox file, shows it on the dashboard, and delivers it through Telegram or email when configured.

Only create an outbox notification when:
- The prompt explicitly asks for a notification, report, briefing, or summary.
- A cron job or goal explicitly says to send the owner a result.
- There is an outage, security risk, billing risk, data-loss risk, failed automation needing owner action, or a problem you fixed that the owner should know about.

Do not create notifications for routine successful work, normal progress, or healthy monitoring checks unless the prompt explicitly asks for that report.

Conditional monitoring rule:
- If everything is healthy, do not write an outbox file unless the prompt asked for an all-clear report.
- If something is wrong, or was wrong and you fixed it, write one concise notification.

Format:
\`\`\`md
---
title: "Website outage fixed"
priority: warning
tags: [monitoring, website]
---

example.com was offline at 07:12, I restarted the service, and it is responding normally now.
\`\`\`

Rules:
- Use \`priority: info\`, \`warning\`, or \`critical\`.
- Keep messages short, factual, and owner-facing.
- Never include secrets, tokens, credentials, or private keys.
- Use a readable filename such as \`outbox/2026-04-25-website-outage-fixed.md\`.
`;
}

export async function scaffoldRepo(dir: string, opts: { name: string }): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "aios.yaml"),
    `version: 1
rootName: Root
departments:
  - sample
ignored:
  - node_modules
  - .git
  - dashboard
`);
  await writeRepoContext(dir, buildDefaultContext(opts.name));
  await ensureAutomationWorkspace(dir);
  await writeFile(join(dir, "README.md"),
    buildDefaultReadmeMd(opts.name));
  await writeFile(join(dir, ".gitignore"),
    "node_modules/\n.env\n.env.local\nlogs/\n*.log\n");

  const dept = join(dir, "sample");
  await ensureAutomationWorkspace(dept);
  const sampleContext = buildDepartmentContextMd("sample");
  await writeFile(join(dept, "CLAUDE.md"), sampleContext);
  await writeFile(join(dept, "AGENTS.md"), sampleContext);
  await writeFile(join(dept, "cron", "hello.md"),
    `---
schedule: "0 * * * *"
provider: claude-code
---

Print "hello from AIOS" to stdout and exit.
`);
}

export async function validateAiosRepo(dir: string): Promise<{ ok: boolean; error?: string; yaml?: AiosYaml }> {
  if (!existsSync(join(dir, "aios.yaml"))) {
    return { ok: false, error: "aios.yaml missing at repo root" };
  }
  const y = parseSimpleYaml(await readFile(join(dir, "aios.yaml"), "utf-8"));
  if (!Array.isArray(y.departments)) {
    return { ok: false, error: "aios.yaml: `departments` must be a list" };
  }
  return { ok: true, yaml: y };
}

export async function discoverDepartments(): Promise<string[]> {
  const y = await readAiosYaml();
  if (!y?.departments) return [];
  const out: string[] = [];
  for (const d of y.departments) {
    if (await pathExists(join(config.repoDir, d))) out.push(d);
  }
  return out;
}

export async function repoHead(): Promise<string | null> {
  try {
    const { stdout } = await gitRun(["rev-parse", "HEAD"]);
    return stdout.trim();
  } catch {
    return null;
  }
}
