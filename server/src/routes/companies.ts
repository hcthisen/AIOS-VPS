import { Router, badRequest, conflict, notFound } from "../http";
import { adminOnly } from "../auth";
import { db } from "../db";
import { withCompanyContext } from "../company-context";
import {
  createCompany,
  deleteCompany,
  getCompanyBySlug,
  listCompanies,
  listConnectedRepoFullNames,
  updateCompanyDisplayName,
  setCompanySetupPhase,
} from "../services/companies";
import { activeProcessCount } from "../services/executor";
import { getGithubCreds, listRepos, ensureGitHubPushWebhook, deleteGitHubPushWebhook, createRepo } from "../services/github";
import { cloneRepo, readRepoContext, validateAiosRepo, writeRepoContext, scaffoldRepo, gitRun } from "../services/repo";
import { runSyncLayer } from "../services/sync";
import {
  approveTelegramPairing,
  getNotificationConfig,
  getTelegramPairingState,
  primeTelegramPairing,
  sendNotification,
  setNotificationConfig,
  syncTelegramPairing,
} from "../services/notifications";
import { pollCurrentCompanyTelegramUpdatesOnce } from "../services/telegramUpdates";

export function registerCompanyRoutes(router: Router) {
  const guard = adminOnly();

  router.get("/api/companies", async (req, res) => {
    await guard(req, res);
    res.json({
      companies: listCompanies().map((company) => ({
        id: company.id,
        slug: company.slug,
        displayName: company.displayName,
        repoFullName: company.repoFullName,
        setupPhase: company.setupPhase,
        isDefault: company.isDefault,
      })),
    });
  });

  router.get("/api/companies/github/repos", async (req, res) => {
    await guard(req, res);
    const creds = getGithubCreds();
    if (!creds?.token) throw badRequest("repo listing requires a PAT connection");
    const connected = new Set(listConnectedRepoFullNames());
    const repos = (await listRepos(creds.token)).filter((repo) => !connected.has(repo.fullName.toLowerCase()));
    res.json({ repos });
  });

  router.post("/api/companies", async (req, res) => {
    await guard(req, res);
    const creds = getGithubCreds();
    if (!creds?.token || !creds.username) throw badRequest("adding companies requires the existing GitHub PAT connection");
    const mode = String(req.body?.mode || "attach");
    const fullName = mode === "create" ? await createCompanyRepo(req.body || {}, creds) : String(req.body?.fullName || "").trim();
    if (!/^[\w.-]+\/[\w.-]+$/.test(fullName)) throw badRequest("invalid fullName");
    const repoName = fullName.split("/")[1] || fullName;
    const displayName = String(req.body?.displayName || repoName).trim();
    const company = createCompany({ displayName, slug: req.body?.slug, repoFullName: fullName });
    try {
      await withCompanyContext(company, async () => {
        const clone = await cloneRepo({ cloneUrl: `https://github.com/${fullName}.git`, creds });
        if (!clone.ok) throw badRequest(`clone failed: ${clone.error}`);
        if (mode === "create") {
          await scaffoldRepo(company.repoDir, { name: displayName });
          await commitAndPushScaffold(creds.username!, company.repoDir);
        }
        const validation = await validateAiosRepo(company.repoDir);
        if (!validation.ok) throw badRequest(validation.error || "validation failed");
        await ensureGitHubPushWebhook(creds.token!, fullName, {
          path: `/github/webhook/${company.slug}`,
          secret: company.webhookSecret,
        });
      });
    } catch (e) {
      db.prepare("DELETE FROM companies WHERE id = ?").run(company.id);
      throw e;
    }
    res.json({
      ok: true,
      company: {
        id: company.id,
        slug: company.slug,
        displayName: company.displayName,
        repoFullName: company.repoFullName,
        setupPhase: "context_setup",
      },
    }, 201);
  });

  router.delete("/api/companies/:slug", async (req, res) => {
    await guard(req, res);
    const company = mustCompany(req.params.slug);
    if (company.isDefault) throw badRequest("default company cannot be removed");

    const active = withCompanyContext(company, () => activeProcessCount());
    if (active > 0) throw conflict("company has active runs");

    const creds = getGithubCreds();
    const webhook = creds?.token && company.repoFullName
      ? await deleteGitHubPushWebhook(creds.token, company.repoFullName, { path: `/github/webhook/${company.slug}` }).catch((e: any) => ({
        ok: false,
        error: String(e?.message || e),
      }))
      : null;
    const removed = await deleteCompany(company);

    res.json({
      ok: true,
      company: {
        id: company.id,
        slug: company.slug,
        displayName: company.displayName,
        repoFullName: company.repoFullName,
      },
      removed,
      webhook,
    });
  });

  router.patch("/api/companies/:slug", async (req, res) => {
    await guard(req, res);
    const company = mustCompany(req.params.slug);
    const displayName = String(req.body?.displayName || "").trim();
    try {
      const updated = updateCompanyDisplayName(company.id, displayName);
      res.json({
        ok: true,
        company: {
          id: updated.id,
          slug: updated.slug,
          displayName: updated.displayName,
          repoFullName: updated.repoFullName,
          setupPhase: updated.setupPhase,
          isDefault: updated.isDefault,
        },
      });
    } catch (e: any) {
      throw badRequest(String(e?.message || e));
    }
  });

  router.get("/api/companies/:slug/context", async (req, res) => {
    await guard(req, res);
    const company = mustCompany(req.params.slug);
    await withCompanyContext(company, async () => {
      res.json(await readRepoContext(company.repoDir, company.displayName));
    });
  });

  router.post("/api/companies/:slug/context", async (req, res) => {
    await guard(req, res);
    const company = mustCompany(req.params.slug);
    const body = req.body || {};
    const organizationName = String(body.organizationName || "").trim();
    const deploymentScope = String(body.deploymentScope || "").trim();
    if (!organizationName || !deploymentScope) throw badRequest("organizationName and deploymentScope required");
    await withCompanyContext(company, async () => {
      await writeRepoContext(company.repoDir, {
        organizationName,
        deploymentScope,
        parentScope: String(body.parentScope || "").trim(),
        scopeSummary: String(body.scopeSummary || "").trim(),
        outsideRepoContext: String(body.outsideRepoContext || "").trim(),
        sharedConventions: String(body.sharedConventions || "").trim(),
      });
      await runSyncLayer({ commit: false });
    });
    setCompanySetupPhase(company.id, "notifications");
    res.json({ ok: true, setupPhase: "notifications" });
  });

  router.post("/api/companies/:slug/complete", async (req, res) => {
    await guard(req, res);
    const company = mustCompany(req.params.slug);
    setCompanySetupPhase(company.id, "complete");
    res.json({ ok: true, setupPhase: "complete" });
  });

  router.get("/api/companies/:slug/notifications/config", async (req, res) => {
    await guard(req, res);
    const company = mustCompany(req.params.slug);
    await withCompanyContext(company, async () => res.json(redactNotifications()));
  });

  router.post("/api/companies/:slug/notifications/save", async (req, res) => {
    await guard(req, res);
    const company = mustCompany(req.params.slug);
    await withCompanyContext(company, async () => res.json(await saveNotifications(req.body || {})));
  });

  router.get("/api/companies/:slug/notifications/telegram/pairing", async (req, res) => {
    await guard(req, res);
    const company = mustCompany(req.params.slug);
    await withCompanyContext(company, async () => {
      await pollCurrentCompanyTelegramUpdatesOnce({ timeout: 0, skipIfBusy: false });
      res.json({ ok: true, ...(await syncTelegramPairing()) });
    });
  });

  router.post("/api/companies/:slug/notifications/telegram/approve", async (req, res) => {
    await guard(req, res);
    const company = mustCompany(req.params.slug);
    await withCompanyContext(company, async () => {
      const chatId = String(req.body?.chatId || "").trim();
      if (!chatId) throw badRequest("chatId required");
      const candidate = approveTelegramPairing(chatId);
      res.json({ ok: true, candidate, chatId });
    });
  });

  router.post("/api/companies/:slug/notifications/test", async (req, res) => {
    await guard(req, res);
    const company = mustCompany(req.params.slug);
    await withCompanyContext(company, async () => {
      res.json(await sendNotification("AIOS test notification", "AIOS test"));
    });
  });
}

