import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

import { config } from "../config";
import {
  applyInstructions,
  clearInstructions,
  defaultInstructionsBody,
  resetInstructionsToDefaults,
} from "./storageInstructions";

describe("storageInstructions", () => {
  let tempRoot = "";
  const prevRepoDir = config.repoDir;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "aios-storage-instructions-"));
    config.repoDir = tempRoot;
    await mkdir(join(tempRoot, "sample"), { recursive: true });
    await writeFile(join(tempRoot, "aios.yaml"), "departments:\n  - sample\n", "utf-8");
    await writeFile(join(tempRoot, "sample", "CLAUDE.md"), "# Sample\n", "utf-8");
    await writeFile(join(tempRoot, "sample", "AGENTS.md"), "# Sample\n", "utf-8");
  });

  afterEach(async () => {
    config.repoDir = prevRepoDir;
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("applies the managed block to both prompt files", async () => {
    const changed = await applyInstructions("sample");
    assert.equal(changed, true);
    const claude = await readFile(join(tempRoot, "sample", "CLAUDE.md"), "utf-8");
    const agents = await readFile(join(tempRoot, "sample", "AGENTS.md"), "utf-8");
    assert.match(claude, /aios:managed:storage start/);
    assert.match(agents, /aios:managed:storage start/);
    assert.match(claude, /aws s3 cp <local-file>/);
    assert.match(agents, /AWS_ACCESS_KEY_ID/);
  });

  it("reset restores defaults and clear removes the block from both files", async () => {
    await applyInstructions("sample");
    await writeFile(
      join(tempRoot, "sample", "CLAUDE.md"),
      "# Sample\n\n<!-- aios:managed:storage start -->\ncustom\n<!-- aios:managed:storage end -->\n",
      "utf-8",
    );
    await writeFile(
      join(tempRoot, "sample", "AGENTS.md"),
      "# Sample\n\n<!-- aios:managed:storage start -->\ncustom\n<!-- aios:managed:storage end -->\n",
      "utf-8",
    );

    const reset = await resetInstructionsToDefaults("sample");
    assert.equal(reset, true);
    const expectedSnippet = defaultInstructionsBody().split("\n")[0];
    const claudeReset = await readFile(join(tempRoot, "sample", "CLAUDE.md"), "utf-8");
    const agentsReset = await readFile(join(tempRoot, "sample", "AGENTS.md"), "utf-8");
    assert.match(claudeReset, new RegExp(expectedSnippet.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(agentsReset, /Files produced:/);

    const cleared = await clearInstructions("sample");
    assert.equal(cleared, true);
    const claudeCleared = await readFile(join(tempRoot, "sample", "CLAUDE.md"), "utf-8");
    const agentsCleared = await readFile(join(tempRoot, "sample", "AGENTS.md"), "utf-8");
    assert.doesNotMatch(claudeCleared, /aios:managed:storage start/);
    assert.doesNotMatch(agentsCleared, /aios:managed:storage start/);
  });
});
