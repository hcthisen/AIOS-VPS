import { Router, badRequest } from "../http";
import { adminOnly } from "../auth";
import { advanceSetupPhase, getSetupPhase, setSetupPhase } from "../setup-phase";
import {
  anthropicAuthDetected, codexAuthDetected,
  startAnthropicSession, getAnthropicSession, submitAnthropicCode, cancelAnthropicSession,
  startOpenAiDeviceAuth, getOpenAiSession, cancelOpenAiSession,
  readAnthropicSnapshot,
} from "../services/provider-auth";

export function registerProviderAuthRoutes(router: Router) {
  const guard = adminOnly();

  // ---------- Anthropic ----------
  router.post("/api/provider-auth/anthropic/start", async (req, res) => {
    await guard(req, res);
    try {
      const s = await startAnthropicSession();
      res.json(s);
    } catch (e: any) { res.error(409, String(e?.message || e)); }
  });

  router.post("/api/provider-auth/anthropic/submit", async (req, res) => {
    await guard(req, res);
    const raw = String(req.body?.code || "");
    if (!raw) throw badRequest("code required");
    const out = await submitAnthropicCode(raw);
    if (out.status === "complete") {
      await maybeAdvanceProviderPhase();
    }
    res.json({ ...out, setupPhase: getSetupPhase() });
  });

  router.post("/api/provider-auth/anthropic/cancel", async (req, res) => {
    await guard(req, res);
    cancelAnthropicSession();
    res.json({ ok: true });
  });

  router.get("/api/provider-auth/anthropic", async (req, res) => {
    await guard(req, res);
    const session = getAnthropicSession();
    const detected = await anthropicAuthDetected();
    const snapshot = detected ? await readAnthropicSnapshot() : undefined;
    res.json({
      session,
      detected,
      snapshot,
    });
  });

  // ---------- OpenAI Codex ----------
  router.post("/api/provider-auth/openai/start", async (req, res) => {
    await guard(req, res);
    try {
      const s = await startOpenAiDeviceAuth();
      res.json(s);
    } catch (e: any) { res.error(409, String(e?.message || e)); }
  });

  router.post("/api/provider-auth/openai/cancel", async (req, res) => {
    await guard(req, res);
    cancelOpenAiSession();
    res.json({ ok: true });
  });

  router.get("/api/provider-auth/openai", async (req, res) => {
    await guard(req, res);
    const session = getOpenAiSession();
    const detected = await codexAuthDetected();
    if (session?.status === "complete" || (detected && !session)) {
      await maybeAdvanceProviderPhase();
    }
    res.json({ session, detected, setupPhase: getSetupPhase() });
  });

  // ---------- Combined status ----------
  router.get("/api/provider-auth/status", async (req, res) => {
    await guard(req, res);
    const [anthropic, openai] = await Promise.all([
      anthropicAuthDetected(),
      codexAuthDetected(),
    ]);
    if ((anthropic || openai) && getSetupPhase() === "provider_setup") {
      await maybeAdvanceProviderPhase();
    }
    res.json({
      anthropic: { detected: anthropic, session: getAnthropicSession() },
      openai: { detected: openai, session: getOpenAiSession() },
      setupPhase: getSetupPhase(),
    });
  });

  // ---------- Skip ----------
  router.post("/api/provider-auth/skip", async (req, res) => {
    await guard(req, res);
    if (getSetupPhase() === "provider_setup") setSetupPhase("github_setup");
    res.json({ ok: true, setupPhase: getSetupPhase() });
  });
}

async function maybeAdvanceProviderPhase() {
  const [anthropic, openai] = await Promise.all([
    anthropicAuthDetected(), codexAuthDetected(),
  ]);
  if ((anthropic || openai) && getSetupPhase() === "provider_setup") {
    advanceSetupPhase("provider_setup");
  }
}
