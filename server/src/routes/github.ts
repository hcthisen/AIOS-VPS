import { mkdir } from "fs/promises";
import { existsSync } from "fs";
import { Router, badRequest } from "../http";
import { adminOnly } from "../auth";
import {
  setGithubCreds, getGithubCreds, verifyPat, listRepos, createRepo,
  cloneUrlWithPat,
} from "../services/github";
import { config } from "../config";
import { cloneRepo, scaffoldRepo, validateAiosRepo, gitRun, repoHead } from "../services/repo";
import { advanceSetupPhase, getSetupPhase, setSetupPhase } from "../setup-phase";
import { getNotificationConfig, setNotificationConfig, sendNotification } from "../services/notifications";
import { buildCommonAuthEnv } from "../services/provider-auth";
import { execFile } from "child_process";
import { promisify } from "util";
const execFileAsync = promisify(execFile);

export function registerOnboardingRoutes(router: Router) {
  const guard = adminOnly();

  // ---------- GitHub ----------
  router.post("/api/onboarding/github/connect", async (req, res) => {
    await guard(req, res);
    const mode = String(req.body?.mode || "pat");
    if (mode !== "pat") throw badRequest("only `pat` supported in v1");
    const token = String(req.body?.token || "");
    if (!token) throw badRequest("token required");
    const r = await verifyPat(token);
    if (!r.ok) throw badRequest(`github verify failed: ${r.error}`);
    setGithubCreds({ mode: "pat", username: r.login, token });
    if (getSetupPhase() === "github_setup") advanceSetupPhase("github_setup");
    res.json({ ok: true, login: r.login, setupPhase: getSetupPhase() });
  });

  router.get("/api/onboarding/github/repos", async (req, res) => {
    await guard(req, res);
    const creds = getGithubCreds();
    if (!creds?.token) throw badRequest("github not connected");
    const repos = await listRepos(creds.token);
    res.json({ repos });
  });

  // ---------- Repo setup ----------
  router.post("/api/onboarding/repo/create", async (req, res) => {
    await guard(req, res);
    const creds = getGithubCreds();
    if (!creds?.token || !creds.username) throw badRequest("github not connected");
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
    if (getSetupPhase() === "repo_setup") advanceSetupPhase("repo_setup");
    res.json({ ok: true, fullName: r.fullName, commit: await repoHead(), setupPhase: getSetupPhase() });
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
    if (getSetupPhase() === "repo_setup") advanceSetupPhase("repo_setup");
    res.json({ ok: true, fullName, yaml: v.yaml, setupPhase: getSetupPhase() });
  });

  router.get("/api/onboarding/repo/status", async (req, res) => {
    await guard(req, res);
    const cloned = existsSync(`${config.repoDir}/.git`);
    const validation = cloned ? await validateAiosRepo(config.repoDir) : { ok: false, error: "not cloned" };
    res.json({ cloned, ...validation });
  });

  // ---------- Notifications ----------
  router.post("/api/onboarding/notifications/save", async (req, res) => {
    await guard(req, res);
    const body = req.body || {};
    const channel = body.channel;
    if (channel === "telegram") {
      if (!body.botToken || !body.chatId) throw badRequest("botToken and chatId required");
      setNotificationConfig({ channel, botToken: body.botToken, chatId: String(body.chatId) });
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

  router.post("/api/onboarding/notifications/test", async (req, res) => {
    await guard(req, res);
    const r = await sendNotification("AIOS test notification ✓", "AIOS test");
    res.json(r);
  });

  router.get("/api/onboarding/notifications/config", async (req, res) => {
    await guard(req, res);
    const c = getNotificationConfig();
    // Strip secrets from response
    if (c.channel === "telegram") res.json({ channel: "telegram", chatId: c.chatId });
    else if (c.channel === "email") res.json({
      channel: "email", from: c.from, to: c.to, smtpHost: c.smtpHost, smtpPort: c.smtpPort, smtpUser: c.smtpUser, secure: c.secure,
    });
    else res.json({ channel: "none" });
  });

  router.post("/api/onboarding/complete", async (req, res) => {
    await guard(req, res);
    if (["notifications", "github_setup", "repo_setup"].includes(getSetupPhase())) {
      setSetupPhase("complete");
    }
    res.json({ ok: true, setupPhase: getSetupPhase() });
  });
}
