import { promises as dnsAsync } from "dns";
import { execFile } from "child_process";
import { promisify } from "util";
import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname } from "path";

import { config } from "../config";
import { log } from "../log";
import { listDepartments } from "./departments";
import { readStorageConfig } from "./storageConfig";

const execFileAsync = promisify(execFile);

const PLACEHOLDER_BODY = `# Managed by AIOS VPS setup. Manual edits will be overwritten.
:80 {
    respond "AIOS domain setup pending" 200
}
`;

export function isIpv4Address(value: string): boolean {
  return /^\d+\.\d+\.\d+\.\d+$/.test(value);
}

export async function detectPublicIp(): Promise<string> {
  const sources = [
    ["curl", ["-4", "-sf", "--max-time", "5", "https://icanhazip.com"]] as const,
    ["curl", ["-4", "-sf", "--max-time", "5", "https://ifconfig.me"]] as const,
  ];
  for (const [bin, args] of sources) {
    try {
      const { stdout } = await execFileAsync(bin, [...args]);
      const ip = stdout.trim();
      if (isIpv4Address(ip)) return ip;
    } catch { /* try next */ }
  }
  try {
    const { stdout } = await execFileAsync("hostname", ["-I"]);
    const first = stdout.trim().split(/\s+/)[0];
    if (isIpv4Address(first)) return first;
  } catch {}
  return "unknown";
}

export async function resolveIpv4Addresses(hostname: string): Promise<string[]> {
  if (!hostname) return [];
  if (isIpv4Address(hostname)) return [hostname];
  try {
    const lookedUp = await dnsAsync.lookup(hostname, { all: true, family: 4 });
    const addresses = lookedUp.map((entry) => entry.address).filter(Boolean);
    if (addresses.length) return [...new Set(addresses)];
  } catch {}
  try {
    const resolved = await dnsAsync.resolve4(hostname);
    if (resolved.length) return [...new Set(resolved)];
  } catch {}
  return [];
}

function normalizeSiteHost(url: URL): string {
  const hostname = url.hostname.toLowerCase();
  const defaultPort = url.protocol === "https:" ? "443" : url.protocol === "http:" ? "80" : "";
  if (!url.port || url.port === defaultPort) return hostname;
  return `${hostname}:${url.port}`;
}

function dashboardHost(): string | null {
  const domain = (config.auth.domain || "").trim().toLowerCase();
  if (config.auth.baseUrlMode !== "explicit" || !domain || domain === "skipped") return null;
  return domain;
}

export async function managedHostForPublicBaseUrl(baseUrl: string): Promise<string | null> {
  const parsed = new URL(baseUrl);
  if (isIpv4Address(parsed.hostname)) return null;
  const publicIp = await detectPublicIp();
  const addresses = await resolveIpv4Addresses(parsed.hostname);
  if (!addresses.includes(publicIp)) return null;
  return normalizeSiteHost(parsed);
}

async function managedStorageHosts(): Promise<string[]> {
  const depts = await listDepartments();
  const hosts = new Set<string>();
  for (const dept of depts) {
    const cfg = await readStorageConfig(dept.name).catch(() => null);
    if (!cfg?.publicBaseUrl) continue;
    const host = await managedHostForPublicBaseUrl(cfg.publicBaseUrl).catch(() => null);
    if (host) hosts.add(host);
  }
  return [...hosts];
}

export function renderManagedCaddyfile(hosts: string[], port = config.port): string {
  const deduped = [...new Set(hosts.map((host) => host.trim().toLowerCase()).filter(Boolean))].sort();
  if (!deduped.length) return PLACEHOLDER_BODY;
  const blocks = deduped.map((host) => `${host} {
    reverse_proxy localhost:${port}
}
`);
  return `# Managed by AIOS VPS setup. Manual edits will be overwritten.
${blocks.join("\n")}`;
}

async function writeManagedCaddyfile(body: string) {
  const path = "/etc/caddy/Caddyfile";
  try {
    await writeFile(path, body, "utf-8");
  } catch (e: any) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(`unable to write ${path}: ${e?.message || e}`);
    }
    const fallback = `${config.dataDir}/Caddyfile.dev`;
    await mkdir(dirname(fallback), { recursive: true });
    await writeFile(fallback, body, "utf-8");
    log.warn(`caddyfile: wrote dev fallback at ${fallback} (${e?.code || e})`);
  }
}

export async function sudoSystemctl(verb: string, unit: string) {
  await execFileAsync("/usr/bin/sudo", ["/usr/bin/systemctl", verb, unit]);
}

async function isUnitActive(unit: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("/usr/bin/systemctl", ["is-active", unit]);
    return stdout.trim() === "active";
  } catch {
    return false;
  }
}

export async function syncManagedCaddy(extraHosts: string[] = []): Promise<{ hosts: string[]; enabled: boolean }> {
  const configuredHosts = await managedStorageHosts();
  const hosts = [
    dashboardHost(),
    ...configuredHosts,
    ...extraHosts,
  ].filter(Boolean) as string[];
  const body = renderManagedCaddyfile(hosts, config.port);
  let currentBody = "";
  try {
    currentBody = await readFile("/etc/caddy/Caddyfile", "utf-8");
  } catch {}
  const bodyChanged = currentBody !== body;
  if (bodyChanged) await writeManagedCaddyfile(body);

  const enabled = [...new Set(hosts.map((host) => host.trim().toLowerCase()).filter(Boolean))].length > 0;
  if (process.env.NODE_ENV === "production") {
    try {
      const active = await isUnitActive("caddy");
      if (enabled) {
        await sudoSystemctl("enable", "caddy");
        if (!active) await sudoSystemctl("start", "caddy");
        else if (bodyChanged) await sudoSystemctl("reload", "caddy");
      } else {
        if (active) await sudoSystemctl("stop", "caddy").catch(() => {});
        await sudoSystemctl("disable", "caddy").catch(() => {});
      }
    } catch (e: any) {
      throw new Error(`Caddy failed to apply managed config: ${e?.message || e}`);
    }
  }

  return {
    hosts: [...new Set(hosts.map((host) => host.trim().toLowerCase()).filter(Boolean))].sort(),
    enabled,
  };
}
