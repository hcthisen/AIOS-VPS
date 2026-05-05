import { checkServerIdentity, connect, PeerCertificate } from "tls";

import { kvGet, kvSet } from "../db";
import { log } from "../log";
import {
  detectPublicIp,
  isIpv4Address,
  managedHostForPublicBaseUrl,
  resolveIpv4Addresses,
  syncManagedCaddy,
} from "./caddy";
import { listDepartments } from "./departments";
import { readStorageConfig, StorageConfig } from "./storageConfig";

export type PublicUrlRepairStatus = "ok" | "repairing" | "failed" | "external" | "not_applicable";

export interface PublicUrlRepairResult {
  ok: boolean;
  status: PublicUrlRepairStatus;
  publicBaseUrl: string;
  host: string;
  detail: string;
  hint?: string;
  repaired?: boolean;
  certificate?: {
    validFrom?: string;
    validTo?: string;
    subjectaltname?: string;
  };
  caddy?: {
    hosts: string[];
    enabled: boolean;
  };
}

interface LiveCertificateCheck {
  ok: boolean;
  detail: string;
  certificate?: PublicUrlRepairResult["certificate"];
}

interface RepairThrottleState {
  lastAttemptAt?: number;
  lastSuccessAt?: number;
  lastFailureAt?: number;
  lastError?: string;
}

const REPAIR_ATTEMPT_COOLDOWN_MS = 60 * 60 * 1000;
const inFlightRepairs = new Map<string, Promise<PublicUrlRepairResult>>();

function repairThrottleKey(hostname: string): string {
  return `storage-public-url-repair:${hostname}`;
}

function readRepairThrottle(hostname: string): RepairThrottleState {
  const raw = kvGet(repairThrottleKey(hostname));
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed ? parsed : {};
  } catch {
    return {};
  }
}

function writeRepairThrottle(hostname: string, state: RepairThrottleState) {
  kvSet(repairThrottleKey(hostname), JSON.stringify(state));
}

function remainingCooldownMs(state: RepairThrottleState, now = Date.now()): number {
  if (!state.lastAttemptAt) return 0;
  return Math.max(0, state.lastAttemptAt + REPAIR_ATTEMPT_COOLDOWN_MS - now);
}

function formatCooldown(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

async function withPublicUrlRepairLock(hostname: string, fn: () => Promise<PublicUrlRepairResult>): Promise<PublicUrlRepairResult> {
  const existing = inFlightRepairs.get(hostname);
  if (existing) return existing;
  const next = fn().finally(() => {
    if (inFlightRepairs.get(hostname) === next) inFlightRepairs.delete(hostname);
  });
  inFlightRepairs.set(hostname, next);
  return next;
}

export function shouldManageHttpsPublicBaseUrl(baseUrl: string): {
  manage: boolean;
  reason?: string;
  parsed?: URL;
} {
  if (!baseUrl.trim()) return { manage: false, reason: "Public base URL is not configured." };
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return { manage: false, reason: "Public base URL is not a valid URL." };
  }
  if (parsed.protocol !== "https:") {
    return { manage: false, parsed, reason: "Public base URL does not use HTTPS." };
  }
  if (isIpv4Address(parsed.hostname)) {
    return { manage: false, parsed, reason: "Public base URL uses a raw IP address." };
  }
  if (parsed.port && parsed.port !== "443") {
    return { manage: false, parsed, reason: "Public base URL uses a non-standard HTTPS port." };
  }
  return { manage: true, parsed };
}

function certDates(cert: PeerCertificate): PublicUrlRepairResult["certificate"] {
  return {
    validFrom: cert.valid_from,
    validTo: cert.valid_to,
    subjectaltname: cert.subjectaltname,
  };
}

export function validateCertificateForHost(hostname: string, cert: PeerCertificate): LiveCertificateCheck {
  if (!cert || !Object.keys(cert).length) {
    return { ok: false, detail: "No certificate was presented." };
  }
  const validFrom = cert.valid_from ? Date.parse(cert.valid_from) : NaN;
  if (Number.isFinite(validFrom) && validFrom > Date.now()) {
    return {
      ok: false,
      detail: `Certificate is not valid until ${cert.valid_from}.`,
      certificate: certDates(cert),
    };
  }
  const validTo = cert.valid_to ? Date.parse(cert.valid_to) : NaN;
  if (Number.isFinite(validTo) && validTo <= Date.now()) {
    return {
      ok: false,
      detail: `Certificate expired at ${cert.valid_to}.`,
      certificate: certDates(cert),
    };
  }
  const identityError = checkServerIdentity(hostname, cert);
  if (identityError) {
    return {
      ok: false,
      detail: identityError.message,
      certificate: certDates(cert),
    };
  }
  return {
    ok: true,
    detail: "HTTPS certificate is valid for the public file host.",
    certificate: certDates(cert),
  };
}

async function checkLiveHttpsCertificate(hostname: string, timeoutMs = 5000): Promise<LiveCertificateCheck> {
  return new Promise((resolve) => {
    const socket = connect({
      host: hostname,
      port: 443,
      servername: hostname,
      rejectUnauthorized: false,
    });
    let timer: NodeJS.Timeout;
    const done = (result: LiveCertificateCheck) => {
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    timer = setTimeout(() => {
      done({ ok: false, detail: "TLS check timed out." });
    }, timeoutMs);
    socket.once("secureConnect", () => {
      const cert = socket.getPeerCertificate();
      done(validateCertificateForHost(hostname, cert));
    });
    socket.once("error", (e) => {
      done({ ok: false, detail: String((e as any)?.message || e) });
    });
  });
}

async function waitForValidHttpsCertificate(hostname: string): Promise<LiveCertificateCheck> {
  let last: LiveCertificateCheck = { ok: false, detail: "TLS check did not complete." };
  for (let attempt = 0; attempt < 12; attempt++) {
    last = await checkLiveHttpsCertificate(hostname);
    if (last.ok) return last;
    await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt < 2 ? 1 : 2)));
  }
  return last;
}

