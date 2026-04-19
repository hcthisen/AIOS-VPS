import { promises as dnsAsync } from "dns";
import { execFile } from "child_process";
import { promisify } from "util";
import { writeFile, readFile, mkdir } from "fs/promises";
import { dirname } from "path";

import { Router, badRequest, forbidden } from "../http";
import { config, saveConfig } from "../config";
import { advanceSetupPhase, getSetupPhase, setSetupPhase } from "../setup-phase";
import { adminOnly } from "../auth";
import { log } from "../log";

const execFileAsync = promisify(execFile);

const DOMAIN_RE = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/i;

async function detectPublicIp(): Promise<string> {
  const sources = [
    ["curl", ["-4", "-sf", "--max-time", "5", "https://icanhazip.com"]] as const,
    ["curl", ["-4", "-sf", "--max-time", "5", "https://ifconfig.me"]] as const,
  ];
  for (const [bin, args] of sources) {
    try {
      const { stdout } = await execFileAsync(bin, [...args]);
      const ip = stdout.trim();
      if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return ip;
    } catch { /* try next */ }
  }
  // Last-resort: hostname -I
  try {
    const { stdout } = await execFileAsync("hostname", ["-I"]);
    const first = stdout.trim().split(/\s+/)[0];
    if (first) return first;
  } catch {}
  return "unknown";
}

async function writeCaddyfile(domain: string, port: number) {
  const body = `# Managed by AIOS VPS setup. Manual edits will be overwritten.
${domain} {
    reverse_proxy localhost:${port}
}
`;
  const path = "/etc/caddy/Caddyfile";
  try {
    await writeFile(path, body, "utf-8");
  } catch (e: any) {
    // In dev without /etc/caddy, fall back to a data-dir copy for tests.
    const fallback = `${config.dataDir}/Caddyfile.dev`;
    await mkdir(dirname(fallback), { recursive: true });
    await writeFile(fallback, body, "utf-8");
    log.warn(`caddyfile: wrote dev fallback at ${fallback} (${e?.code || e})`);
  }
}

async function sudoSystemctl(verb: string, unit: string) {
  await execFileAsync("/usr/bin/sudo", ["/usr/bin/systemctl", verb, unit]);
}

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

    // 1. Caddyfile
    await writeCaddyfile(domain, config.port);

    // 2. Bring Caddy up (idempotent on re-run)
    try {
      await sudoSystemctl("enable", "caddy");
      await sudoSystemctl("start", "caddy");
      await new Promise((r) => setTimeout(r, 3000));
      await sudoSystemctl("reload", "caddy").catch(() => {});
    } catch (e: any) {
      log.warn(`caddy: systemctl failed (${e?.message || e}); continuing`);
    }

    // 3. Update our config with the public URL
    saveConfig({
      ...config,
      auth: {
        ...config.auth,
        baseUrlMode: "explicit",
        publicBaseUrl: `https://${domain}`,
        domain,
      },
    });

    if (getSetupPhase() === "domain_setup") advanceSetupPhase("domain_setup");

    // 4. Self-restart after the response flushes so the next request lands on a
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
    if (getSetupPhase() === "domain_setup") setSetupPhase("provider_setup");
    res.json({ ok: true, setupPhase: getSetupPhase() });
  });
}
