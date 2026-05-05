import { mkdir, writeFile, chmod } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { Router, badRequest } from "../http";
import { adminOnly } from "../auth";
import {
  setGithubCreds, getGithubCreds, verifyPat, listRepos, createRepo, ensureGitHubPushWebhook,
} from "../services/github";
import { config } from "../config";
import { log } from "../log";
import { cloneRepo, scaffoldRepo, validateAiosRepo, gitRun, repoHead, readRepoContext, writeRepoContext } from "../services/repo";
import { advanceSetupPhase, getSetupPhase, setSetupPhase } from "../setup-phase";
import {
  approveTelegramPairing,
  getNotificationConfig,
  getTelegramPairingState,
  primeTelegramPairing,
  setNotificationConfig,
  sendNotification,
  syncTelegramPairing,
} from "../services/notifications";
import { pollTelegramUpdatesOnce } from "../services/telegramUpdates";
import { buildCommonAuthEnv } from "../services/provider-auth";
import { runSyncLayer } from "../services/sync";
import { getDefaultCompany, updateCompanyDisplayName, updateDefaultCompanyRepoAndName } from "../services/companies";
import { repairAllStoragePublicUrls } from "../services/storagePublicUrlRepair";
import { execFile } from "child_process";
import { promisify } from "util";
const execFileAsync = promisify(execFile);

async function ensurePushWebhook(token: string, fullName: string) {
  const result = await ensureGitHubPushWebhook(token, fullName);
  if (!result.ok) log.warn(`github webhook setup failed for ${fullName}: ${result.error}`);
  else log.info(`github webhook ${result.action} for ${fullName}: ${result.url}`);
  return result;
}

function queueStoragePublicUrlRepair(source: string) {
  setTimeout(() => {
    void repairAllStoragePublicUrls()
      .then((results) => {
        const failed = results.filter((result) => !result.ok);
        if (failed.length) {
          log.warn(`storage public URL repair completed with ${failed.length} failure(s) after ${source}`);
        } else if (results.length) {
          log.info(`storage public URL repair completed after ${source}`);
        }
      })
      .catch((e) => {
        log.warn(`storage public URL repair failed after ${source}: ${String((e as any)?.message || e)}`);
      });
  }, 0);
}

