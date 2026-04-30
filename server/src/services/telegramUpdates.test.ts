import { afterEach, beforeEach, describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

import { withCompanyContext } from "../company-context";
import { db, kvDel, kvSet } from "../db";
import { getCompanyBySlug, Company } from "./companies";
import { getTelegramPairingState, setNotificationConfig } from "./notifications";
import { pollCurrentCompanyTelegramUpdatesOnce, pollTelegramUpdatesOnce } from "./telegramUpdates";

describe("telegramUpdates", () => {
  const originalFetch = globalThis.fetch;
  let tempHome = "";
  let company: Company | null = null;

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), "aios-telegram-updates-"));
    cleanupTelegramUpdateFixtures();
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
    cleanupTelegramUpdateFixtures();
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

  it("background-polls incomplete companies with enabled paired Telegram agents", async () => {
    assert.ok(company);
    const calls: string[] = [];
    globalThis.fetch = mockAgentTelegramFetch(calls);

    await withCompanyContext(company, () => {
      setNotificationConfig({ channel: "telegram", botToken: "agent:token", chatId: "42" });
      kvSet(`company.${company!.id}.telegram.rootAgent.config`, JSON.stringify({
        enabled: true,
        provider: "codex",
        sessionId: null,
        offset: null,
        resetGeneration: 0,
        updatedAt: Date.now(),
      }));
    });

    const result = await pollTelegramUpdatesOnce({ timeout: 0, skipIfBusy: false });

    const row = db.prepare(`
      SELECT text, status FROM telegram_agent_messages
      WHERE company_id = ? AND update_id = 30
    `).get(company.id) as { text: string; status: string } | undefined;

    assert.equal(result.polled, true);
    assert.deepEqual(calls, ["agent:token:getMe", "agent:token:getUpdates"]);
    assert.equal(row?.text, "run root");
    assert.equal(row?.status, "queued");
  });

  it("continues background polling when one company's Telegram API fails", async () => {
    const failCompany = insertCompany("telegram-fail-company", "A Telegram Fail", "complete");
    const okCompany = insertCompany("telegram-ok-company", "B Telegram OK", "complete");
    const calls: string[] = [];
    globalThis.fetch = mockMultiCompanyTelegramFetch(calls);

    await withCompanyContext(failCompany, () => {
      setNotificationConfig({ channel: "telegram", botToken: "fail:token", chatId: null });
    });
    await withCompanyContext(okCompany, () => {
      setNotificationConfig({ channel: "telegram", botToken: "ok:token", chatId: null });
    });

    const result = await pollTelegramUpdatesOnce({ timeout: 0, skipIfBusy: false });

    assert.equal(result.polled, true);
    await withCompanyContext(okCompany, () => {
      const pairing = getTelegramPairingState();
      assert.equal(pairing?.botUsername, "ok_company_bot");
      assert.equal(pairing?.candidates.length, 1);
      assert.equal(pairing?.candidates[0].chatId, "84");
    });
    assert.deepEqual(calls, ["fail:token:getMe", "ok:token:getMe", "ok:token:getUpdates"]);

    cleanupCompany("telegram-fail-company");
    cleanupCompany("telegram-ok-company");
  });

  it("queues Telegram agent messages during polling without dispatching them synchronously", async () => {
    const agentCompany = insertCompany("telegram-agent-company", "Telegram Agent Company", "complete");
    const calls: string[] = [];
    globalThis.fetch = mockAgentTelegramFetch(calls);

    await withCompanyContext(agentCompany, async () => {
      setNotificationConfig({ channel: "telegram", botToken: "agent:token", chatId: "42" });
      kvSet(`company.${agentCompany.id}.telegram.rootAgent.config`, JSON.stringify({
        enabled: true,
        provider: "codex",
        sessionId: null,
        offset: null,
        resetGeneration: 0,
        updatedAt: Date.now(),
      }));

      await pollCurrentCompanyTelegramUpdatesOnce({ timeout: 0, skipIfBusy: false });
    });

    const row = db.prepare(`
      SELECT text, status FROM telegram_agent_messages
      WHERE company_id = ? AND update_id = 30
    `).get(agentCompany.id) as { text: string; status: string } | undefined;

    assert.deepEqual(calls, ["agent:token:getMe", "agent:token:getUpdates"]);
    assert.equal(row?.text, "run root");
    assert.equal(row?.status, "queued");

    cleanupCompany("telegram-agent-company");
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

function mockMultiCompanyTelegramFetch(calls: string[]): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const { token, method } = parseTelegramRequest(url);
    calls.push(`${token}:${method}`);

    if (token === "fail:token") {
      return new Response(JSON.stringify({ ok: false, description: "Unauthorized" }), { status: 401 });
    }

    if (method === "getMe") {
      return new Response(JSON.stringify({
        ok: true,
        result: { id: 456, first_name: "OK Company", username: "ok_company_bot" },
      }));
    }
    if (method === "getUpdates") {
      const body = JSON.parse(String(init?.body || "{}"));
      assert.equal(body.offset, 0);
      assert.equal(body.timeout, 0);
      return new Response(JSON.stringify({
        ok: true,
        result: [{
          update_id: 20,
          message: {
            message_id: 1,
            text: "pair ok",
            chat: { id: 84, type: "private", first_name: "Owner" },
            from: { id: 84, first_name: "Owner" },
          },
        }],
      }));
    }
    return new Response(JSON.stringify({ ok: false, description: `unexpected ${method}` }), { status: 404 });
  }) as typeof fetch;
}

