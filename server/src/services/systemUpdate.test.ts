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
  getSystemUpdateSnapshot,
  isSystemUpdateBlocking,
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
});
