import { afterEach, beforeEach, describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

import { withCompanyContext } from "../company-context";
import { db, kvDel, kvGet, kvSet } from "../db";
import {
  buildTelegramRootPrompt,
  dispatchTelegramAgentQueue,
  enqueueTelegramAgentMessage,
  getTelegramAgentStatus,
  isTelegramAgentConfiguredForCurrentCompany,
  processTelegramAgentUpdates,
  resetTelegramAgentSession,
  saveTelegramAgentConfig,
  setTelegramVoiceTranscriberForTests,
  TelegramAgentMessage,
} from "./telegramAgent";
import { setNotificationConfig } from "./notifications";
import { TelegramVoiceTranscriptionError } from "./telegramTranscription";
import { Company, getCompanyBySlug } from "./companies";

describe("telegramAgent", () => {
  let previousAiosHome: string | undefined;
  let tempHome = "";

  beforeEach(async () => {
    previousAiosHome = process.env.AIOS_HOME;
    tempHome = await mkdtemp(join(tmpdir(), "aios-telegram-agent-home-"));
    process.env.AIOS_HOME = tempHome;
    db.prepare("DELETE FROM telegram_agent_messages").run();
    db.prepare("DELETE FROM claims").run();
    kvDel("telegram.rootAgent.config");
    kvDel("company.1.telegram.rootAgent.config");
    kvDel("company.1.notifications.config");
    setTelegramVoiceTranscriberForTests(null);
  });

  afterEach(async () => {
    setTelegramVoiceTranscriberForTests(null);
    if (previousAiosHome === undefined) delete process.env.AIOS_HOME;
    else process.env.AIOS_HOME = previousAiosHome;
    kvDel("telegram.rootAgent.config");
    kvDel("company.1.telegram.rootAgent.config");
    kvDel("company.1.notifications.config");
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

  it("keeps the saved provider unchanged when status is read", async () => {
    await mkdir(join(tempHome, ".claude"), { recursive: true });
    await writeFile(join(tempHome, ".claude", ".credentials.json"), "{}\n", "utf-8");
    kvSet("company.1.telegram.rootAgent.config", JSON.stringify({
      enabled: true,
      provider: "codex",
      sessionId: "codex-session",
      offset: null,
      resetGeneration: 7,
      updatedAt: Date.now(),
    }));

    const status = await getTelegramAgentStatus();
    const stored = JSON.parse(kvGet("company.1.telegram.rootAgent.config") || "{}");

    assert.equal(status.provider, "codex");
    assert.equal(status.providerAuthorized, false);
    assert.equal(status.providers.claudeCode.authorized, true);
    assert.equal(stored.provider, "codex");
    assert.equal(stored.sessionId, "codex-session");
    assert.equal(stored.resetGeneration, 7);
  });

  it("does not auto-select the only authorized provider in status", async () => {
    await mkdir(join(tempHome, ".codex"), { recursive: true });
    await writeFile(join(tempHome, ".codex", "auth.json"), "{}\n", "utf-8");

    const status = await getTelegramAgentStatus();

    assert.equal(status.provider, "claude-code");
    assert.equal(status.providerAuthorized, false);
    assert.equal(status.providers.codex.authorized, true);
    assert.equal(status.providers.claudeCode.authorized, false);
  });

  it("clears provider session state when the Telegram agent provider changes", async () => {
    await mkdir(join(tempHome, ".claude"), { recursive: true });
    await writeFile(join(tempHome, ".claude", ".credentials.json"), "{}\n", "utf-8");
    kvSet("company.1.telegram.rootAgent.config", JSON.stringify({
      enabled: true,
      provider: "codex",
      sessionId: "codex-session",
      offset: null,
      resetGeneration: 3,
      updatedAt: Date.now(),
    }));

    const status = await saveTelegramAgentConfig({ provider: "claude-code" });
    const stored = JSON.parse(kvGet("company.1.telegram.rootAgent.config") || "{}");

    assert.equal(status.provider, "claude-code");
    assert.equal(status.sessionId, null);
    assert.equal(status.resetGeneration, 4);
    assert.equal(stored.provider, "claude-code");
    assert.equal(stored.sessionId, null);
    assert.equal(stored.resetGeneration, 4);
  });

  it("expires stale root claims before dispatching queued Telegram messages", async () => {
    const originalFetch = globalThis.fetch;
    const company = insertCompany("telegram-agent-stale-claim", "Telegram Agent Stale Claim");
    const updateId = 100_000 + company.id;
    globalThis.fetch = mockTelegramSendFetch();
    try {
      await withCompanyContext(company, async () => {
        setNotificationConfig({ channel: "telegram", botToken: "123:test", chatId: "42" });
        kvSet(`company.${company.id}.telegram.rootAgent.config`, JSON.stringify({
          enabled: true,
          provider: "codex",
          sessionId: null,
          offset: null,
          resetGeneration: 0,
          updatedAt: Date.now(),
        }));
        enqueueTelegramAgentMessage({ updateId, chatId: "42", text: "process me" });
        db.prepare(`
          INSERT INTO claims(company_id, department, run_id, claimed_at, expires_at)
          VALUES(?, '_root', 'stale-run', ?, ?)
        `).run(company.id, Date.now() - 10_000, Date.now() - 1);

        await dispatchTelegramAgentQueue();

        const message = db.prepare("SELECT status, error FROM telegram_agent_messages WHERE company_id = ? AND update_id = ?").get(company.id, updateId) as { status: string; error: string };
        const claim = db.prepare("SELECT 1 FROM claims WHERE company_id = ? AND department = '_root'").get(company.id);
        assert.equal(claim, undefined);
        assert.equal(message.status, "failed");
        assert.match(message.error, /Codex is not authorized/);
      });
    } finally {
      globalThis.fetch = originalFetch;
      cleanupCompany("telegram-agent-stale-claim");
    }
  });

  it("identifies enabled paired Telegram agents as runnable even before company setup is complete", () => {
    const company = insertCompany("telegram-agent-incomplete", "Telegram Agent Incomplete");
    try {
      withCompanyContext(company, () => {
        setNotificationConfig({ channel: "telegram", botToken: "123:test", chatId: "42" });
        kvSet(`company.${company.id}.telegram.rootAgent.config`, JSON.stringify({
          enabled: true,
          provider: "codex",
          sessionId: null,
          offset: null,
          resetGeneration: 0,
          updatedAt: Date.now(),
        }));

        assert.equal(isTelegramAgentConfiguredForCurrentCompany(), true);
      });
    } finally {
      cleanupCompany("telegram-agent-incomplete");
    }
  });

  it("queues approved Telegram voice transcripts as Root agent messages", async () => {
    setNotificationConfig({ channel: "telegram", botToken: "123:test", chatId: "42" });
    kvSet("company.1.telegram.rootAgent.config", JSON.stringify({
      enabled: true,
      provider: "codex",
      sessionId: null,
      offset: null,
      resetGeneration: 0,
      updatedAt: Date.now(),
    }));
    setTelegramVoiceTranscriberForTests(async ({ botToken, fileId }) => {
      assert.equal(botToken, "123:test");
      assert.equal(fileId, "voice-file");
      return "Check the overnight deploy.";
    });

    await processTelegramAgentUpdates([{
      update_id: 500,
      message: {
        message_id: 1,
        voice: { file_id: "voice-file" },
        chat: { id: 42, type: "private", first_name: "Owner" },
        from: { id: 42, first_name: "Owner" },
      },
    }]);

    const row = db.prepare("SELECT text, status FROM telegram_agent_messages WHERE update_id = 500").get() as { text: string; status: string };
    assert.equal(row.status, "queued");
    assert.equal(row.text, "[Voice message transcript]\nCheck the overnight deploy.");
  });

  it("ignores Telegram voice messages from unapproved chats", async () => {
    let called = false;
    setNotificationConfig({ channel: "telegram", botToken: "123:test", chatId: "42" });
    kvSet("company.1.telegram.rootAgent.config", JSON.stringify({
      enabled: true,
      provider: "codex",
      sessionId: null,
      offset: null,
      resetGeneration: 0,
      updatedAt: Date.now(),
    }));
    setTelegramVoiceTranscriberForTests(async () => {
      called = true;
      return "nope";
    });

    await processTelegramAgentUpdates([{
      update_id: 501,
      message: {
        message_id: 1,
        voice: { file_id: "voice-file" },
        chat: { id: 77, type: "private", first_name: "Other" },
        from: { id: 77, first_name: "Other" },
      },
    }]);

    const row = db.prepare("SELECT 1 FROM telegram_agent_messages WHERE update_id = 501").get();
    assert.equal(row, undefined);
    assert.equal(called, false);
  });

  it("reports voice transcription setup errors without queueing a Root agent message", async () => {
    const originalFetch = globalThis.fetch;
    const sent: any[] = [];
    globalThis.fetch = mockTelegramSendFetch(sent);
    try {
      setNotificationConfig({ channel: "telegram", botToken: "123:test", chatId: "42" });
      kvSet("company.1.telegram.rootAgent.config", JSON.stringify({
        enabled: true,
        provider: "codex",
        sessionId: null,
        offset: null,
        resetGeneration: 0,
        updatedAt: Date.now(),
      }));
      setTelegramVoiceTranscriberForTests(async () => {
        throw new TelegramVoiceTranscriptionError("missing_key", "OPENAI_API_KEY is missing");
      });

      await processTelegramAgentUpdates([{
        update_id: 502,
        message: {
          message_id: 1,
          voice: { file_id: "voice-file" },
          chat: { id: 42, type: "private", first_name: "Owner" },
          from: { id: 42, first_name: "Owner" },
        },
      }]);

      const row = db.prepare("SELECT 1 FROM telegram_agent_messages WHERE update_id = 502").get();
      assert.equal(row, undefined);
      assert.equal(sent.length, 1);
      assert.match(String(sent[0].text), /OPENAI_API_KEY/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

function mockTelegramSendFetch(sent: any[] = []): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const rawUrl = String(url);
    if (rawUrl.endsWith("/sendMessage")) {
      sent.push(JSON.parse(String(init?.body || "{}")));
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
    }
    return new Response(JSON.stringify({ ok: false, description: `unexpected ${rawUrl}` }), { status: 404 });
  }) as typeof fetch;
}

function insertCompany(slug: string, displayName: string): Company {
  cleanupCompany(slug);
  const now = Date.now();
  db.prepare(`
    INSERT INTO companies(slug, display_name, repo_full_name, repo_dir, setup_phase, is_default, webhook_secret, created_at, updated_at)
    VALUES(?, ?, ?, ?, 'notifications', 0, 'secret', ?, ?)
  `).run(slug, displayName, `acme/${slug}`, join(tmpdir(), `aios-${slug}`, "repo"), now, now);
  const company = getCompanyBySlug(slug);
  assert.ok(company);
  return company;
}

function cleanupCompany(slug: string) {
  const row = db.prepare("SELECT id FROM companies WHERE slug = ?").get(slug) as { id: number } | undefined;
  if (!row) return;
  db.prepare("DELETE FROM telegram_agent_messages WHERE company_id = ?").run(row.id);
  db.prepare("DELETE FROM claims WHERE company_id = ?").run(row.id);
  db.prepare("DELETE FROM kv WHERE k LIKE ?").run(`company.${row.id}.%`);
  db.prepare("DELETE FROM companies WHERE id = ?").run(row.id);
}
