// Minimal GitHub integration: personal-access-token or deploy-key.
// v1 supports PAT; OAuth app can be added later without changing the storage shape.

import { randomBytes } from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";

import { config } from "../config";
import { kvGet, kvSet } from "../db";
import { detectPublicIp } from "./caddy";
import { getCurrentCompanyId } from "../company-context";
import { ensureCompanyWebhookSecret } from "./companies";

export interface GithubCreds {
  mode: "pat" | "deploy_key";
  username?: string;
  token?: string;     // PAT; stored as-is (the filesystem is the source of truth per PRD)
  publicKey?: string; // for deploy-key flow
  privateKeyPath?: string;
}

const KEY = "github.creds";
const WEBHOOK_SECRET_KEY = "github.webhook.secret";
const execFileAsync = promisify(execFile);

export function setGithubCreds(c: GithubCreds) { kvSet(KEY, JSON.stringify(c)); }
export function getGithubCreds(): GithubCreds | null {
  const raw = kvGet(KEY);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export async function ghFetch(path: string, token: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      "Accept": "application/vnd.github+json",
      "User-Agent": "aios-vps",
      "Authorization": `Bearer ${token}`,
      ...(init.headers as any),
    },
  });
}

export async function verifyPat(token: string): Promise<{ ok: true; login: string } | { ok: false; error: string }> {
  try {
    const r = await ghFetch("/user", token);
    if (!r.ok) return { ok: false, error: `github ${r.status}` };
    const j: any = await r.json();
    return { ok: true, login: j.login };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) };
  }
}

export async function listRepos(token: string): Promise<Array<{ fullName: string; private: boolean }>> {
  const out: any[] = [];
  for (let page = 1; page <= 5; page++) {
    const r = await ghFetch(`/user/repos?per_page=100&page=${page}&affiliation=owner,collaborator,organization_member`, token);
    if (!r.ok) break;
    const batch = (await r.json()) as any[];
    if (!batch.length) break;
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out.map((r) => ({ fullName: r.full_name, private: !!r.private }));
}

export async function createRepo(
  token: string,
  input: { name: string; description?: string; private?: boolean; owner?: string },
): Promise<{ ok: true; cloneUrl: string; fullName: string } | { ok: false; error: string }> {
  try {
    const body: any = {
      name: input.name,
      description: input.description || "AIOS repo",
      private: input.private ?? true,
      auto_init: true,
    };
    const url = input.owner ? `/orgs/${input.owner}/repos` : "/user/repos";
    const r = await ghFetch(url, token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => "");
      return { ok: false, error: `github ${r.status}: ${t.slice(0, 200)}` };
    }
    const j: any = await r.json();
    return { ok: true, cloneUrl: j.clone_url, fullName: j.full_name };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) };
  }
}

export function githubWebhookSecret(): string {
  const envSecret = String(process.env.AIOS_GITHUB_WEBHOOK_SECRET || process.env.GITHUB_WEBHOOK_SECRET || "").trim();
  if (envSecret) return envSecret;
  const companySecret = ensureCompanyWebhookSecret(getCurrentCompanyId());
  if (companySecret) return companySecret;
  const stored = kvGet(WEBHOOK_SECRET_KEY);
  if (stored) return stored;
  const generated = randomBytes(32).toString("hex");
  kvSet(WEBHOOK_SECRET_KEY, generated);
  return generated;
}

export function parseGitHubFullNameFromRemote(remoteUrl: string | null | undefined): string | null {
  const raw = String(remoteUrl || "").trim();
  if (!raw) return null;

  let match = raw.match(/^https:\/\/(?:[^/@]+(?::[^/@]*)?@)?github\.com\/([^/]+\/[^/.]+)(?:\.git)?\/?$/i);
  if (match) return match[1];

  match = raw.match(/^git@github\.com:([^/]+\/[^/.]+)(?:\.git)?$/i);
  if (match) return match[1];

  return null;
}

export async function currentGitHubRepoFullName(repoDir = config.repoDir): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", repoDir, "config", "--get", "remote.origin.url"]);
    return parseGitHubFullNameFromRemote(stdout.trim());
  } catch {
    return null;
  }
}

async function defaultWebhookBaseUrl(): Promise<string | null> {
  const configured = String(config.auth.publicBaseUrl || "").trim();
  if (configured) return configured.replace(/\/+$/, "");
  const publicIp = await detectPublicIp().catch(() => "");
  if (!publicIp) return null;
  return `http://${publicIp}:${config.port}`;
}

export async function ensureGitHubPushWebhook(
  token: string,
  fullName: string,
  opts: { baseUrl?: string | null; path?: string; secret?: string } = {},
): Promise<{ ok: true; url: string; hookId: number | null; action: "created" | "updated" } | { ok: false; url?: string; error: string }> {
  const baseUrl = String(typeof opts.baseUrl === "undefined" ? await defaultWebhookBaseUrl() : opts.baseUrl || "").trim().replace(/\/+$/, "");
  if (!baseUrl) return { ok: false, error: "public AIOS base URL is not configured" };
  const webhookPath = opts.path || "/github/webhook";
  if (!/^[\w.-]+\/[\w.-]+$/.test(fullName)) return { ok: false, url: `${baseUrl}${webhookPath}`, error: "invalid GitHub repo full name" };

  const url = `${baseUrl}${webhookPath}`;
  const encodedFullName = fullName.split("/").map(encodeURIComponent).join("/");
  const secret = opts.secret || githubWebhookSecret();
  const body = {
    name: "web",
    active: true,
    events: ["push"],
    config: {
      url,
      content_type: "json",
      secret,
      insecure_ssl: "0",
    },
  };

  const hooksResponse = await ghFetch(`/repos/${encodedFullName}/hooks?per_page=100`, token);
  if (!hooksResponse.ok) {
    const text = await hooksResponse.text().catch(() => "");
    return { ok: false, url, error: `github hooks list failed (${hooksResponse.status}): ${text.slice(0, 200)}` };
  }
  const hooks = await hooksResponse.json() as Array<{ id?: number; config?: { url?: string } }>;
  const existing = hooks.find((hook) => hook.config?.url === url);
  const path = existing?.id
    ? `/repos/${encodedFullName}/hooks/${existing.id}`
    : `/repos/${encodedFullName}/hooks`;
  const response = await ghFetch(path, token, {
    method: existing?.id ? "PATCH" : "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    return { ok: false, url, error: `github webhook ${existing?.id ? "update" : "create"} failed (${response.status}): ${text.slice(0, 200)}` };
  }
  const json = await response.json().catch(() => ({})) as { id?: number };
  return {
    ok: true,
    url,
    hookId: typeof json.id === "number" ? json.id : existing?.id || null,
    action: existing?.id ? "updated" : "created",
  };
}

export function cloneUrlWithPat(cloneUrl: string, username: string, token: string): string {
  // https://github.com/foo/bar.git → https://<user>:<token>@github.com/foo/bar.git
  return cloneUrl.replace(/^https:\/\//, `https://${encodeURIComponent(username)}:${encodeURIComponent(token)}@`);
}
