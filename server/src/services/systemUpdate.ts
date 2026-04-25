import { execFile, spawn } from "child_process";
import { existsSync } from "fs";
import { mkdir, readFile, rm, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { promisify } from "util";

import { config, saveConfig } from "../config";
import { buildCommonAuthEnv } from "./provider-auth";
import { cloneUrlWithPat, getGithubCreds } from "./github";

const execFileAsync = promisify(execFile);

export const SYSTEM_UPDATE_CHECK_TTL_MS = 5 * 60_000;
export const SYSTEM_UPDATE_STALE_LOCK_MS = 6 * 60 * 60_000;
const SYSTEM_UPDATE_WRAPPER = "/usr/local/bin/aios-system-update";

export interface SystemVersionInfo {
  commit: string | null;
  branch: string | null;
  repoUrl: string | null;
  deployedAt: string | null;
}

export interface SystemUpdateState {
  inProgress: boolean;
  maintenance: boolean;
  stage: string;
  message: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  lastCheckedAt: number | null;
  lastCheckedRepoUrl: string | null;
  lastCheckedBranch: string | null;
  latestCommit: string | null;
  updateAvailable: boolean;
  lastError: string | null;
}

export interface SystemUpdateSnapshot {
  config: {
    repoUrl: string | null;
    branch: string;
    sourceDir: string;
  };
  current: SystemVersionInfo | null;
  state: SystemUpdateState;
  logTail: string;
  canStartUpdate: boolean;
}

interface GitInvocation {
  env: NodeJS.ProcessEnv;
  remoteUrl: string;
}

interface SaveUpdaterConfigInput {
  repoUrl?: string | null;
  branch?: string | null;
  sourceDir?: string | null;
}

function systemUpdatePaths() {
  return {
    version: join(config.dataDir, "system-version.json"),
    state: join(config.dataDir, "system-update.json"),
    log: join(config.logsDir, "system-update.log"),
  };
}

function defaultState(): SystemUpdateState {
  return {
    inProgress: false,
    maintenance: false,
    stage: "idle",
    message: null,
    startedAt: null,
    finishedAt: null,
    lastCheckedAt: null,
    lastCheckedRepoUrl: null,
    lastCheckedBranch: null,
    latestCommit: null,
    updateAvailable: false,
    lastError: null,
  };
}

function parseJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function readJsonFile<T>(path: string): Promise<T | null> {
  if (!existsSync(path)) return null;
  const raw = await readFile(path, "utf-8").catch(() => "");
  return raw ? parseJson<T>(raw) : null;
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function normalizeVersionInfo(raw: any): SystemVersionInfo | null {
  if (!raw || typeof raw !== "object") return null;
  return {
    commit: typeof raw.commit === "string" && raw.commit.trim() ? raw.commit.trim() : null,
    branch: typeof raw.branch === "string" && raw.branch.trim() ? raw.branch.trim() : null,
    repoUrl: typeof raw.repoUrl === "string" && raw.repoUrl.trim() ? raw.repoUrl.trim() : null,
    deployedAt: typeof raw.deployedAt === "string" && raw.deployedAt.trim() ? raw.deployedAt.trim() : null,
  };
}

function normalizeState(raw: Partial<SystemUpdateState> | null, current: SystemVersionInfo | null): SystemUpdateState {
  const next: SystemUpdateState = {
    ...defaultState(),
    ...(raw || {}),
  };
  next.stage = next.stage || "idle";
  next.message = typeof next.message === "string" && next.message.trim() ? next.message.trim() : null;
  next.lastError = typeof next.lastError === "string" && next.lastError.trim() ? next.lastError.trim() : null;
  next.lastCheckedRepoUrl = typeof next.lastCheckedRepoUrl === "string" && next.lastCheckedRepoUrl.trim()
    ? next.lastCheckedRepoUrl.trim()
    : null;
  next.lastCheckedBranch = typeof next.lastCheckedBranch === "string" && next.lastCheckedBranch.trim()
    ? next.lastCheckedBranch.trim()
    : null;
  next.latestCommit = typeof next.latestCommit === "string" && next.latestCommit.trim() ? next.latestCommit.trim() : null;
  next.updateAvailable = !!(current?.commit && next.latestCommit && next.latestCommit !== current.commit);
  return next;
}

function normalizeRepoUrl(value: string | null | undefined): string | null {
  const trimmed = String(value || "").trim();
  return trimmed || null;
}

export function getSystemUpdaterConfig(current: SystemVersionInfo | null = null) {
  return {
    repoUrl: normalizeRepoUrl(config.systemUpdater.repoUrl) || normalizeRepoUrl(current?.repoUrl) || null,
    branch: String(config.systemUpdater.branch || current?.branch || "main").trim() || "main",
    sourceDir: String(config.systemUpdater.sourceDir || "").trim() || "/var/lib/aios/system-src",
  };
}

export function saveSystemUpdaterConfig(input: SaveUpdaterConfigInput) {
  const repoUrl = normalizeRepoUrl(input.repoUrl);
  const branch = String(input.branch || config.systemUpdater.branch || "main").trim() || "main";
  const sourceDir = String(input.sourceDir || config.systemUpdater.sourceDir || "/var/lib/aios/system-src").trim() || "/var/lib/aios/system-src";
  saveConfig({
    ...config,
    systemUpdater: {
      repoUrl,
      branch,
      sourceDir,
    },
  });
  return getSystemUpdaterConfig();
}

async function inferVersionFromSourceDir(sourceDir: string): Promise<SystemVersionInfo | null> {
  if (!existsSync(join(sourceDir, ".git"))) return null;
  try {
    const env = buildCommonAuthEnv();
    const [{ stdout: commit }, { stdout: branch }, { stdout: repoUrl }] = await Promise.all([
      execFileAsync("git", ["-C", sourceDir, "rev-parse", "HEAD"], { env }),
      execFileAsync("git", ["-C", sourceDir, "branch", "--show-current"], { env }),
      execFileAsync("git", ["-C", sourceDir, "config", "--get", "remote.origin.url"], { env }),
    ]);
    return normalizeVersionInfo({
      commit: commit.trim(),
      branch: branch.trim(),
      repoUrl: repoUrl.trim(),
      deployedAt: null,
    });
  } catch {
    return null;
  }
}

export async function readSystemVersion(): Promise<SystemVersionInfo | null> {
  const version = normalizeVersionInfo(await readJsonFile<any>(systemUpdatePaths().version));
  if (version?.commit || version?.repoUrl || version?.branch) return version;
  return inferVersionFromSourceDir(config.systemUpdater.sourceDir || "/var/lib/aios/system-src");
}

export async function readSystemUpdateState(current?: SystemVersionInfo | null): Promise<SystemUpdateState> {
  const loaded = await readJsonFile<Partial<SystemUpdateState>>(systemUpdatePaths().state);
  return normalizeState(loaded, typeof current === "undefined" ? await readSystemVersion() : current || null);
}

export async function writeSystemUpdateState(next: Partial<SystemUpdateState>): Promise<SystemUpdateState> {
  const currentVersion = await readSystemVersion();
  const previous = await readSystemUpdateState(currentVersion);
  const merged = normalizeState({ ...previous, ...next }, currentVersion);
  await writeJsonFile(systemUpdatePaths().state, merged);
  return merged;
}

async function clearStaleSystemUpdateLock(state: SystemUpdateState): Promise<SystemUpdateState> {
  if (!(state.inProgress || state.maintenance)) return state;
  if (!state.startedAt || Date.now() - state.startedAt <= SYSTEM_UPDATE_STALE_LOCK_MS) return state;
  return await writeSystemUpdateState({
    inProgress: false,
    maintenance: false,
    stage: "failed",
    message: null,
    finishedAt: Date.now(),
    lastError: "Cleared stale system update maintenance lock.",
  });
}

async function resetSystemUpdateLog(): Promise<void> {
  const { log } = systemUpdatePaths();
  await mkdir(dirname(log), { recursive: true });
  await rm(log, { force: true }).catch(() => {});
  await writeFile(log, "", "utf-8");
}

async function readLogTail(maxBytes = 12_000): Promise<string> {
  const { log } = systemUpdatePaths();
  if (!existsSync(log)) return "";
  const raw = await readFile(log, "utf-8").catch(() => "");
  if (raw.length <= maxBytes) return raw;
  return raw.slice(raw.length - maxBytes);
}

export function buildGitInvocation(repoUrl: string, creds = getGithubCreds()): GitInvocation {
  const baseEnv = buildCommonAuthEnv();
  if (creds?.mode === "deploy_key" && creds.privateKeyPath) {
    if (repoUrl.startsWith("https://") || repoUrl.startsWith("http://")) {
      return { env: baseEnv, remoteUrl: repoUrl };
    }
    return {
      env: {
        ...baseEnv,
        GIT_SSH_COMMAND: `ssh -i "${creds.privateKeyPath}" -o StrictHostKeyChecking=accept-new`,
      },
      remoteUrl: repoUrl,
    };
  }
  if (creds?.mode === "pat" && creds.username && creds.token) {
    if (repoUrl.startsWith("https://github.com/")) {
      return {
        env: baseEnv,
        remoteUrl: cloneUrlWithPat(repoUrl, creds.username, creds.token),
      };
    }
    if (repoUrl.startsWith("https://") || repoUrl.startsWith("http://")) {
      try {
        const url = new URL(repoUrl);
        url.username = creds.username;
        url.password = creds.token;
        return {
          env: baseEnv,
          remoteUrl: url.toString(),
        };
      } catch {
        return { env: baseEnv, remoteUrl: repoUrl };
      }
    }
    return { env: baseEnv, remoteUrl: repoUrl };
  }
  return { env: baseEnv, remoteUrl: repoUrl };
}

async function lsRemoteBranch(repoUrl: string, branch: string): Promise<string> {
  const git = buildGitInvocation(repoUrl);
  const { stdout } = await execFileAsync("git", ["ls-remote", git.remoteUrl, `refs/heads/${branch}`], {
    env: git.env,
  });
  const line = stdout.trim().split(/\r?\n/).find(Boolean) || "";
  const commit = line.split(/\s+/)[0] || "";
  if (!commit) throw new Error(`branch not found: ${branch}`);
  return commit;
}

function shouldRefresh(state: SystemUpdateState, repoUrl: string | null, branch: string, force: boolean) {
  if (force) return true;
  if (!repoUrl) return false;
  if (state.inProgress) return false;
  if (!state.lastCheckedAt) return true;
  if (state.lastCheckedRepoUrl !== repoUrl || state.lastCheckedBranch !== branch) return true;
  return (Date.now() - state.lastCheckedAt) > SYSTEM_UPDATE_CHECK_TTL_MS;
}

async function refreshUpdateState(
  current: SystemVersionInfo | null,
  state: SystemUpdateState,
  repoUrl: string,
  branch: string,
): Promise<SystemUpdateState> {
  try {
    const latestCommit = await lsRemoteBranch(repoUrl, branch);
    return await writeSystemUpdateState({
      ...state,
      lastCheckedAt: Date.now(),
      lastCheckedRepoUrl: repoUrl,
      lastCheckedBranch: branch,
      latestCommit,
      lastError: null,
    });
  } catch (e: any) {
    return await writeSystemUpdateState({
      ...state,
      lastCheckedAt: Date.now(),
      lastCheckedRepoUrl: repoUrl,
      lastCheckedBranch: branch,
      lastError: String(e?.message || e),
    });
  }
}

export async function getSystemUpdateSnapshot(opts: { forceCheck?: boolean; refreshIfStale?: boolean } = {}): Promise<SystemUpdateSnapshot> {
  const current = await readSystemVersion();
  const updaterConfig = getSystemUpdaterConfig(current);
  let state = await clearStaleSystemUpdateLock(await readSystemUpdateState(current));
  if (updaterConfig.repoUrl && (opts.refreshIfStale || opts.forceCheck) && shouldRefresh(state, updaterConfig.repoUrl, updaterConfig.branch, !!opts.forceCheck)) {
    state = await refreshUpdateState(current, state, updaterConfig.repoUrl, updaterConfig.branch);
  }
  return {
    config: updaterConfig,
    current,
    state: normalizeState(state, current),
    logTail: await readLogTail(),
    canStartUpdate: canStartUpdate(current, normalizeState(state, current)),
  };
}

function canStartUpdate(current: SystemVersionInfo | null, state: SystemUpdateState) {
  if (!state.lastCheckedRepoUrl) return !state.inProgress && !current?.commit;
  if (state.inProgress) return false;
  if (state.updateAvailable) return true;
  return !current?.commit;
}

export async function isSystemUpdateBlocking(): Promise<boolean> {
  const state = await clearStaleSystemUpdateLock(await readSystemUpdateState());
  return !!(state.inProgress || state.maintenance);
}

export async function startSystemUpdate(actorEmail: string): Promise<void> {
  const snapshot = await getSystemUpdateSnapshot({ forceCheck: true, refreshIfStale: false });
  if (!snapshot.config.repoUrl) throw new Error("Set the updater repo URL first.");
  if (snapshot.state.inProgress) throw new Error("A system update is already in progress.");
  if (snapshot.current?.commit && !snapshot.state.latestCommit) {
    throw new Error(snapshot.state.lastError || "Unable to determine the latest upstream version.");
  }
  if (snapshot.current?.commit && !snapshot.state.updateAvailable) {
    throw new Error("This AIOS-VPS deployment is already up to date.");
  }
  const creds = getGithubCreds();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AIOS_UPDATER_REPO_URL: snapshot.config.repoUrl,
    AIOS_UPDATER_BRANCH: snapshot.config.branch,
    AIOS_UPDATER_SOURCE_DIR: snapshot.config.sourceDir,
    AIOS_UPDATER_STATUS_PATH: systemUpdatePaths().state,
    AIOS_UPDATER_VERSION_PATH: systemUpdatePaths().version,
    AIOS_UPDATER_LOG_PATH: systemUpdatePaths().log,
    AIOS_UPDATER_AUTH_MODE: creds?.mode || "none",
  };
  if (creds?.mode === "pat") {
    if (creds.username) env.AIOS_UPDATER_GITHUB_USERNAME = creds.username;
    if (creds.token) env.AIOS_UPDATER_GITHUB_TOKEN = creds.token;
  }
  if (creds?.mode === "deploy_key" && creds.privateKeyPath) {
    env.AIOS_UPDATER_DEPLOY_KEY_PATH = creds.privateKeyPath;
  }

  const preserved = [
    "AIOS_UPDATER_REPO_URL",
    "AIOS_UPDATER_BRANCH",
    "AIOS_UPDATER_SOURCE_DIR",
    "AIOS_UPDATER_STATUS_PATH",
    "AIOS_UPDATER_VERSION_PATH",
    "AIOS_UPDATER_LOG_PATH",
    "AIOS_UPDATER_AUTH_MODE",
    "AIOS_UPDATER_GITHUB_USERNAME",
    "AIOS_UPDATER_GITHUB_TOKEN",
    "AIOS_UPDATER_DEPLOY_KEY_PATH",
  ].join(",");

  await execFileAsync("sudo", ["-n", `--preserve-env=${preserved}`, SYSTEM_UPDATE_WRAPPER, "--probe"], { env });
  await resetSystemUpdateLog();
  await writeSystemUpdateState({
    inProgress: true,
    maintenance: true,
    stage: "starting",
    message: `Update requested by ${actorEmail}`,
    startedAt: Date.now(),
    finishedAt: null,
    lastError: null,
  });

  try {
    const child = spawn("sudo", ["-n", `--preserve-env=${preserved}`, SYSTEM_UPDATE_WRAPPER], {
      detached: true,
      stdio: "ignore",
      env,
    });
    child.unref();
  } catch (e: any) {
    await writeSystemUpdateState({
      inProgress: false,
      maintenance: false,
      stage: "failed",
      message: null,
      finishedAt: Date.now(),
      lastError: String(e?.message || e),
    });
    throw e;
  }
}

export function validateSystemUpdaterInput(input: SaveUpdaterConfigInput) {
  const repoUrl = normalizeRepoUrl(input.repoUrl);
  if (repoUrl) {
    const looksLikeUrl = repoUrl.startsWith("https://") || repoUrl.startsWith("http://") || /^[\w.-]+@[\w.-]+:/.test(repoUrl);
    if (!looksLikeUrl) throw new Error("repoUrl must be an HTTPS URL or SSH clone URL.");
  }
  const branch = String(input.branch || "main").trim();
  if (!branch) throw new Error("branch is required");
}
