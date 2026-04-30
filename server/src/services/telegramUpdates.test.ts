import { afterEach, beforeEach, describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

import { withCompanyContext } from "../company-context";
import { db } from "../db";
import { getCompanyBySlug, Company } from "./companies";
import { getTelegramPairingState, setNotificationConfig } from "./notifications";
import { pollCurrentCompanyTelegramUpdatesOnce, pollTelegramUpdatesOnce } from "./telegramUpdates";

describe("telegramUpdates", () => {
  const originalFetch = globalThis.fetch;
  let tempHome = "";
  let company: Company | null = null;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), "aios-telegram-updates-"));
    cleanupCompany("telegram-onboarding-test");
    const now = Date.now();
    const result = db.prepare(`
      INSERT INTO companies(slug, display_name, repo_full_name, repo_dir, setup_phase, is_default, webhook_secret, created_at, updated_at)
      VALUES('telegram-onboarding-test', 'Telegram Onboarding Test', 'acme/telegram-onboarding-test', ?, 'notifications', 0, 'secret', ?, ?)
    `).run(join(tempHome, "repo"), now, now);
    company = getCompanyBySlug("telegram-onboarding-test");
    assert.equal(company?.id, Number(result.lastInsertRowid));
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    cleanupCompany("telegram-onboarding-test");
    await rm(tempHome, { recursive: true, force: true });
    company = null;
  });

  it("polls the current company while it is still in notification setup", async () => {
    assert.ok(company);
    const calls: string[] = [];
    globalThis.fetch = mockTelegramFetch(calls);

    await withCompanyContext(company, async () => {
      setNotificationConfig({ channel: "telegram", botToken: "123:test", chatId: null });

      const result = await pollCurrentCompanyTelegramUpdatesOnce({ timeout: 0, skipIfBusy: false });
      const pairing = getTelegramPairingState();

      assert.equal(result.polled, true);
      assert.equal(pairing?.botUsername, "company_test_bot");
      assert.equal(pairing?.candidates.length, 1);
      assert.equal(pairing?.candidates[0].chatId, "42");
      assert.equal(pairing?.candidates[0].lastMessage, "pair me");
    });

    assert.deepEqual(calls, ["getMe", "getUpdates"]);
  });

  it("does not background-poll companies that are not complete", async () => {
    assert.ok(company);
    const calls: string[] = [];
    globalThis.fetch = mockTelegramFetch(calls);

    await withCompanyContext(company, () => {
      setNotificationConfig({ channel: "telegram", botToken: "123:test", chatId: null });
    });

    await pollTelegramUpdatesOnce({ timeout: 0, skipIfBusy: true });

    assert.deepEqual(calls, []);
  });
});

function mockTelegramFetch(calls: string[]): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const rawUrl = String(url);
    if (rawUrl.endsWith("/getMe")) {
      calls.push("getMe");
      return new Response(JSON.stringify({
        ok: true,
        result: { id: 123, first_name: "Company Test", username: "company_test_bot" },
      }));
    }
    if (rawUrl.endsWith("/getUpdates")) {
      calls.push("getUpdates");
      const body = JSON.parse(String(init?.body || "{}"));
      assert.equal(body.offset, 0);
      assert.equal(body.timeout, 0);
      return new Response(JSON.stringify({
        ok: true,
        result: [{
          update_id: 10,
          message: {
            message_id: 1,
            text: "pair me",
            chat: { id: 42, type: "private", first_name: "Owner" },
            from: { id: 42, first_name: "Owner" },
          },
        }],
      }));
    }
    return new Response(JSON.stringify({ ok: false, description: `unexpected ${rawUrl}` }), { status: 404 });
  }) as typeof fetch;
}

function cleanupCompany(slug: string) {
  const row = db.prepare("SELECT id FROM companies WHERE slug = ?").get(slug) as { id: number } | undefined;
  if (!row) return;
  db.prepare("DELETE FROM telegram_agent_messages WHERE company_id = ?").run(row.id);
  db.prepare("DELETE FROM kv WHERE k LIKE ?").run(`company.${row.id}.%`);
  db.prepare("DELETE FROM companies WHERE id = ?").run(row.id);
}
