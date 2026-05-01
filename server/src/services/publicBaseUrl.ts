import { randomBytes } from "crypto";
import { Readable } from "stream";

import { GetObjectCommand } from "@aws-sdk/client-s3";

import { CompanyContext, getCurrentCompanyContext, withCompanyContext } from "../company-context";
import { config } from "../config";
import { AiosRequest, AiosResponse } from "../http";
import { log } from "../log";
import { detectPublicIp, isIpv4Address, managedHostForPublicBaseUrl, resolveIpv4Addresses, syncManagedCaddy } from "./caddy";
import { listCompanies } from "./companies";
import { listDepartments } from "./departments";
import {
  FriendlyError,
  deleteObject,
  putObjectBuffer,
  s3ClientFor,
  translateError,
} from "./storageClient";
import { readStorageConfig, StorageConfig } from "./storageConfig";

export interface PublicBaseUrlCheck {
  ok: boolean;
  mode: "aios" | "external";
  url: string;
  detail: string;
}

export interface PublicBaseUrlProbeResult {
  ok: boolean;
  info?: PublicBaseUrlCheck;
  error?: FriendlyError;
}

interface PublicCandidate {
  company: CompanyContext | null;
  deptName: string;
  cfg: StorageConfig;
}

interface PublicMatch {
  company: CompanyContext | null;
  deptName: string;
  cfg: StorageConfig;
  key: string;
  url: string;
  specificity: number;
}

const temporaryPublicConfigs = new Map<string, StorageConfig>();
const RESERVED_DASHBOARD_PREFIXES = ["", "/api", "/assets", "/setup", "/departments", "/runs", "/webhooks"];

function temporaryConfigKey(company: CompanyContext | null, deptName: string): string {
  return `${company?.id || 1}:${deptName}`;
}

function currentCompany(): CompanyContext | null {
  return getCurrentCompanyContext();
}

function normalizeHostHeader(hostHeader: string | undefined): string {
  const raw = String(hostHeader || "").trim().toLowerCase();
  return raw.replace(/:80$|:443$/, "");
}

function normalizedBaseHost(baseUrl: string): string {
  const parsed = new URL(baseUrl);
  const hostname = parsed.hostname.toLowerCase();
  const defaultPort = parsed.protocol === "https:" ? "443" : parsed.protocol === "http:" ? "80" : "";
  if (!parsed.port || parsed.port === defaultPort) return hostname;
  return `${hostname}:${parsed.port}`;
}

export function encodePublicPath(path: string): string {
  return path.split("/").map((part) => encodeURIComponent(part)).join("/");
}

export function buildPublicObjectUrl(baseUrl: string, key: string, publicPrefix: string): string | undefined {
  if (!baseUrl || !key.startsWith(publicPrefix)) return undefined;
  const tail = key.slice(publicPrefix.length);
  return `${baseUrl.replace(/\/+$/, "")}/${encodePublicPath(tail)}`;
}

function decodePublicTail(tail: string): string | null {
  try {
    const parts = tail.split("/").filter((part) => part.length > 0);
    if (!parts.length) return null;
    const decoded = parts.map((part) => decodeURIComponent(part));
    if (decoded.some((part) => !part || part === "." || part.includes("/") || part.includes("\\") || part.includes(".."))) {
      return null;
    }
    return decoded.join("/");
  } catch {
    return null;
  }
}

export function matchPublicBaseUrlRequest(baseUrl: string, hostHeader: string | undefined, requestPath: string): { tail: string; specificity: number } | null {
  const parsed = new URL(baseUrl);
  if (normalizeHostHeader(hostHeader) !== normalizeHostHeader(normalizedBaseHost(baseUrl))) return null;
  const basePath = parsed.pathname.replace(/\/+$/, "");
  if (basePath) {
    if (requestPath === basePath || requestPath === `${basePath}/`) return null;
    if (!requestPath.startsWith(`${basePath}/`)) return null;
  }
  const tail = basePath ? requestPath.slice(basePath.length + 1) : requestPath.replace(/^\/+/, "");
  if (!tail) return null;
  return { tail, specificity: basePath.length };
}