export async function repairStoragePublicBaseUrl(cfg: StorageConfig): Promise<PublicUrlRepairResult | undefined> {
  if (!cfg.publicBaseUrl) return undefined;
  const candidate = shouldManageHttpsPublicBaseUrl(cfg.publicBaseUrl);
  const parsed = candidate.parsed || new URL(cfg.publicBaseUrl);
  const host = parsed.hostname.toLowerCase();
  if (!candidate.manage) {
    return {
      ok: true,
      status: "not_applicable",
      publicBaseUrl: cfg.publicBaseUrl,
      host,
      detail: candidate.reason || "Public base URL is not managed by AIOS.",
    };
  }

  const publicIp = await detectPublicIp();
  const resolvedIps = await resolveIpv4Addresses(host);
  if (!resolvedIps.includes(publicIp)) {
    return {
      ok: true,
      status: "external",
      publicBaseUrl: cfg.publicBaseUrl,
      host,
      detail: resolvedIps.length
        ? `Public file host resolves to ${resolvedIps.join(", ")}, not this VPS (${publicIp}).`
        : "Public file host does not currently resolve to an IPv4 address.",
      hint: "AIOS will not manage Caddy/TLS for external public file hosts.",
    };
  }

  return withPublicUrlRepairLock(host, () => repairLocalStoragePublicBaseUrl(cfg, host, publicIp));
}

async function repairLocalStoragePublicBaseUrl(
  cfg: StorageConfig,
  host: string,
  publicIp: string,
): Promise<PublicUrlRepairResult> {
  const before = await checkLiveHttpsCertificate(host);
  if (before.ok) {
    writeRepairThrottle(host, {
      ...readRepairThrottle(host),
      lastSuccessAt: Date.now(),
      lastError: undefined,
    });
    return {
      ok: true,
      status: "ok",
      publicBaseUrl: cfg.publicBaseUrl,
      host,
      detail: before.detail,
      certificate: before.certificate,
      repaired: false,
    };
  }

  const managedHost = await managedHostForPublicBaseUrl(cfg.publicBaseUrl);
  if (!managedHost) {
    return {
      ok: false,
      status: "failed",
      publicBaseUrl: cfg.publicBaseUrl,
      host,
      detail: before.detail,
      certificate: before.certificate,
      hint: `Point ${host} at ${publicIp}, then retry public URL repair.`,
    };
  }

  const throttle = readRepairThrottle(host);
  const waitMs = remainingCooldownMs(throttle);
  if (waitMs > 0) {
    return {
      ok: false,
      status: "failed",
      publicBaseUrl: cfg.publicBaseUrl,
      host,
      detail: before.detail,
      certificate: before.certificate,
      repaired: false,
      hint: `AIOS recently asked Caddy to repair HTTPS for this host. To avoid Let's Encrypt rate limits, it will not force another certificate attempt for ${formatCooldown(waitMs)}.`,
    };
  }

  writeRepairThrottle(host, {
    ...throttle,
    lastAttemptAt: Date.now(),
    lastError: before.detail,
  });
  const caddy = await syncManagedCaddy([managedHost], { forceRestart: true });
  const after = await waitForValidHttpsCertificate(host);
  if (after.ok) {
    writeRepairThrottle(host, {
      lastAttemptAt: Date.now(),
      lastSuccessAt: Date.now(),
      lastError: undefined,
    });
    return {
      ok: true,
      status: "ok",
      publicBaseUrl: cfg.publicBaseUrl,
      host,
      detail: after.detail,
      certificate: after.certificate,
      caddy,
      repaired: true,
    };
  }
  writeRepairThrottle(host, {
    lastAttemptAt: Date.now(),
    lastFailureAt: Date.now(),
    lastError: after.detail,
  });
  return {
    ok: false,
    status: "failed",
    publicBaseUrl: cfg.publicBaseUrl,
    host,
    detail: after.detail,
    certificate: after.certificate,
    caddy,
    repaired: true,
    hint: `AIOS added ${managedHost} to Caddy, but HTTPS is not ready. Check DNS, ports 80/443, Caddy logs, and ACME rate limits.`,
  };
}

export async function repairDepartmentStoragePublicUrl(deptName: string): Promise<PublicUrlRepairResult> {
  const cfg = await readStorageConfig(deptName);
  if (!cfg?.publicBaseUrl) {
    return {
      ok: true,
      status: "not_applicable",
      publicBaseUrl: "",
      host: "",
      detail: "Department does not have a public storage URL configured.",
    };
  }
  return (await repairStoragePublicBaseUrl(cfg)) || {
    ok: true,
    status: "not_applicable",
    publicBaseUrl: "",
    host: "",
    detail: "Department does not have a public storage URL configured.",
  };
}

export async function repairAllStoragePublicUrls(): Promise<PublicUrlRepairResult[]> {
  const out: PublicUrlRepairResult[] = [];
  const departments = await listDepartments();
  for (const dept of departments) {
    try {
      const result = await repairDepartmentStoragePublicUrl(dept.name);
      if (result.publicBaseUrl) out.push(result);
    } catch (e) {
      log.warn("storage public URL repair failed", {
        dept: dept.name,
        error: String((e as any)?.message || e),
      });
      out.push({
        ok: false,
        status: "failed",
        publicBaseUrl: "",
        host: "",
        detail: String((e as any)?.message || e),
      });
    }
  }
  return out;
}
