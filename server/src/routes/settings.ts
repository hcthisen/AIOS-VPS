import { mkdir, writeFile, chmod } from "fs/promises";
import { join } from "path";

import { adminOnly } from "../auth";
import { config } from "../config";
import { badRequest, conflict, Router } from "../http";
import { getGithubCreds, setGithubCreds, verifyPat } from "../services/github";
import {
  approveTelegramPairing,
  getNotificationConfig,
  getTelegramPairingState,
  primeTelegramPairing,
  sendNotification,
  setNotificationConfig,
  syncTelegramPairing,
} from "../services/notifications";
import {
  getSystemUpdateSnapshot,
  saveSystemUpdaterConfig,
  startSystemUpdate,
  validateSystemUpdaterInput,
} from "../services/systemUpdate";
import { activeProcessCount } from "../services/executor";
import {
  getTelegramAgentStatus,
  resetTelegramAgentSession,
  saveTelegramAgentConfig,
} from "../services/telegramAgent";
import { pollTelegramUpdatesOnce } from "../services/telegramUpdates";

function githubStatus() {
  const creds = getGithubCreds();
  return {
    connected: !!creds,
    mode: creds?.mode || null,
    username: creds?.username || null,
    hasPrivateKey: !!creds?.privateKeyPath,
  };
}

function redactNotifications() {
  const configValue = getNotificationConfig();
  if (configValue.channel === "telegram") {
    const pairing = getTelegramPairingState();
    return {
      channel: "telegram",
      chatId: configValue.chatId || null,
      paired: !!configValue.chatId,
      botName: pairing?.botName,
      botUsername: pairing?.botUsername,
    };
  }
  if (configValue.channel === "email") {
    return {
      channel: "email",
      from: configValue.from,
      to: configValue.to,
      smtpHost: configValue.smtpHost,
      smtpPort: configValue.smtpPort,
      smtpUser: configValue.smtpUser,
      secure: configValue.secure,
    };
  }
  return { channel: "none" };
}

async function saveGithubConnection(body: any) {
  const mode = String(body?.mode || "pat");
  if (mode === "pat") {
    const token = String(body?.token || "");
    if (!token) throw badRequest("token required");
    const verified = await verifyPat(token);
    if (!verified.ok) throw badRequest(`github verify failed: ${verified.error}`);
    setGithubCreds({ mode: "pat", username: verified.login, token });
    return { ok: true, mode, login: verified.login };
  }

  if (mode !== "deploy_key") throw badRequest("unsupported github mode");
  const privateKey = String(body?.privateKey || "").trim();
  if (!privateKey.includes("PRIVATE KEY")) throw badRequest("private SSH key required");
  const keyPath = join(config.dataDir, "github_deploy_key");
  await mkdir(config.dataDir, { recursive: true });
  await writeFile(keyPath, `${privateKey}\n`, "utf-8");
  try { await chmod(keyPath, 0o600); } catch {}
  setGithubCreds({ mode: "deploy_key", privateKeyPath: keyPath });
  return { ok: true, mode };
}

async function saveNotifications(body: any) {
  const channel = String(body?.channel || "").trim();
  if (channel === "telegram") {
    const botToken = String(body?.botToken || "").trim();
    if (!botToken) throw badRequest("botToken required");
    const pairing = await primeTelegramPairing(botToken);
    setNotificationConfig({ channel: "telegram", botToken, chatId: null });
    return { ok: true, paired: false, ...pairing };
  }

  if (channel === "email") {
    const required = ["from", "to", "smtpHost", "smtpPort"];
    for (const key of required) if (!body[key]) throw badRequest(`${key} required`);
    setNotificationConfig({
      channel: "email",
      from: String(body.from),
      to: String(body.to),
      smtpHost: String(body.smtpHost),
      smtpPort: Number(body.smtpPort),
      smtpUser: body.smtpUser ? String(body.smtpUser) : undefined,
      smtpPass: body.smtpPass ? String(body.smtpPass) : undefined,
      secure: !!body.secure,
    });
    return { ok: true };
  }

  if (channel === "none") {
    setNotificationConfig({ channel: "none" });
    return { ok: true };
  }

  throw badRequest("unknown channel");
}