function publicBaseUrlIdentity(baseUrl: string): string {
  const parsed = new URL(baseUrl);
  const basePath = parsed.pathname.replace(/\/+$/, "");
  return `${normalizeHostHeader(normalizedBaseHost(baseUrl))}${basePath}`;
}

function allKnownCompanies(): CompanyContext[] {
  const companies: CompanyContext[] = [...listCompanies()];
  const current = currentCompany();
  if (current && !companies.some((company) => company.id === current.id)) {
    companies.push(current);
  }
  return companies;
}

async function publicCandidatesForCompany(company: CompanyContext): Promise<PublicCandidate[]> {
  return withCompanyContext(company, async () => {
    const depts = await listDepartments();
    const out: PublicCandidate[] = [];
    for (const dept of depts) {
      const override = temporaryPublicConfigs.get(temporaryConfigKey(company, dept.name));
      const cfg = override || await readStorageConfig(dept.name).catch(() => null);
      if (!cfg?.publicBaseUrl) continue;
      out.push({ company, deptName: dept.name, cfg });
    }
    return out;
  });
}

export async function publicCandidates(): Promise<PublicCandidate[]> {
  const companies = allKnownCompanies();
  if (companies.length) {
    const nested = await Promise.all(companies.map((company) => publicCandidatesForCompany(company)));
    return nested.flat();
  }

  const depts = await listDepartments();
  const out: PublicCandidate[] = [];
  for (const dept of depts) {
    const override = temporaryPublicConfigs.get(temporaryConfigKey(null, dept.name));
    const cfg = override || await readStorageConfig(dept.name).catch(() => null);
    if (!cfg?.publicBaseUrl) continue;
    out.push({ company: null, deptName: dept.name, cfg });
  }
  return out;
}

export async function findPublicMatch(hostHeader: string | undefined, requestPath: string): Promise<PublicMatch | null> {
  const candidates = await publicCandidates();
  let best: PublicMatch | null = null;
  for (const candidate of candidates) {
    const matched = matchPublicBaseUrlRequest(candidate.cfg.publicBaseUrl, hostHeader, requestPath);
    if (!matched) continue;
    const decodedTail = decodePublicTail(matched.tail);
    if (!decodedTail) continue;
    const key = `${candidate.cfg.publicPrefix}${decodedTail}`;
    const url = buildPublicObjectUrl(candidate.cfg.publicBaseUrl, key, candidate.cfg.publicPrefix);
    if (!url) continue;
    if (!best || matched.specificity > best.specificity) {
      best = {
        company: candidate.company,
        deptName: candidate.deptName,
        cfg: candidate.cfg,
        key,
        url,
        specificity: matched.specificity,
      };
    }
  }
  return best;
}

async function shouldTreatAsPublicMiss(hostHeader: string | undefined, requestPath: string): Promise<boolean> {
  const host = normalizeHostHeader(hostHeader);
  if (!host) return false;
  const candidates = await publicCandidates();
  for (const candidate of candidates) {
    if (normalizeHostHeader(normalizedBaseHost(candidate.cfg.publicBaseUrl)) !== host) continue;
    const basePath = new URL(candidate.cfg.publicBaseUrl).pathname.replace(/\/+$/, "");
    if (!basePath) return true;
    if (requestPath === basePath || requestPath === `${basePath}/` || requestPath.startsWith(`${basePath}/`)) {
      return true;
    }
  }
  return false;
}

async function withTemporaryPublicConfig<T>(deptName: string, cfg: StorageConfig, fn: () => Promise<T>): Promise<T> {
  const company = currentCompany();
  const key = temporaryConfigKey(company, deptName);
  const prev = temporaryPublicConfigs.get(key);
  temporaryPublicConfigs.set(key, cfg);
  try {
    return await fn();
  } finally {
    if (prev) temporaryPublicConfigs.set(key, prev);
    else temporaryPublicConfigs.delete(key);
  }
}

