import { afterEach, beforeEach, describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { execFile } from "child_process";
import { promisify } from "util";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { pathToFileURL } from "url";

import { config } from "../config";
import {
  buildGitInvocation,
  getSystemUpdateSnapshot,
  isSystemUpdateBlocking,
  readSystemUpdateState,
  SYSTEM_UPDATE_STALE_LOCK_MS,
  writeSystemUpdateState,
} from "./systemUpdate";

const execFileAsync = promisify(execFile);

async function git(args: string[], cwd: string) {
  return execFileAsync("git", args, { cwd });
}

describe("systemUpdate", () => {
  let tempRoot = "";
  let remoteRepo = "";
  let remoteUrl = "";
  let workRepo = "";
  let previousDataDir = "";
  let previousLogsDir = "";
  let previousUpdater = { ...config.systemUpdater };

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "aios-system-update-"));
    remoteRepo = join(tempRoot, "remote.git");
    remoteUrl = pathToFileURL(remoteRepo).href;
    workRepo = join(tempRoot, "work");
    previousDataDir = config.dataDir;
    previousLogsDir = config.logsDir;
    previousUpdater = { ...config.systemUpdater };

    config.dataDir = join(tempRoot, "data");
    config.logsDir = join(tempRoot, "logs");
    await mkdir(config.dataDir, { recursive: true });
    await mkdir(config.logsDir, { recursive: true });

    await git(["init", "--bare", remoteRepo], tempRoot);
    await mkdir(workRepo, { recursive: true });
    await git(["init"], workRepo);
    await git(["config", "user.email", "aios@example.test"], workRepo);
    await git(["config", "user.name", "AIOS"], workRepo);
    await git(["checkout", "-B", "main"], workRepo);
    await writeFile(join(workRepo, "README.md"), "# test\n", "utf-8");
    await git(["add", "README.md"], workRepo);
    await git(["commit", "-m", "init"], workRepo);
    await git(["remote", "add", "origin", remoteRepo], workRepo);
    await git(["push", "-u", "origin", "main"], workRepo);
  });

  afterEach(async () => {
    config.dataDir = previousDataDir;
    config.logsDir = previousLogsDir;
    config.systemUpdater = previousUpdater;
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("detects when the configured updater branch has a newer commit", async () => {
    const { stdout: remoteHead } = await git(["rev-parse", "HEAD"], workRepo);
    const remoteCommit = remoteHead.trim();

    await writeFile(join(config.dataDir, "system-version.json"), JSON.stringify({
      commit: "1111111111111111111111111111111111111111",
      branch: "main",
      repoUrl: remoteUrl,
      deployedAt: "2026-01-01T00:00:00Z",
    }, null, 2) + "\n", "utf-8");

    config.systemUpdater = {
      repoUrl: remoteUrl,
      branch: "main",
      sourceDir: join(tempRoot, "system-src"),
    };

    const snapshot = await getSystemUpdateSnapshot({ forceCheck: true });

    assert.equal(snapshot.state.latestCommit, remoteCommit);
    assert.equal(snapshot.state.updateAvailable, true);
    assert.equal(snapshot.config.repoUrl, remoteUrl);
  });

  it("reports up to date when the deployed commit matches the remote head", async () => {
    const { stdout: remoteHead } = await git(["rev-parse", "HEAD"], workRepo);
    const remoteCommit = remoteHead.trim();

    await writeFile(join(config.dataDir, "system-version.json"), JSON.stringify({
      commit: remoteCommit,
      branch: "main",
      repoUrl: remoteUrl,
      deployedAt: "2026-01-01T00:00:00Z",
    }, null, 2) + "\n", "utf-8");

    config.systemUpdater = {
      repoUrl: remoteUrl,
      branch: "main",
      sourceDir: join(tempRoot, "system-src"),
    };

    const snapshot = await getSystemUpdateSnapshot({ forceCheck: true });

    assert.equal(snapshot.state.latestCommit, remoteCommit);
    assert.equal(snapshot.state.updateAvailable, false);
  });

  it("treats maintenance state as a run blocker", async () => {
    await writeSystemUpdateState({
      inProgress: true,
      maintenance: true,
      stage: "deploying",
      message: "updating",
    });

    assert.equal(await isSystemUpdateBlocking(), true);

    await writeSystemUpdateState({
      inProgress: false,
      maintenance: false,
      stage: "succeeded",
      message: "done",
    });

    assert.equal(await isSystemUpdateBlocking(), false);
  });

  it("clears stale maintenance locks so heartbeat can resume", async () => {
    await writeSystemUpdateState({
      inProgress: true,
      maintenance: true,
      stage: "deploying",
      message: "updating",
      startedAt: Date.now() - SYSTEM_UPDATE_STALE_LOCK_MS - 1_000,
    });

    assert.equal(await isSystemUpdateBlocking(), false);

    const state = await readSystemUpdateState();
    assert.equal(state.inProgress, false);
    assert.equal(state.maintenance, false);
    assert.equal(state.stage, "failed");
    assert.match(state.lastError || "", /stale/i);
  });

  it("clears stale maintenance locks in update status snapshots", async () => {
    await writeSystemUpdateState({
      inProgress: true,
      maintenance: true,
      stage: "starting",
      message: "Update requested",
      startedAt: Date.now() - SYSTEM_UPDATE_STALE_LOCK_MS - 1_000,
    });

    const snapshot = await getSystemUpdateSnapshot();

    assert.equal(snapshot.state.inProgress, false);
    assert.equal(snapshot.state.maintenance, false);
    assert.equal(snapshot.state.stage, "failed");
    assert.match(snapshot.state.lastError || "", /stale/i);
  });

  it("recovers an interrupted successful deploy that was killed by service restart", async () => {
    const { stdout: remoteHead } = await git(["rev-parse", "HEAD"], workRepo);
    const remoteCommit = remoteHead.trim();

    await writeFile(join(config.dataDir, "system-version.json"), JSON.stringify({
      commit: remoteCommit,
      branch: "main",
      repoUrl: remoteUrl,
      deployedAt: new Date().toISOString(),
    }, null, 2) + "\n", "utf-8");
    await writeFile(join(config.logsDir, "system-update.log"), [
      "[deploy-app] building ui",
      "[deploy-app] restarting aios",
      "",
    ].join("\n"), "utf-8");
    await writeSystemUpdateState({
      inProgress: true,
      maintenance: true,
      stage: "deploying",
      message: "Deploying AIOS-VPS application",
      startedAt: Date.now() - 10_000,
      latestCommit: remoteCommit,
      lastError: null,
    });

    const snapshot = await getSystemUpdateSnapshot();

    assert.equal(snapshot.state.inProgress, false);
    assert.equal(snapshot.state.maintenance, false);
    assert.equal(snapshot.state.stage, "succeeded");
    assert.equal(snapshot.state.lastError, null);
    assert.equal(await isSystemUpdateBlocking(), false);
  });

  it("keeps HTTPS updater URLs on HTTPS even when deploy-key credentials exist", async () => {
    const git = buildGitInvocation("https://github.com/hcthisen/AIOS-VPS", {
      mode: "deploy_key",
      privateKeyPath: "/tmp/key",
    });

    assert.equal(git.remoteUrl, "https://github.com/hcthisen/AIOS-VPS");
    assert.equal(git.env.GIT_SSH_COMMAND, undefined);
  });

  it("uses deploy-key SSH configuration for SSH updater URLs", async () => {
    const git = buildGitInvocation("git@github.com:hcthisen/AIOS-VPS.git", {
      mode: "deploy_key",
      privateKeyPath: "/tmp/key",
    });

    assert.equal(git.remoteUrl, "git@github.com:hcthisen/AIOS-VPS.git");
    assert.match(git.env.GIT_SSH_COMMAND || "", /\/tmp\/key/);
  });
});