async function respondSystemUpdateStatus(res: any, opts: { forceCheck?: boolean; refreshIfStale?: boolean } = {}) {
  const snapshot = await getSystemUpdateSnapshot(opts);
  const active = activeProcessCount();
  res.json({
    ...snapshot,
    activeProcesses: active,
    canStartUpdate: snapshot.canStartUpdate && active === 0,
  });
}

export function registerSettingsRoutes(router: Router) {
  const guard = adminOnly();

  router.get("/api/settings/telegram-agent/status", async (req, res) => {
    await guard(req, res);
    res.json(await getTelegramAgentStatus());
  });

  router.post("/api/settings/telegram-agent/config", async (req, res) => {
    await guard(req, res);
    const provider = String(req.body?.provider || "").trim();
    const parsedProvider = provider === "claude-code" || provider === "codex" ? provider : undefined;
    if (provider && !parsedProvider) {
      throw badRequest("provider must be claude-code or codex");
    }
    try {
      res.json(await saveTelegramAgentConfig({
        enabled: typeof req.body?.enabled === "boolean" ? req.body.enabled : undefined,
        provider: parsedProvider,
      }));
    } catch (e: any) {
      throw badRequest(String(e?.message || e));
    }
  });

  router.post("/api/settings/telegram-agent/reset", async (req, res) => {
    await guard(req, res);
    res.json({ ok: true, ...resetTelegramAgentSession(), status: await getTelegramAgentStatus() });
  });

  router.get("/api/settings/system-update/status", async (req, res) => {
    await guard(req, res);
    await respondSystemUpdateStatus(res, { refreshIfStale: true });
  });

  router.post("/api/settings/system-update/check", async (req, res) => {
    await guard(req, res);
    await respondSystemUpdateStatus(res, { forceCheck: true });
  });

  router.post("/api/settings/system-update/config", async (req, res) => {
    await guard(req, res);
    try {
      validateSystemUpdaterInput(req.body || {});
    } catch (e: any) {
      throw badRequest(String(e?.message || e));
    }
    saveSystemUpdaterConfig({
      repoUrl: req.body?.repoUrl,
      branch: req.body?.branch,
    });
    await respondSystemUpdateStatus(res, { forceCheck: true });
  });

  router.post("/api/settings/system-update/start", async (req, res) => {
    await guard(req, res);
    if (activeProcessCount() > 0) throw conflict("wait for active runs to finish before updating");
    try {
      await startSystemUpdate(req.actor?.email || "admin");
    } catch (e: any) {
      throw conflict(String(e?.message || e));
    }
    res.json({ ok: true });
  });

  router.get("/api/settings/github/status", async (req, res) => {
    await guard(req, res);
    res.json(githubStatus());
  });

  router.post("/api/settings/github/connect", async (req, res) => {
    await guard(req, res);
    res.json(await saveGithubConnection(req.body || {}));
  });

  router.get("/api/settings/notifications/config", async (req, res) => {
    await guard(req, res);
    res.json(redactNotifications());
  });

  router.post("/api/settings/notifications/save", async (req, res) => {
    await guard(req, res);
    res.json(await saveNotifications(req.body || {}));
  });

  router.get("/api/settings/notifications/telegram/pairing", async (req, res) => {
    await guard(req, res);
    try {
      await pollTelegramUpdatesOnce({ timeout: 0, skipIfBusy: true });
      const pairing = await syncTelegramPairing();
      res.json({ ok: true, ...pairing });
    } catch (e: any) {
      throw badRequest(String(e?.message || e));
    }
  });

  router.post("/api/settings/notifications/telegram/approve", async (req, res) => {
    await guard(req, res);
    const chatId = String(req.body?.chatId || "").trim();
    if (!chatId) throw badRequest("chatId required");
    try {
      const candidate = approveTelegramPairing(chatId);
      res.json({ ok: true, candidate, chatId });
    } catch (e: any) {
      throw badRequest(String(e?.message || e));
    }
  });

  router.post("/api/settings/notifications/test", async (req, res) => {
    await guard(req, res);
    res.json(await sendNotification("AIOS test notification ✓", "AIOS test"));
  });
}
