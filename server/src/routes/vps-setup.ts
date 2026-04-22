import { promises as dnsAsync } from "dns";
import { execFile } from "child_process";

import { Router, badRequest, forbidden } from "../http";
import { config, saveConfig } from "../config";
import { advanceSetupPhase, getSetupPhase, setSetupPhase } from "../setup-phase";
import { adminOnly } from "../auth";
import { log } from "../log";
import { detectPublicIp, syncManagedCaddy } from "../services/caddy";

const DOMAIN_RE = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/i;

export function registerVpsSetupRoutes(router: Router) {
  const guard = adminOnly();

  router.get("/api/vps/network-info", async (req, res) => {
    await guard(req, res);
    const ip = await detectPublicIp();
    res.json({ ip, port: config.port });
  });

  router.post("/api/vps/verify-dns", async (req, res) => {
    await guard(req, res);
    const domain = String(req.body?.domain || "").trim().toLowerCase();
    if (!DOMAIN_RE.test(domain)) throw badRequest("invalid domain format");
    const expectedIp = await detectPublicIp();
    let resolvedIps: string[] = [];
    try { resolvedIps = await dnsAsync.resolve4(domain); } catch {}
    res.json({
      domain,
      resolved: resolvedIps.length > 0,
      resolvedIps,
      expectedIp,
      matches: resolvedIps.includes(expectedIp),
    });
  });

  router.post("/api/vps/configure-domain", async (req, res) => {
    await guard(req, res);
    const domain = String(req.body?.domain || "").trim().toLowerCase();
    if (!DOMAIN_RE.test(domain)) throw badRequest("invalid domain format");

    const alreadyConfigured = config.auth.domain === domain
      && config.auth.baseUrlMode === "explicit";

    // 1. Bring Caddy up with the dashboard domain plus any storage-public
    //    domains that already belong to this VPS.
    try {
      await syncManagedCaddy([domain]);
    } catch (e: any) {
      log.warn(`caddy: systemctl failed (${e?.message || e})`);
      throw new Error(`Caddy failed to apply ${domain}: ${e?.message || e}`);
    }

    // 2. Update our config with the public URL
    saveConfig({
      ...config,
      auth: {
        ...config.auth,
        baseUrlMode: "explicit",
        publicBaseUrl: `https://${domain}`,
        domain,
      },
    });
    await syncManagedCaddy();

    if (getSetupPhase() === "domain_setup") advanceSetupPhase("domain_setup");

    // 3. Self-restart after the response flushes so the next request lands on a
    //    process that knows its public URL. No restart if we were already on
    //    the same domain — config edit is a no-op.
    if (!alreadyConfigured) {
      res.on("finish", () => {
        setTimeout(() => {
          execFile("/usr/bin/sudo",
            ["/usr/bin/systemctl", "restart", "aios"],
            () => {});
        }, 250);
      });
    }

    res.json({
      ok: true,
      domain,
      url: `https://${domain}`,
      nextUrl: `https://${domain}/setup/providers`,
      restartScheduled: !alreadyConfigured,
    });
  });

  router.get("/api/vps/domain-readiness", async (req, res) => {
    await guard(req, res);
    const domain = String(req.query.domain || "").trim().toLowerCase();
    if (!DOMAIN_RE.test(domain)) throw badRequest("invalid domain");
    const url = `https://${domain}/api/health?ts=${Date.now()}`;
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
      const body: any = r.ok ? await r.json() : {};
      res.json({ ready: body?.status === "ok", url, statusCode: r.status });
    } catch (e: any) {
      res.json({ ready: false, url, error: String(e?.message || e) });
    }
  });

  router.post("/api/vps/skip-domain", async (req, res) => {
    await guard(req, res);
    // Mark domain as explicitly skipped and advance phase.
    saveConfig({
      ...config,
      auth: { ...config.auth, domain: "skipped" },
    });
    await syncManagedCaddy();
    if (getSetupPhase() === "domain_setup") setSetupPhase("provider_setup");
    res.json({ ok: true, setupPhase: getSetupPhase() });
  });
}