async function findPublicBaseUrlConflict(deptName: string, baseUrl: string): Promise<string | null> {
  const identity = publicBaseUrlIdentity(baseUrl);
  const company = currentCompany();
  const currentCompanyId = company?.id || 1;
  const candidates = await publicCandidates();
  for (const candidate of candidates) {
    const candidateCompanyId = candidate.company?.id || 1;
    if (candidateCompanyId === currentCompanyId && candidate.deptName === deptName) continue;
    if (publicBaseUrlIdentity(candidate.cfg.publicBaseUrl) !== identity) continue;
    const companyLabel = candidate.company?.displayName || candidate.company?.slug;
    return companyLabel ? `${candidate.deptName} (${companyLabel})` : candidate.deptName;
  }
  return null;
}

async function classifyPublicBaseUrl(baseUrl: string): Promise<{
  localToVps: boolean;
  managedHost: string | null;
  publicIp: string;
  resolvedIps: string[];
}> {
  const parsed = new URL(baseUrl);
  const publicIp = await detectPublicIp();
  const resolvedIps = await resolveIpv4Addresses(parsed.hostname);
  const directIp = isIpv4Address(parsed.hostname) && parsed.hostname === publicIp;
  return {
    localToVps: directIp || resolvedIps.includes(publicIp),
    managedHost: await managedHostForPublicBaseUrl(baseUrl),
    publicIp,
    resolvedIps,
  };
}

function reservedSameHostPathError(baseUrl: string, publicIp: string): FriendlyError | null {
  const parsed = new URL(baseUrl);
  const basePath = parsed.pathname.replace(/\/+$/, "");
  const dashboard = (config.auth.domain || "").trim().toLowerCase();
  const currentDashboardHost = config.auth.baseUrlMode === "explicit" && dashboard && dashboard !== "skipped"
    ? dashboard
    : "";
  const sameDashboardHost = normalizeHostHeader(normalizedBaseHost(baseUrl)) === normalizeHostHeader(currentDashboardHost);
  const directIpHost = normalizeHostHeader(normalizedBaseHost(baseUrl)) === normalizeHostHeader(`${publicIp}:${config.port}`);
  if (!sameDashboardHost && !directIpHost) return null;
  if (!RESERVED_DASHBOARD_PREFIXES.some((prefix) => prefix === basePath || (!!prefix && basePath.startsWith(`${prefix}/`)))) {
    return null;
  }
  return {
    code: "PublicBaseUrlReservedPath",
    message: "Public base URL overlaps with the dashboard host and path space.",
    hint: sameDashboardHost
      ? "Use a dedicated file host, or keep the dashboard host but place files under a safe prefix such as /public-files."
      : `When using http://${publicIp}:${config.port}, put public files under a distinct prefix such as /public-files.`,
  };
}

async function fetchProbeUrl(url: string, expectedBody: string): Promise<{ ok: boolean; detail: string }> {
  let lastDetail = "public URL check did not complete";
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      const response = await fetch(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(5000),
      });
      const body = await response.text();
      if (response.ok && body === expectedBody) {
        return {
          ok: true,
          detail: `Verified ${url} served the probe object.`,
        };
      }
      lastDetail = `Got HTTP ${response.status} from ${url}.`;
    } catch (e: any) {
      lastDetail = String(e?.message || e);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt < 2 ? 1 : 2)));
  }
  return { ok: false, detail: lastDetail };
}

