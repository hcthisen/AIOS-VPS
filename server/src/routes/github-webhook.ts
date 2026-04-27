import { createHmac, timingSafeEqual } from "crypto";

import { badRequest, Router, unauthorized } from "../http";
import { githubWebhookSecret } from "../services/github";
import { checkRemoteForUpdates, markInboundSyncPending, reconcilePendingRepoSync } from "../services/repo";

function webhookSecret(): string {
  return githubWebhookSecret();
}

function verifySignature(raw: Buffer | undefined, header: string | string[] | undefined, secret: string): boolean {
  if (!raw || !secret || typeof header !== "string") return false;
  const match = header.match(/^sha256=(.+)$/);
  if (!match) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(raw).digest("hex"), "utf-8");
  const actual = Buffer.from(match[1], "utf-8");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function registerGithubWebhookRoutes(router: Router) {
  router.post("/github/webhook", async (req, res) => {
    const secret = webhookSecret();
    if (!secret) throw badRequest("GitHub webhook secret is not configured");
    if (!verifySignature(req.rawBody, req.headers["x-hub-signature-256"], secret)) {
      throw unauthorized("invalid GitHub webhook signature");
    }

    const event = String(req.headers["x-github-event"] || "");
    if (event !== "push") {
      res.json({ ok: true, ignored: event || "unknown" });
      return;
    }

    markInboundSyncPending("github push webhook");
    const remote = await checkRemoteForUpdates({ force: true });
    const sync = await reconcilePendingRepoSync("github push webhook");
    res.json({ ok: true, remote, sync });
  });
}
