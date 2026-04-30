import { afterEach, describe, it } from "node:test";
import { strict as assert } from "node:assert";

import { deleteGitHubPushWebhook, ensureGitHubPushWebhook, parseGitHubFullNameFromRemote } from "./github";

describe("github webhook setup", () => {
  const originalFetch = globalThis.fetch;
  const originalSecret = process.env.AIOS_GITHUB_WEBHOOK_SECRET;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (typeof originalSecret === "undefined") delete process.env.AIOS_GITHUB_WEBHOOK_SECRET;
    else process.env.AIOS_GITHUB_WEBHOOK_SECRET = originalSecret;
  });

  it("parses GitHub full names from common remote URLs", () => {
    assert.equal(parseGitHubFullNameFromRemote("https://github.com/acme/ops.git"), "acme/ops");
    assert.equal(parseGitHubFullNameFromRemote("https://user:token@github.com/acme/ops.git"), "acme/ops");
    assert.equal(parseGitHubFullNameFromRemote("git@github.com:acme/ops.git"), "acme/ops");
    assert.equal(parseGitHubFullNameFromRemote("https://example.com/acme/ops.git"), null);
  });

  it("creates a push webhook with the configured receiver URL and secret", async () => {
    process.env.AIOS_GITHUB_WEBHOOK_SECRET = "test-secret";
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith("/hooks?per_page=100")) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response(JSON.stringify({ id: 123 }), { status: 201 });
    }) as typeof fetch;

    const result = await ensureGitHubPushWebhook("pat-token", "acme/ops", { baseUrl: "https://aios.example.test/" });

    assert.deepEqual(result, {
      ok: true,
      url: "https://aios.example.test/github/webhook",
      hookId: 123,
      action: "created",
    });
    assert.equal(calls[1].url, "https://api.github.com/repos/acme/ops/hooks");
    assert.equal(calls[1].init?.method, "POST");
    const body = JSON.parse(String(calls[1].init?.body || "{}"));
    assert.equal(body.config.url, "https://aios.example.test/github/webhook");
    assert.equal(body.config.secret, "test-secret");
    assert.deepEqual(body.events, ["push"]);
  });

  it("updates an existing webhook for the same receiver URL", async () => {
    process.env.AIOS_GITHUB_WEBHOOK_SECRET = "test-secret";
    const methods: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      methods.push(String(init?.method || "GET"));
      if (String(url).endsWith("/hooks?per_page=100")) {
        return new Response(JSON.stringify([{ id: 456, config: { url: "https://aios.example.test/github/webhook" } }]), { status: 200 });
      }
      return new Response(JSON.stringify({ id: 456 }), { status: 200 });
    }) as typeof fetch;

    const result = await ensureGitHubPushWebhook("pat-token", "acme/ops", { baseUrl: "https://aios.example.test" });

    assert.equal(result.ok, true);
    assert.equal(result.ok ? result.action : "", "updated");
    assert.deepEqual(methods, ["GET", "PATCH"]);
  });

  it("deletes an existing webhook for the same receiver URL", async () => {
    const calls: Array<{ url: string; method: string }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), method: String(init?.method || "GET") });
      if (String(url).endsWith("/hooks?per_page=100")) {
        return new Response(JSON.stringify([
          { id: 111, config: { url: "https://other.example.test/github/webhook" } },
          { id: 222, config: { url: "https://aios.example.test/github/webhook/acme" } },
        ]), { status: 200 });
      }
      return new Response(null, { status: 204 });
    }) as typeof fetch;

    const result = await deleteGitHubPushWebhook("pat-token", "acme/ops", {
      baseUrl: "https://aios.example.test",
      path: "/github/webhook/acme",
    });

    assert.deepEqual(result, {
      ok: true,
      url: "https://aios.example.test/github/webhook/acme",
      deleted: true,
      hookId: 222,
    });
    assert.deepEqual(calls.map((call) => call.method), ["GET", "DELETE"]);
    assert.equal(calls[1].url, "https://api.github.com/repos/acme/ops/hooks/222");
  });
});