async function createCompanyRepo(body: any, creds: { token?: string; username?: string }): Promise<string> {
  const name = String(body?.name || "").trim();
  if (!/^[\w.-]{1,100}$/.test(name)) throw badRequest("invalid repo name");
  const result = await createRepo(creds.token!, {
    name,
    private: body?.private ?? true,
    description: "AIOS-managed company repo",
  });
  if (!result.ok) throw badRequest(`github create failed: ${result.error}`);
  return result.fullName;
}

async function commitAndPushScaffold(username: string, repoDir: string): Promise<void> {
  try {
    await gitRun(["config", "user.email", `${username}@users.noreply.github.com`], repoDir);
    await gitRun(["config", "user.name", username], repoDir);
    await gitRun(["add", "-A"], repoDir);
    await gitRun(["commit", "-m", "aios: scaffold"], repoDir);
    await gitRun(["push", "origin", "HEAD"], repoDir);
  } catch {
  }
}

function mustCompany(slug: string) {
  const company = getCompanyBySlug(slug);
  if (!company) throw notFound("company not found");
  return company;
}

function redactNotifications() {
  const config = getNotificationConfig();
  if (config.channel === "telegram") {
    const pairing = getTelegramPairingState();
    return {
      channel: "telegram",
      chatId: config.chatId || null,
      paired: !!config.chatId,
      botName: pairing?.botName,
      botUsername: pairing?.botUsername,
    };
  }
  if (config.channel === "email") {
    return {
      channel: "email",
      from: config.from,
      to: config.to,
      smtpHost: config.smtpHost,
      smtpPort: config.smtpPort,
      smtpUser: config.smtpUser,
      secure: config.secure,
    };
  }
  return { channel: "none" };
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
