import { afterEach, beforeEach, describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { execFile } from "child_process";
import { promisify } from "util";
import { existsSync } from "fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

import { config } from "../config";
import { runSyncLayer } from "./sync";

const execFileAsync = promisify(execFile);

async function git(args: string[], cwd: string) {
  return execFileAsync("git", args, { cwd });
}

describe("runSyncLayer department deletion", () => {
  let tempRoot = "";
  const prevRepoDir = config.repoDir;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "aios-sync-"));
    config.repoDir = tempRoot;
    await mkdir(join(tempRoot, "sample"), { recursive: true });
    await writeFile(join(tempRoot, ".gitignore"), "**/logs/\n", "utf-8");
    await writeFile(join(tempRoot, "aios.yaml"), "version: 1\ndepartments:\n  - sample\n", "utf-8");
    await writeFile(join(tempRoot, "CLAUDE.md"), "# Root\n", "utf-8");
    await writeFile(join(tempRoot, "AGENTS.md"), "# Root\n", "utf-8");
    await writeFile(join(tempRoot, "sample", "CLAUDE.md"), "# Sample\n", "utf-8");
    await writeFile(join(tempRoot, "sample", "AGENTS.md"), "# Sample\n", "utf-8");

    await git(["init"], tempRoot);
    await git(["config", "user.email", "aios@example.test"], tempRoot);
    await git(["config", "user.name", "AIOS"], tempRoot);
    await git(["add", "-A"], tempRoot);
    await git(["commit", "-m", "init"], tempRoot);
  });

  afterEach(async () => {
    config.repoDir = prevRepoDir;
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("prunes a deleted department even when ignored runtime leftovers remain", async () => {
    await mkdir(join(tempRoot, "sample", "logs"), { recursive: true });
    await writeFile(join(tempRoot, "sample", "logs", "run.log"), "runtime\n", "utf-8");
    await rm(join(tempRoot, "sample", "CLAUDE.md"), { force: true });
    await rm(join(tempRoot, "sample", "AGENTS.md"), { force: true });
    await git(["add", "-A"], tempRoot);
    await git(["commit", "-m", "delete sample folder"], tempRoot);

    const result = await runSyncLayer({ commit: false });
    const yaml = await readFile(join(tempRoot, "aios.yaml"), "utf-8");

    assert.deepEqual(result.removedDepartments, ["sample"]);
    assert.doesNotMatch(yaml, /  - sample/);
    assert.equal(existsSync(join(tempRoot, "sample", "CLAUDE.md")), false);
    assert.equal(existsSync(join(tempRoot, "sample", "cron", ".gitkeep")), false);
    assert.equal(existsSync(join(tempRoot, "sample", "logs", "run.log")), true);
  });
});