function mockAgentTelegramFetch(calls: string[]): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const { token, method } = parseTelegramRequest(url);
    calls.push(`${token}:${method}`);

    if (method === "getMe") {
      return new Response(JSON.stringify({
        ok: true,
        result: { id: 789, first_name: "Agent Company", username: "agent_company_bot" },
      }));
    }
    if (method === "getUpdates") {
      const body = JSON.parse(String(init?.body || "{}"));
      assert.equal(body.offset, 0);
      assert.equal(body.timeout, 0);
      return new Response(JSON.stringify({
        ok: true,
        result: [{
          update_id: 30,
          message: {
            message_id: 1,
            text: "run root",
            chat: { id: 42, type: "private", first_name: "Owner" },
            from: { id: 42, first_name: "Owner" },
          },
        }],
      }));
    }
    return new Response(JSON.stringify({ ok: false, description: `unexpected ${method}` }), { status: 404 });
  }) as typeof fetch;
}

function parseTelegramRequest(url: string | URL | Request): { token: string; method: string } {
  const match = String(url).match(/\/bot([^/]+)\/([^/?]+)(?:\?|$)/);
  if (!match) throw new Error(`unexpected Telegram URL: ${String(url)}`);
  return { token: match[1], method: match[2] };
}

function insertCompany(slug: string, displayName: string, setupPhase: string): Company {
  cleanupCompany(slug);
  const now = Date.now();
  db.prepare(`
    INSERT INTO companies(slug, display_name, repo_full_name, repo_dir, setup_phase, is_default, webhook_secret, created_at, updated_at)
    VALUES(?, ?, ?, ?, ?, 0, 'secret', ?, ?)
  `).run(slug, displayName, `acme/${slug}`, join(tempRepoRoot(slug), "repo"), setupPhase, now, now);
  const company = getCompanyBySlug(slug);
  assert.ok(company);
  return company;
}

function tempRepoRoot(slug: string): string {
  return join(tmpdir(), `aios-${slug}`);
}

function cleanupCompany(slug: string) {
  const row = db.prepare("SELECT id FROM companies WHERE slug = ?").get(slug) as { id: number } | undefined;
  if (!row) return;
  db.prepare("DELETE FROM telegram_agent_messages WHERE company_id = ?").run(row.id);
  db.prepare("DELETE FROM kv WHERE k LIKE ?").run(`company.${row.id}.%`);
  db.prepare("DELETE FROM companies WHERE id = ?").run(row.id);
}

function cleanupTelegramUpdateFixtures() {
  for (const slug of [
    "telegram-onboarding-test",
    "telegram-fail-company",
    "telegram-ok-company",
    "telegram-agent-company",
  ]) {
    cleanupCompany(slug);
  }
  kvDel("company.1.notifications.config");
  kvDel("company.1.notifications.telegram.pairing");
  kvDel("notifications.config");
  kvDel("notifications.telegram.pairing");
}
