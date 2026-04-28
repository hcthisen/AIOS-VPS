import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

import { db } from "../db";
import { processBacklogForDepartments, recoverOrphanedQueuedBacklogRuns } from "./executor";
import { createRun, enqueueBacklog, getRun, listBacklog, listRuns } from "./runs";

describe("executor backlog dispatch", () => {
  it("resolves the original queued run instead of creating a backlog run", async () => {
    const trigger = `test-backlog-cron-${Date.now()}`;
    const previousAiosHome = process.env.AIOS_HOME;
    const tempHome = await mkdtemp(join(tmpdir(), "aios-executor-backlog-"));
    process.env.AIOS_HOME = tempHome;
    try {
      const run = createRun({
        department: "_root",
        trigger,
        provider: "codex",
        prompt: "hello",
        status: "queued",
      });
      enqueueBacklog("_root", trigger, {
        runId: run.id,
        prompt: "hello",
        provider: "codex",
        departments: ["_root"],
      });

      await processBacklogForDepartments(["_root"]);

      const updated = getRun(run.id);
      assert.equal(updated?.status, "canceled");
      assert.match(updated?.error || "", /Codex is not authorized/);
      assert.equal(listBacklog().some((item) => item.trigger === trigger), false);

      const matchingRuns = listRuns({ limit: 500 })
        .filter((item) => item.trigger === trigger || item.trigger === `backlog:${trigger}`);
      assert.deepEqual(matchingRuns.map((item) => item.id), [run.id]);
    } finally {
      if (previousAiosHome === undefined) delete process.env.AIOS_HOME;
      else process.env.AIOS_HOME = previousAiosHome;
      db.prepare("DELETE FROM backlog WHERE trigger = ?").run(trigger);
      db.prepare("DELETE FROM runs WHERE trigger = ? OR trigger = ?").run(trigger, `backlog:${trigger}`);
      await rm(tempHome, { recursive: true, force: true });
    }
  });

  it("recovers queued backlog markers that no longer have backlog work", () => {
    const trigger = `test-backlog-orphan-${Date.now()}`;
    try {
      const run = createRun({
        department: "_root",
        trigger,
        provider: "codex",
        prompt: "hello",
        status: "queued",
      });
      db.prepare("UPDATE runs SET error = ? WHERE id = ?")
        .run("department busy; queued to backlog", run.id);

      assert.ok(recoverOrphanedQueuedBacklogRuns() >= 1);

      const updated = getRun(run.id);
      assert.equal(updated?.status, "canceled");
      assert.match(updated?.error || "", /already dispatched or removed/);
    } finally {
      db.prepare("DELETE FROM runs WHERE trigger = ?").run(trigger);
    }
  });
});
