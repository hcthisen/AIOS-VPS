import { afterEach, beforeEach, describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

import { db, kvDel } from "../db";
import {
  buildTelegramRootPrompt,
  enqueueTelegramAgentMessage,
  getTelegramAgentStatus,
  resetTelegramAgentSession,
  saveTelegramAgentConfig,
  TelegramAgentMessage,
} from "./telegramAgent";

describe("telegramAgent", () => {
  let previousAiosHome: string | undefined;
  let tempHome = "";

  beforeEach(async () => {
    previousAiosHome = process.env.AIOS_HOME;
    tempHome = await mkdtemp(join(tmpdir(), "aios-telegram-agent-home-"));
    process.env.AIOS_HOME = tempHome;
    db.prepare("DELETE FROM telegram_agent_messages").run();
    kvDel("telegram.rootAgent.config");
  });

  afterEach(async () => {
    if (previousAiosHome === undefined) delete process.env.AIOS_HOME;
    else process.env.AIOS_HOME = previousAiosHome;
    await rm(tempHome, { recursive: true, force: true });
  });

  it("deduplicates Telegram updates by update id", () => {
    assert.equal(enqueueTelegramAgentMessage({ updateId: 123, chatId: "42", text: "hello" }), true);
    assert.equal(enqueueTelegramAgentMessage({ updateId: 123, chatId: "42", text: "hello again" }), false);

    const row = db.prepare("SELECT COUNT(*) AS count FROM telegram_agent_messages").get() as { count: number };
    assert.equal(row.count, 1);
  });

  it("wraps queued owner messages as a Root Telegram chat prompt", () => {
    const messages: TelegramAgentMessage[] = [
      {
        id: 1,
        update_id: 1,
        chat_id: "42",
        text: "Check the whole system.",
        status: "queued",
        run_id: null,
        provider: null,
        session_id: null,
        received_at: Date.UTC(2026, 3, 25, 8, 0, 0),
        started_at: null,
        finished_at: null,
        error: null,
      },
    ];

    const prompt = buildTelegramRootPrompt(messages);

    assert.match(prompt, /Root agent/);
    assert.match(prompt, /repository root/);
    assert.match(prompt, /department folders directly/);
    assert.match(prompt, /Telegram-friendly chat style/);
    assert.match(prompt, /Message from owner via Telegram/);
    assert.match(prompt, /Check the whole system/);
  });

  it("reset cancels queued messages and clears the provider session", () => {
    enqueueTelegramAgentMessage({ updateId: 124, chatId: "42", text: "queued" });

    const result = resetTelegramAgentSession();
    const row = db.prepare("SELECT status, error FROM telegram_agent_messages WHERE update_id = 124").get() as { status: string; error: string };

    assert.equal(result.sessionId, null);
    assert.equal(result.canceled, 1);
    assert.equal(row.status, "canceled");
    assert.match(row.error, /session reset/);
  });

  it("rejects unauthorized Telegram agent providers", async () => {
    await assert.rejects(
      () => saveTelegramAgentConfig({ enabled: true, provider: "codex" }),
      /Codex is not authorized/,
    );
  });

  it("normalizes to the authorized provider in status", async () => {
    await mkdir(join(tempHome, ".codex"), { recursive: true });
    await writeFile(join(tempHome, ".codex", "auth.json"), "{}\n", "utf-8");

    const status = await getTelegramAgentStatus();

    assert.equal(status.provider, "codex");
    assert.equal(status.providers.codex.authorized, true);
    assert.equal(status.providers.claudeCode.authorized, false);
  });
});
