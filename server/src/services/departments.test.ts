import { describe, it, beforeEach, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

import { config } from "../config";
import {
  createDepartment,
  DepartmentCreateError,
  ensureRootDepartmentName,
  getRootDepartment,
  listCronTasks,
  normalizeDepartmentName,
  updateRootDepartmentName,
} from "./departments";

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

    for (const rel of [
      "cron/.gitkeep",
      "goals/.gitkeep",
      "webhooks/.gitkeep",
      "skills/cron-management/SKILL.md",
      "skills/goal-management/SKILL.md",
    ]) {
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

  it("stores the root display name in aios.yaml", async () => {
    const root = await updateRootDepartmentName("HQ");

    assert.equal(root.name, "_root");
    assert.equal(root.displayName, "HQ");
    assert.equal((await getRootDepartment()).displayName, "HQ");
    assert.match(await readFile(join(tempRoot, "aios.yaml"), "utf-8"), /^rootName: HQ/m);
  });

  it("writes the default root display name when missing", async () => {
    const changed = await ensureRootDepartmentName();

    assert.equal(changed, join(tempRoot, "aios.yaml"));
    assert.equal((await getRootDepartment()).displayName, "Root");
    assert.match(await readFile(join(tempRoot, "aios.yaml"), "utf-8"), /^rootName: Root/m);
  });

  it("lists root cron tasks from the repository root", async () => {
    await mkdir(join(tempRoot, "cron"), { recursive: true });
    await writeFile(join(tempRoot, "cron", "maintenance.md"), [
      "---",
      "schedule: \"0 * * * *\"",
      "---",
      "",
      "Check cross-department maintenance.",
      "",
    ].join("\n"), "utf-8");

    const tasks = await listCronTasks();
    const task = tasks.find((entry) => entry.department === "_root");
    assert.equal(task?.relPath, "cron/maintenance.md");
    assert.equal(task?.name, "maintenance");
  });
});
