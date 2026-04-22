import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { execFile } from "child_process";
import { promisify } from "util";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

import { config } from "../config";
import { commitRepoPaths } from "./repo";

const execFileAsync = promisify(execFile);

async function git(args: string[], cwd: string) {
  return execFileAsync("git", args, { cwd });
}

describe("commitRepoPaths", () => {
  let tempRoot = "";
  const prevRepoDir = config.repoDir;
  const prevDataDir = config.dataDir;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "aios-repo-commit-"));
    config.repoDir = tempRoot;
    config.dataDir = join(tempRoot, ".aios-data");
    await mkdir(config.dataDir, { recursive: true });
    await mkdir(join(tempRoot, "sample"), { recursive: true });
    await writeFile(join(tempRoot, "sample", "CLAUDE.md"), "# Sample\n", "utf-8");
    await writeFile(join(tempRoot, "other.md"), "# Other\n", "utf-8");

    await git(["init"], tempRoot);
    await git(["config", "user.email", "aios@example.test"], tempRoot);
    await git(["config", "user.name", "AIOS"], tempRoot);
    await git(["add", "-A"], tempRoot);
    await git(["commit", "-m", "init"], tempRoot);
  });

  afterEach(async () => {
    config.repoDir = prevRepoDir;
    config.dataDir = prevDataDir;
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("commits only the selected paths", async () => {
    await writeFile(join(tempRoot, "sample", "CLAUDE.md"), "# Sample\n\nupdated\n", "utf-8");
    await writeFile(join(tempRoot, "other.md"), "# Other\n\nchanged\n", "utf-8");

    const sha = await commitRepoPaths(
      [join(tempRoot, "sample", "CLAUDE.md")],
      "aios: storage instructions for sample",
    );

    assert.ok(sha);

    const { stdout: commitFiles } = await git(["show", "--name-only", "--pretty=format:%s", "HEAD"], tempRoot);
    assert.match(commitFiles, /aios: storage instructions for sample/);
    assert.match(commitFiles, /sample\/CLAUDE\.md/);
    assert.doesNotMatch(commitFiles, /other\.md/);

    const { stdout: status } = await git(["status", "--short"], tempRoot);
    assert.match(status, / M other\.md/);
    assert.doesNotMatch(status, /sample\/CLAUDE\.md/);
  });
});
