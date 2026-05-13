import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

import { db } from "../db";
import { repairIncompleteRunnableCompanies } from "./companies";
import {
  buildGoalWakePrompt,
  isGoalScheduleAllowed,
  listHeartbeatCompanies,
  MIN_GOAL_INTERVAL_MS,
} from "./heartbeat";

describe("heartbeat goal scheduling", () => {
  it("rejects goal wake schedules below the minimum interval", () => {
    assert.equal(isGoalScheduleAllowed("* * * * *"), false);
    assert.equal(isGoalScheduleAllowed("*/5 * * * *"), false);
    assert.equal(isGoalScheduleAllowed("*/10 * * * *"), true);
    assert.equal(isGoalScheduleAllowed("0 9 * * *"), true);
  });

  it("allows callers to tune the minimum interval", () => {
    assert.equal(isGoalScheduleAllowed("*/5 * * * *", 5 * 60_000), true);
    assert.equal(isGoalScheduleAllowed("*/5 * * * *", MIN_GOAL_INTERVAL_MS), false);
  });

  it("adds wake schedule and self-tuning instructions to goal prompts", () => {
    const prompt = buildGoalWakePrompt({
      relPath: "trading1/goals/strategy.md",
      schedule: "0 9 * * *",
      prompt: "Build the strategy.",
    });

    assert.match(prompt, /Goal file: trading1\/goals\/strategy\.md/);
    assert.match(prompt, /Current wake schedule: 0 9 \* \* \*/);
    assert.match(prompt, /Minimum wake interval: 10 minutes/);
    assert.match(prompt, /Never delete this goal/);
    assert.match(prompt, /Build the strategy/);
  });

  it("includes valid local repos even when company setup is incomplete", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "aios-heartbeat-company-"));
    const slug = `heartbeat-incomplete-${Date.now()}`;
    try {
      await writeFile(join(tempRoot, "aios.yaml"), "version: 1\ndepartments:\n", "utf-8");
      const now = Date.now();
      db.prepare(`
        INSERT INTO companies(slug, display_name, repo_full_name, repo_dir, setup_phase, is_default, webhook_secret, created_at, updated_at)
        VALUES(?, ?, ?, ?, 'context_setup', 0, 'secret', ?, ?)
      `).run(slug, "Heartbeat Incomplete", `acme/${slug}`, tempRoot, now, now);

      assert.ok(listHeartbeatCompanies().some((company) => company.slug === slug));
    } finally {
      db.prepare("DELETE FROM companies WHERE slug = ?").run(slug);
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("repairs incomplete companies with valid local repos", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "aios-company-repair-"));
    const slug = `repair-incomplete-${Date.now()}`;
    try {
      await writeFile(join(tempRoot, "aios.yaml"), "version: 1\ndepartments:\n", "utf-8");
      const now = Date.now();
      db.prepare(`
        INSERT INTO companies(slug, display_name, repo_full_name, repo_dir, setup_phase, is_default, webhook_secret, created_at, updated_at)
        VALUES(?, ?, ?, ?, 'notifications', 0, 'secret', ?, ?)
      `).run(slug, "Repair Incomplete", `acme/${slug}`, tempRoot, now, now);

      assert.equal(repairIncompleteRunnableCompanies() >= 1, true);
      const row = db.prepare("SELECT setup_phase FROM companies WHERE slug = ?").get(slug) as { setup_phase: string };
      assert.equal(row.setup_phase, "complete");
    } finally {
      db.prepare("DELETE FROM companies WHERE slug = ?").run(slug);
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
