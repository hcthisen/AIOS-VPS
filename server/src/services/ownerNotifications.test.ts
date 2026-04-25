import { afterEach, beforeEach, describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { existsSync } from "fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

import { config } from "../config";
import { db, kvDel } from "../db";
import { createDepartment } from "./departments";
import { ensureAutomationWorkspace } from "./repo";
import {
  listOwnerNotifications,
  markOwnerNotificationRead,
  processOwnerNotificationOutbox,
} from "./ownerNotifications";
import { runSyncLayer } from "./sync";

describe("ownerNotifications", () => {
  let tempRoot = "";
  const prevRepoDir = config.repoDir;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "aios-owner-notifications-"));
    config.repoDir = tempRoot;
    await writeFile(join(tempRoot, "aios.yaml"), "version: 1\ndepartments:\n  - sample\n", "utf-8");
    await mkdir(join(tempRoot, "sample"), { recursive: true });
    await writeFile(join(tempRoot, "CLAUDE.md"), "# Root\n", "utf-8");
    await writeFile(join(tempRoot, "AGENTS.md"), "# Root\n", "utf-8");
    await writeFile(join(tempRoot, "sample", "CLAUDE.md"), "# Sample\n", "utf-8");
    await writeFile(join(tempRoot, "sample", "AGENTS.md"), "# Sample\n", "utf-8");
    await ensureAutomationWorkspace(tempRoot);
    await ensureAutomationWorkspace(join(tempRoot, "sample"));
    db.prepare("DELETE FROM owner_notifications").run();
    kvDel("notifications.config");
  });

  afterEach(async () => {
    config.repoDir = prevRepoDir;
    db.prepare("DELETE FROM owner_notifications").run();
    kvDel("notifications.config");
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("stores outbox markdown, clears the file, and marks no channel when delivery is not configured", async () => {
    const outboxFile = join(tempRoot, "sample", "outbox", "2026-04-25-website.md");
    await writeFile(outboxFile, [
      "---",
      "title: Website fixed",
      "priority: warning",
      "tags: [monitoring, website]",
      "---",
      "",
      "The website was down and is now responding normally.",
      "",
    ].join("\n"), "utf-8");

    const result = await processOwnerNotificationOutbox({ runId: "run-1" });
    const { notifications } = listOwnerNotifications();

    assert.equal(result.inserted, 1);
    assert.equal(result.noChannel, 1);
    assert.equal(existsSync(outboxFile), false);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].source_scope, "sample");
    assert.equal(notifications[0].title, "Website fixed");
    assert.equal(notifications[0].priority, "warning");
    assert.equal(notifications[0].status, "no_channel");
    assert.match(notifications[0].body, /responding normally/);
  });

  it("stores invalid files as failed notifications and does not deliver them", async () => {
    const outboxFile = join(tempRoot, "outbox", "empty.md");
    await writeFile(outboxFile, "---\ntitle: Empty\n---\n", "utf-8");

    const result = await processOwnerNotificationOutbox();
    const { notifications } = listOwnerNotifications();

    assert.equal(result.inserted, 1);
    assert.equal(result.failed, 1);
    assert.equal(existsSync(outboxFile), false);
    assert.equal(notifications[0].status, "failed");
    assert.match(notifications[0].last_error || "", /invalid outbox notification/);
  });

  it("marks notifications read and unread", async () => {
    await writeFile(join(tempRoot, "outbox", "hello.md"), "Hello owner.\n", "utf-8");
    await processOwnerNotificationOutbox();
    const notification = listOwnerNotifications().notifications[0];

    const read = markOwnerNotificationRead(notification.id, true);
    assert.ok(read?.read_at);
    const unread = markOwnerNotificationRead(notification.id, false);
    assert.equal(unread?.read_at, null);
  });

  it("adds outbox folders, skills, and managed instructions to new departments during sync", async () => {
    await createDepartment({ name: "Marketing" });
    await runSyncLayer({ commit: false });

    await stat(join(tempRoot, "marketing", "outbox", ".gitkeep"));
    await stat(join(tempRoot, "marketing", "skills", "outbox-notifications", "SKILL.md"));
    const claude = await readFile(join(tempRoot, "marketing", "CLAUDE.md"), "utf-8");
    const agents = await readFile(join(tempRoot, "marketing", "AGENTS.md"), "utf-8");
    assert.match(claude, /aios:managed:owner-notifications start/);
    assert.match(agents, /outbox-notifications/);
  });
});
