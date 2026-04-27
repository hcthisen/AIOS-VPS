import { afterEach, beforeEach, describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

import { config } from "../config";
import { db } from "../db";
import { HttpError } from "../http";
import { deleteCronTaskFile, deleteGoalFile, validateProviderFrontmatter } from "./dashboard";

describe("dashboard automation file validation", () => {
  let tempHome = "";
  const previousAiosHome = process.env.AIOS_HOME;
  const previousRepoDir = config.repoDir;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), "aios-dashboard-validation-"));
    process.env.AIOS_HOME = tempHome;
    config.repoDir = join(tempHome, "repo");
  });

  afterEach(async () => {
    db.prepare("DELETE FROM cron_state WHERE path LIKE ?").run(`${tempHome}%`);
    db.prepare("DELETE FROM goal_state WHERE path LIKE ?").run(`${tempHome}%`);
    if (typeof previousAiosHome === "undefined") delete process.env.AIOS_HOME;
    else process.env.AIOS_HOME = previousAiosHome;
    config.repoDir = previousRepoDir;
    await rm(tempHome, { recursive: true, force: true });
  });

  it("requires provider frontmatter for cron and goal files", async () => {
    await assert.rejects(
      () => validateProviderFrontmatter("sample/cron/report.md", [
        "---",
        "schedule: \"0 * * * *\"",
        "---",
        "",
        "Run report.",
      ].join("\n")),
      (error) => error instanceof HttpError
        && error.status === 400
        && /provider is required/.test(error.message),
    );

    await assert.rejects(
      () => validateProviderFrontmatter("sample/goals/grow.md", [
        "---",
        "status: active",
        "schedule: \"0 9 * * *\"",
        "state: {}",
        "---",
        "",
        "Grow.",
      ].join("\n")),
      (error) => error instanceof HttpError
        && error.status === 400
        && /provider is required/.test(error.message),
    );
  });

  it("rejects invalid and unauthorized providers", async () => {
    await assert.rejects(
      () => validateProviderFrontmatter("sample/cron/report.md", [
        "---",
        "schedule: \"0 * * * *\"",
        "provider: other",
        "---",
        "",
        "Run report.",
      ].join("\n")),
      /provider must be claude-code or codex/,
    );

    await assert.rejects(
      () => validateProviderFrontmatter("sample/cron/report.md", [
        "---",
        "schedule: \"0 * * * *\"",
        "provider: codex",
        "---",
        "",
        "Run report.",
      ].join("\n")),
      /Codex is not authorized/,
    );
  });

  it("accepts authorized providers and ignores non-automation files", async () => {
    await mkdir(join(tempHome, ".codex"), { recursive: true });
    await writeFile(join(tempHome, ".codex", "auth.json"), "{}\n", "utf-8");

    await validateProviderFrontmatter("sample/cron/report.md", [
      "---",
      "schedule: \"0 * * * *\"",
      "provider: codex",
      "---",
      "",
      "Run report.",
    ].join("\n"));

    await validateProviderFrontmatter("sample/README.md", "No provider needed.");
  });

  it("deletes task and goal files and clears scheduler state", async () => {
    await mkdir(join(config.repoDir, "sample", "cron"), { recursive: true });
    await mkdir(join(config.repoDir, "sample", "goals"), { recursive: true });
    await writeFile(join(config.repoDir, "aios.yaml"), [
      "version: 1",
      "departments:",
      "  - sample",
      "",
    ].join("\n"), "utf-8");
    const cronPath = join(config.repoDir, "sample", "cron", "report.md");
    const goalPath = join(config.repoDir, "sample", "goals", "grow.md");
    await writeFile(cronPath, [
      "---",
      "schedule: \"0 * * * *\"",
      "provider: codex",
      "---",
      "",
      "Run report.",
    ].join("\n"), "utf-8");
    await writeFile(goalPath, [
      "---",
      "status: active",
      "schedule: \"0 9 * * *\"",
      "provider: codex",
      "state: {}",
      "---",
      "",
      "Grow.",
    ].join("\n"), "utf-8");
    db.prepare("INSERT OR REPLACE INTO cron_state(path, last_fired, paused) VALUES(?, ?, 0)").run(cronPath, Date.now());
    db.prepare("INSERT OR REPLACE INTO goal_state(path, last_fired) VALUES(?, ?)").run(goalPath, Date.now());

    await deleteCronTaskFile("sample/cron/report.md");
    await deleteGoalFile("sample/goals/grow.md");

    assert.equal(db.prepare("SELECT path FROM cron_state WHERE path = ?").get(cronPath), undefined);
    assert.equal(db.prepare("SELECT path FROM goal_state WHERE path = ?").get(goalPath), undefined);
    await assert.rejects(() => deleteCronTaskFile("sample/cron/report.md"), /task not found/);
    await assert.rejects(() => deleteGoalFile("sample/goals/grow.md"), /goal not found/);
  });
});
