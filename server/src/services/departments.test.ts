import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

import { config } from "../config";
import { createDepartment, DepartmentCreateError, normalizeDepartmentName } from "./departments";

describe("departments", () => {
  let tempRoot = "";
  const prevRepoDir = config.repoDir;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "aios-departments-"));
    config.repoDir = tempRoot;
    await mkdir(join(tempRoot, "sample"), { recursive: true });
    await writeFile(join(tempRoot, "aios.yaml"), [
      "version: 1",
      "departments:",
      "  - sample",
      "ignored:",
      "  - node_modules",
      "",
    ].join("\n"), "utf-8");
  });

  afterEach(async () => {
    config.repoDir = prevRepoDir;
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("normalizes dashboard department names into folder-safe names", () => {
    assert.equal(normalizeDepartmentName(" Marketing Ops "), "marketing-ops");
    assert.equal(normalizeDepartmentName("R&D / Labs"), "r-d-labs");
  });

  it("adds a department to aios.yaml and scaffolds provider files", async () => {
    const department = await createDepartment({ name: "Marketing Ops" });

    assert.equal(department.name, "marketing-ops");

    const yaml = await readFile(join(tempRoot, "aios.yaml"), "utf-8");
    assert.match(yaml, /departments:\n  - sample\n  - marketing-ops\nignored:\n  - node_modules/);

    const claude = await readFile(join(tempRoot, "marketing-ops", "CLAUDE.md"), "utf-8");
    const agents = await readFile(join(tempRoot, "marketing-ops", "AGENTS.md"), "utf-8");
    assert.equal(agents, claude);
    assert.match(claude, /# marketing-ops department/);

    for (const rel of ["cron/.gitkeep", "goals/.gitkeep", "skills/.gitkeep", "webhooks/.gitkeep"]) {
      const s = await stat(join(tempRoot, "marketing-ops", rel));
      assert.ok(s.isFile());
    }
    const logs = await stat(join(tempRoot, "marketing-ops", "logs"));
    assert.ok(logs.isDirectory());
  });

  it("rejects duplicate departments", async () => {
    await assert.rejects(
      () => createDepartment({ name: "sample" }),
      (error) => error instanceof DepartmentCreateError
        && error.code === "conflict"
        && /already exists/.test(error.message),
    );
  });
});
