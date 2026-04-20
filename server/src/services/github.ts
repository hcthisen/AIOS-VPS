// Minimal GitHub integration: personal-access-token or deploy-key.
// v1 supports PAT; OAuth app can be added later without changing the storage shape.

import { kvGet, kvSet } from "../db";

export interface GithubCreds {
  mode: "pat" | "deploy_key";
  username?: string;
  token?: string;     // PAT; stored as-is (the filesystem is the source of truth per PRD)
  publicKey?: string; // for deploy-key flow
  privateKeyPath?: string;
}

const KEY = "github.creds";

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

export function cloneUrlWithPat(cloneUrl: string, username: string, token: string): string {
  // https://github.com/foo/bar.git → https://<user>:<token>@github.com/foo/bar.git
  return cloneUrl.replace(/^https:\/\//, `https://${encodeURIComponent(username)}:${encodeURIComponent(token)}@`);
}