export function registerOnboardingRoutes(router: Router) {
  const guard = adminOnly();

  // ---------- GitHub ----------
  router.get("/api/onboarding/github/status", async (req, res) => {
    await guard(req, res);
    const creds = getGithubCreds();
    res.json({
      connected: !!creds,
      mode: creds?.mode || null,
      username: creds?.username || null,
      hasPrivateKey: !!creds?.privateKeyPath,
    });
  });

  router.post("/api/onboarding/github/connect", async (req, res) => {
    await guard(req, res);
    const mode = String(req.body?.mode || "pat");
    if (mode === "pat") {
      const token = String(req.body?.token || "");
      if (!token) throw badRequest("token required");
      const r = await verifyPat(token);
      if (!r.ok) throw badRequest(`github verify failed: ${r.error}`);
      setGithubCreds({ mode: "pat", username: r.login, token });
      if (getSetupPhase() === "github_setup") advanceSetupPhase("github_setup");
      res.json({ ok: true, mode, login: r.login, setupPhase: getSetupPhase() });
      return;
    }
    if (mode !== "deploy_key") throw badRequest("unsupported github mode");
    const privateKey = String(req.body?.privateKey || "").trim();
    if (!privateKey.includes("PRIVATE KEY")) throw badRequest("private SSH key required");
    const keyPath = join(config.dataDir, "github_deploy_key");
    await mkdir(config.dataDir, { recursive: true });
    await writeFile(keyPath, `${privateKey}\n`, "utf-8");
    try { await chmod(keyPath, 0o600); } catch {}
    setGithubCreds({ mode: "deploy_key", privateKeyPath: keyPath });
    if (getSetupPhase() === "github_setup") advanceSetupPhase("github_setup");
    res.json({ ok: true, mode, setupPhase: getSetupPhase() });
  });

  router.get("/api/onboarding/github/repos", async (req, res) => {
    await guard(req, res);
    const creds = getGithubCreds();
    if (!creds?.token) throw badRequest("repo listing requires a PAT connection");
    const repos = await listRepos(creds.token);
    res.json({ repos });
  });

  // ---------- Repo setup ----------
  router.post("/api/onboarding/repo/create", async (req, res) => {
    await guard(req, res);
    const creds = getGithubCreds();
    if (!creds?.token || !creds.username) throw badRequest("repo creation requires a PAT connection");
    const name = String(req.body?.name || "").trim();
    const isPrivate = !!req.body?.private;
    if (!/^[\w.-]{1,100}$/.test(name)) throw badRequest("invalid repo name");
    const r = await createRepo(creds.token, { name, private: isPrivate, description: "AIOS-managed monorepo" });
    if (!r.ok) throw badRequest(`github create failed: ${r.error}`);
    // Clone, scaffold, commit + push.
    const clone = await cloneRepo({ cloneUrl: r.cloneUrl, creds });
    if (!clone.ok) throw badRequest(`clone failed: ${clone.error}`);
    await scaffoldRepo(config.repoDir, { name });
    const env = buildCommonAuthEnv();
    try {
      await execFileAsync("git", ["-C", config.repoDir, "config", "user.email", `${creds.username}@users.noreply.github.com`], { env });
      await execFileAsync("git", ["-C", config.repoDir, "config", "user.name", creds.username], { env });
      await gitRun(["add", "-A"]);
      await gitRun(["commit", "-m", "aios: scaffold"]);
      await gitRun(["push", "origin", "HEAD"]);
    } catch (e: any) {
      // non-fatal; operator can retry push
    }
    const webhook = await ensurePushWebhook(creds.token, r.fullName);
    updateDefaultCompanyRepoAndName(r.fullName, name);
    queueStoragePublicUrlRepair("repo create");
    if (getSetupPhase() === "repo_setup") advanceSetupPhase("repo_setup");
    res.json({ ok: true, fullName: r.fullName, commit: await repoHead(), webhook, setupPhase: getSetupPhase() });
  });

  router.post("/api/onboarding/repo/attach", async (req, res) => {
    await guard(req, res);
    const creds = getGithubCreds();
    if (!creds?.token || !creds.username) throw badRequest("github not connected");
    const fullName = String(req.body?.fullName || "").trim();
    if (!/^[\w.-]+\/[\w.-]+$/.test(fullName)) throw badRequest("invalid fullName");
    const cloneUrl = `https://github.com/${fullName}.git`;
    const clone = await cloneRepo({ cloneUrl, creds });
    if (!clone.ok) throw badRequest(`clone failed: ${clone.error}`);
    const v = await validateAiosRepo(config.repoDir);
    if (!v.ok) throw badRequest(v.error || "validation failed");
    const webhook = await ensurePushWebhook(creds.token, fullName);
    updateDefaultCompanyRepoAndName(fullName, fullName.split("/")[1] || fullName);
    queueStoragePublicUrlRepair("repo attach");
    if (getSetupPhase() === "repo_setup") advanceSetupPhase("repo_setup");
    res.json({ ok: true, fullName, yaml: v.yaml, webhook, setupPhase: getSetupPhase() });
  });

  router.get("/api/onboarding/repo/status", async (req, res) => {
    await guard(req, res);
    const cloned = existsSync(`${config.repoDir}/.git`);
    const validation = cloned ? await validateAiosRepo(config.repoDir) : { ok: false, error: "not cloned" };
    res.json({ cloned, ...validation });
  });

  // ---------- Shared context ----------
  router.get("/api/onboarding/context", async (req, res) => {
    await guard(req, res);
    const fallbackName = config.repoDir.split(/[\\/]/).pop() || "AIOS deployment";
    const context = await readRepoContext(config.repoDir, fallbackName);
    res.json(context);
  });

  router.post("/api/onboarding/context/save", async (req, res) => {
    await guard(req, res);
    const body = req.body || {};
    const organizationName = String(body.organizationName || "").trim();
    const deploymentScope = String(body.deploymentScope || "").trim();
    if (!organizationName || !deploymentScope) {
      throw badRequest("organizationName and deploymentScope required");
    }
    await writeRepoContext(config.repoDir, {
      organizationName,
      deploymentScope,
      parentScope: String(body.parentScope || "").trim(),
      scopeSummary: String(body.scopeSummary || "").trim(),
      outsideRepoContext: String(body.outsideRepoContext || "").trim(),
      sharedConventions: String(body.sharedConventions || "").trim(),
    });
    updateCompanyDisplayName(getDefaultCompany().id, organizationName);
    await runSyncLayer({ commit: false });
    if (getSetupPhase() === "context_setup") advanceSetupPhase("context_setup");
    res.json({ ok: true, setupPhase: getSetupPhase() });
  });

  // ---------- Notifications ----------
  router.post("/api/onboarding/notifications/save", async (req, res) => {
    await guard(req, res);
    const body = req.body || {};
    const channel = body.channel;
    if (channel === "telegram") {
      const botToken = String(body.botToken || "").trim();
      if (!botToken) throw badRequest("botToken required");
      try {
        const pairing = await primeTelegramPairing(botToken);
        setNotificationConfig({ channel, botToken, chatId: null });
        res.json({ ok: true, paired: false, ...pairing });
        return;
      } catch (e: any) {
        throw badRequest(`telegram verify failed: ${e?.message || e}`);
      }
    } else if (channel === "email") {
      const required = ["from", "to", "smtpHost", "smtpPort"];
      for (const k of required) if (!body[k]) throw badRequest(`${k} required`);
      setNotificationConfig({
        channel: "email",
        from: body.from,
        to: body.to,
        smtpHost: body.smtpHost,
        smtpPort: Number(body.smtpPort),
        smtpUser: body.smtpUser,
        smtpPass: body.smtpPass,
        secure: body.secure,
      });
    } else if (channel === "none") {
      setNotificationConfig({ channel: "none" });
    } else {
      throw badRequest("unknown channel");
    }
    res.json({ ok: true });
  });

  router.get("/api/onboarding/notifications/telegram/pairing", async (req, res) => {
    await guard(req, res);
    try {
      await pollTelegramUpdatesOnce({ timeout: 0, skipIfBusy: true });
      const pairing = await syncTelegramPairing();
      res.json({ ok: true, ...pairing });
    } catch (e: any) {
      throw badRequest(String(e?.message || e));
    }
  });

  router.post("/api/onboarding/notifications/telegram/approve", async (req, res) => {
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

  router.post("/api/onboarding/notifications/test", async (req, res) => {
    await guard(req, res);
    const r = await sendNotification("AIOS test notification ✓", "AIOS test");
    res.json(r);
  });

  router.get("/api/onboarding/notifications/config", async (req, res) => {
    await guard(req, res);
    const c = getNotificationConfig();
    // Strip secrets from response
    if (c.channel === "telegram") {
      const pairing = getTelegramPairingState();
      res.json({
        channel: "telegram",
        chatId: c.chatId || null,
        paired: !!c.chatId,
        botName: pairing?.botName,
        botUsername: pairing?.botUsername,
      });
    }
    else if (c.channel === "email") res.json({
      channel: "email", from: c.from, to: c.to, smtpHost: c.smtpHost, smtpPort: c.smtpPort, smtpUser: c.smtpUser, secure: c.secure,
    });
    else res.json({ channel: "none" });
  });

  router.post("/api/onboarding/complete", async (req, res) => {
    await guard(req, res);
    if (["notifications", "context_setup", "github_setup", "repo_setup"].includes(getSetupPhase())) {
      setSetupPhase("complete");
    }
    res.json({ ok: true, setupPhase: getSetupPhase() });
  });
}
