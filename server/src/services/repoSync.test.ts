import { afterEach, beforeEach, describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { execFile } from "child_process";
import { promisify } from "util";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

import { config } from "../config";
import { cleanGitHubHttpsRemoteUrl, checkRemoteForUpdates, getGitSyncStatus, reconcilePendingRepoSync, setGitWorktreeBlocked, syncRepoWithRemote } from "./repo";

const execFileAsync = promisify(execFile);

async function git(args: string[], cwd: string) {
  return execFileAsync("git", args, { cwd });
}

async function commitAll(cwd: string, message: string) {
  await git(["add", "-A"], cwd);
  await git(["commit", "-m", message], cwd);
}

async function readNormalized(path: string): Promise<string> {
  return (await readFile(path, "utf-8")).replace(/\r\n/g, "\n");
}

describe("syncRepoWithRemote", () => {
  let tempRoot = "";
  let remoteRepo = "";
  let upstreamWork = "";
  let localRepo = "";
  const prevRepoDir = config.repoDir;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "aios-repo-sync-"));
    remoteRepo = join(tempRoot, "remote.git");
    upstreamWork = join(tempRoot, "upstream");
    localRepo = join(tempRoot, "local");

    await git(["init", "--bare", remoteRepo], tempRoot);
    await mkdir(upstreamWork, { recursive: true });
    await git(["init"], upstreamWork);
    await git(["config", "user.email", "aios@example.test"], upstreamWork);
    await git(["config", "user.name", "AIOS"], upstreamWork);
    await git(["checkout", "-B", "main"], upstreamWork);
    await writeFile(join(upstreamWork, "aios.yaml"), "version: 1\ndepartments:\n", "utf-8");
    await writeFile(join(upstreamWork, "cron.md"), "initial\n", "utf-8");
    await commitAll(upstreamWork, "init");
    await git(["remote", "add", "origin", remoteRepo], upstreamWork);
    await git(["push", "-u", "origin", "main"], upstreamWork);
    await git(["symbolic-ref", "HEAD", "refs/heads/main"], remoteRepo);

    await git(["clone", remoteRepo, localRepo], tempRoot);
    await git(["checkout", "main"], localRepo);
    await git(["config", "user.email", "aios@example.test"], localRepo);
    await git(["config", "user.name", "AIOS"], localRepo);
    config.repoDir = localRepo;
  });

  afterEach(async () => {
    setGitWorktreeBlocked(() => false);
    config.repoDir = prevRepoDir;
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("pulls remote changes before local work continues", async () => {
    await writeFile(join(upstreamWork, "cron.md"), "remote cron update\n", "utf-8");
    await commitAll(upstreamWork, "remote cron update");
    await git(["push"], upstreamWork);

    const result = await syncRepoWithRemote({ notifyOnRemoteWins: false });

    assert.equal(result.ok, true);
    assert.equal(result.remoteWins, false);
    assert.equal(await readNormalized(join(localRepo, "cron.md")), "remote cron update\n");
  });

  it("rebases local AIOS commits onto remote and pushes them", async () => {
    await writeFile(join(localRepo, "local.md"), "local\n", "utf-8");
    await commitAll(localRepo, "aios: local change");

    await writeFile(join(upstreamWork, "remote.md"), "remote\n", "utf-8");
    await commitAll(upstreamWork, "operator remote change");
    await git(["push"], upstreamWork);

    const result = await syncRepoWithRemote({ notifyOnRemoteWins: false });

    assert.equal(result.ok, true);
    assert.equal(result.remoteWins, false);
    assert.equal(result.pushed, true);

    await git(["pull", "--ff-only"], upstreamWork);
    assert.equal(await readNormalized(join(upstreamWork, "local.md")), "local\n");
  });

  it("resets to remote when dirty local changes cannot be reapplied", async () => {
    await writeFile(join(localRepo, "cron.md"), "dirty local cron\n", "utf-8");

    await writeFile(join(upstreamWork, "cron.md"), "remote cron wins\n", "utf-8");
    await commitAll(upstreamWork, "remote cron wins");
    await git(["push"], upstreamWork);

    const result = await syncRepoWithRemote({ notifyOnRemoteWins: false });

    assert.equal(result.ok, true);
    assert.equal(result.remoteWins, true);
    assert.equal(await readNormalized(join(localRepo, "cron.md")), "remote cron wins\n");
  });

  it("marks pending inbound sync from remote probes and reconciles it", async () => {
    await writeFile(join(upstreamWork, "cron.md"), "remote pending update\n", "utf-8");
    await commitAll(upstreamWork, "remote pending update");
    await git(["push"], upstreamWork);

    const probe = await checkRemoteForUpdates({ force: true });
    assert.equal(probe.checked, true);
    assert.equal(probe.changed, true);
    assert.equal(getGitSyncStatus().pendingInboundSync, true);

    const sync = await reconcilePendingRepoSync("test pending sync");
    assert.equal(sync?.ok, true);
    assert.equal(sync?.blocked, undefined);
    assert.equal(await readNormalized(join(localRepo, "cron.md")), "remote pending update\n");
    assert.equal(getGitSyncStatus().pendingInboundSync, false);
  });

  it("defers pending sync while the worktree is blocked", async () => {
    await writeFile(join(upstreamWork, "cron.md"), "remote blocked update\n", "utf-8");
    await commitAll(upstreamWork, "remote blocked update");
    await git(["push"], upstreamWork);

    await checkRemoteForUpdates({ force: true });
    setGitWorktreeBlocked(() => true);

    const blocked = await reconcilePendingRepoSync("test blocked sync");

    assert.equal(blocked?.blocked, true);
    assert.equal(getGitSyncStatus().pendingInboundSync, true);
    assert.equal(await readNormalized(join(localRepo, "cron.md")), "initial\n");
  });
});

describe("GitHub remote cleanup", () => {
  it("removes embedded HTTPS credentials from GitHub remotes", () => {
    assert.equal(
      cleanGitHubHttpsRemoteUrl("https://old-user:old-token@github.com/hcthisen/aios-titanclaws.git/"),
      "https://github.com/hcthisen/aios-titanclaws.git",
    );
    assert.equal(
      cleanGitHubHttpsRemoteUrl("https://github.com/hcthisen/aios-titanclaws.git"),
      "https://github.com/hcthisen/aios-titanclaws.git",
    );
    assert.equal(cleanGitHubHttpsRemoteUrl("git@github.com:hcthisen/aios-titanclaws.git"), null);
    assert.equal(cleanGitHubHttpsRemoteUrl("https://example.com/hcthisen/aios-titanclaws.git"), null);
  });
});