export async function probePublicBaseUrl(deptName: string, cfg: StorageConfig): Promise<PublicBaseUrlProbeResult | undefined> {
  if (!cfg.publicBaseUrl) return undefined;

  const conflict = await findPublicBaseUrlConflict(deptName, cfg.publicBaseUrl);
  if (conflict) {
    return {
      ok: false,
      error: {
        code: "PublicBaseUrlConflict",
        message: `Public base URL is already in use by department ${conflict}.`,
        hint: "Use a unique host/path combination per department.",
      },
    };
  }

  const target = await classifyPublicBaseUrl(cfg.publicBaseUrl);
  const reservedPathError = reservedSameHostPathError(cfg.publicBaseUrl, target.publicIp);
  if (reservedPathError) {
    return {
      ok: false,
      error: reservedPathError,
    };
  }
  const probeTail = `.aios-public-probe-${Date.now()}-${randomBytes(4).toString("hex")}.txt`;
  const key = `${cfg.publicPrefix}${probeTail}`;
  const body = `aios-public-probe:${Date.now()}`;

  return withTemporaryPublicConfig(deptName, cfg, async () => {
    let caddySynced = false;
    try {
      if (target.managedHost) {
        await syncManagedCaddy([target.managedHost]);
        caddySynced = true;
      }

      await putObjectBuffer(cfg, key, body, "text/plain; charset=utf-8");
      const url = buildPublicObjectUrl(cfg.publicBaseUrl, key, cfg.publicPrefix);
      if (!url) {
        return {
          ok: false,
          error: {
            code: "PublicBaseUrlInvalid",
            message: "Public base URL could not be mapped to a public object path.",
          },
        };
      }

      const fetched = await fetchProbeUrl(url, body);
      if (!fetched.ok) {
        const hint = target.localToVps
          ? target.managedHost
            ? `Point ${new URL(cfg.publicBaseUrl).hostname} at ${target.publicIp} and allow Caddy to obtain TLS.`
            : `Use a reachable URL on ${target.publicIp} that serves AIOS directly, for example http://${target.publicIp}:3100/... while testing.`
          : target.resolvedIps.length
            ? `The hostname currently resolves to ${target.resolvedIps.join(", ")}. If AIOS should host it, point it at ${target.publicIp}; otherwise make sure your CDN or bucket origin serves this path.`
            : "Make sure the hostname resolves and that the configured public origin serves the uploaded object.";
        return {
          ok: false,
          error: {
            code: "PublicBaseUrlUnreachable",
            message: "Public base URL did not serve the uploaded probe object.",
            hint: `${hint} Last check: ${fetched.detail}`,
          },
          info: {
            ok: false,
            mode: target.localToVps ? "aios" : "external",
            url,
            detail: fetched.detail,
          },
        };
      }

      return {
        ok: true,
        info: {
          ok: true,
          mode: target.localToVps ? "aios" : "external",
          url,
          detail: target.localToVps
            ? "AIOS verified the public URL through this VPS."
            : "AIOS verified the public URL through the configured public origin.",
        },
      };
    } finally {
      await deleteObject(cfg, key).catch(() => {});
      if (caddySynced) {
        await syncManagedCaddy().catch((e) => {
          log.warn(`public-url: failed to restore managed Caddy state (${String((e as any)?.message || e)})`);
        });
      }
    }
  });
}

export async function maybeServePublicObject(req: AiosRequest, res: AiosResponse): Promise<boolean> {
  if (!["GET", "HEAD"].includes(req.method || "")) return false;
  const match = await findPublicMatch(req.headers.host, req.path);
  if (!match) {
    if (await shouldTreatAsPublicMiss(req.headers.host, req.path)) {
      res.error(404, "not found");
      return true;
    }
    return false;
  }

  const client = s3ClientFor(match.cfg);
  try {
    const out = await client.send(new GetObjectCommand({
      Bucket: match.cfg.bucket,
      Key: match.key,
    }));
    const body = out.Body as Readable | undefined;
    if (!body) {
      client.destroy();
      res.error(404, "not found");
      return true;
    }

    if (out.ContentType) res.setHeader("Content-Type", out.ContentType);
    else res.setHeader("Content-Type", "application/octet-stream");
    if (typeof out.ContentLength === "number") res.setHeader("Content-Length", String(out.ContentLength));
    if (out.ETag) res.setHeader("ETag", out.ETag);
    if (out.LastModified) res.setHeader("Last-Modified", out.LastModified.toUTCString());
    res.setHeader("Cache-Control", out.CacheControl || "public, max-age=300");
    res.statusCode = 200;

    const dispose = () => client.destroy();
    body.once("close", dispose);
    body.once("end", dispose);
    body.once("error", dispose);

    if (req.method === "HEAD") {
      body.destroy();
      res.end();
      return true;
    }

    body.once("error", (e) => {
      log.warn(`public-url: stream failed for ${match.deptName} ${match.key}: ${String((e as any)?.message || e)}`);
      if (!res.writableEnded) res.end();
    });
    body.pipe(res);
    return true;
  } catch (e) {
    client.destroy();
    const friendly = translateError(e);
    const code = (e as any)?.name || friendly.code;
    const status = code === "NoSuchKey" || friendly.code === "NotFound" ? 404 : 502;
    res.error(status, status === 404 ? "not found" : friendly.message);
    return true;
  }
}
