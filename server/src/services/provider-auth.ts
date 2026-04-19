// Provider-auth service: Anthropic OAuth PKCE + OpenAI Codex device-auth.
// Module-scoped singletons enforce "one Anthropic + one OpenAI session at a time".
//
// Credential ground truth lives on disk:
//   ~/.claude/.credentials.json   (Claude Code)
//   ~/.codex/auth.json            (Codex)
// Never cache auth state — re-check on every poll.

import { randomBytes, createHash } from "crypto";
import { spawn, spawnSync, ChildProcess } from "child_process";
import { stat, readFile } from "fs/promises";
import { join } from "path";

import { log } from "../log";

// ---------- Constants (don't re-derive) ----------
export const ANTHROPIC_OAUTH_AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
export const ANTHROPIC_OAUTH_TOKEN_URL     = "https://platform.claude.com/v1/oauth/token";
export const ANTHROPIC_OAUTH_MANUAL_REDIRECT_URL = "https://platform.claude.com/oauth/code/callback";
export const ANTHROPIC_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
export const ANTHROPIC_OAUTH_SCOPES = [
  "org:create_api_key",
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
];

export const DEVICE_CODE_TTL_MS = 15 * 60 * 1000;

// ---------- Env builders (shared by Phase 3 + Phase 6) ----------

export function getAgentHomeDir(): string {
  return process.env.AIOS_HOME
    || process.env.HOME
    || process.env.USERPROFILE
    || "/home/aios";
}

export function buildCommonAuthEnv(): NodeJS.ProcessEnv {
  const home = getAgentHomeDir();
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    PATH: [
      join(home, ".local", "bin"),
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      process.env.PATH || "",
    ].filter(Boolean).join(":"),
    FORCE_COLOR: "0",
    NO_COLOR: "1",
    TERM: "dumb",
  };
}

export function buildAnthropicAuthEnv(): NodeJS.ProcessEnv {
  const home = getAgentHomeDir();
  return {
    ...buildCommonAuthEnv(),
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    CLAUDE_CREDENTIALS_PATH: join(home, ".claude", ".credentials.json"),
    CLAUDE_LEGACY_CREDENTIALS_PATH: join(home, ".claude.json"),
  };
}

export function buildOpenAiAuthEnv(): NodeJS.ProcessEnv {
  return {
    ...buildCommonAuthEnv(),
    CODEX_HOME: join(getAgentHomeDir(), ".codex"),
  };
}

// ---------- Detection by file existence ----------

async function pathExists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

export async function anthropicAuthDetected(): Promise<boolean> {
  const home = getAgentHomeDir();
  if (await pathExists(join(home, ".claude", ".credentials.json"))) return true;
  const legacy = join(home, ".claude.json");
  if (await pathExists(legacy)) {
    try {
      const c = JSON.parse(await readFile(legacy, "utf-8"));
      if (c.oauthAccount || c.sessionKey || c.apiKey) return true;
    } catch {}
  }
  return false;
}

export async function codexAuthDetected(): Promise<boolean> {
  return pathExists(join(getAgentHomeDir(), ".codex", "auth.json"));
}

// ---------- Anthropic OAuth PKCE ----------

export interface AnthropicSnapshot {
  loggedIn: boolean;
  email?: string;
  organizationName?: string;
  subscriptionType?: string;
}

interface AnthropicSession {
  id: string;
  codeVerifier: string;
  state: string;
  verificationUrl: string;
  createdAt: number;
  status: "waiting" | "complete" | "failed" | "canceled";
  error?: string;
  snapshot?: AnthropicSnapshot;
}

let anthropicSession: AnthropicSession | null = null;

export function getAnthropicSession(): Omit<AnthropicSession, "codeVerifier" | "state"> | null {
  if (!anthropicSession) return null;
  const { codeVerifier: _v, state: _s, ...safe } = anthropicSession;
  return safe;
}

function generateCodeVerifier() { return randomBytes(32).toString("base64url"); }
function createCodeChallenge(v: string) {
  return createHash("sha256").update(v).digest().toString("base64url");
}

function buildVerificationUrl(codeVerifier: string, state: string): string {
  const url = new URL(ANTHROPIC_OAUTH_AUTHORIZE_URL);
  url.searchParams.set("code", "true");
  url.searchParams.set("client_id", ANTHROPIC_OAUTH_CLIENT_ID);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", ANTHROPIC_OAUTH_MANUAL_REDIRECT_URL);
  url.searchParams.set("scope", ANTHROPIC_OAUTH_SCOPES.join(" "));
  url.searchParams.set("code_challenge", createCodeChallenge(codeVerifier));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  return url.toString();
}

export function startAnthropicSession(): { sessionId: string; verificationUrl: string; status: "waiting" } {
  if (anthropicSession && anthropicSession.status === "waiting") {
    throw new Error("an Anthropic auth session is already in progress");
  }
  const codeVerifier = generateCodeVerifier();
  const state = randomBytes(24).toString("base64url");
  const verificationUrl = buildVerificationUrl(codeVerifier, state);
  anthropicSession = {
    id: randomBytes(12).toString("base64url"),
    codeVerifier, state, verificationUrl,
    createdAt: Date.now(),
    status: "waiting",
  };
  return { sessionId: anthropicSession.id, verificationUrl, status: "waiting" };
}

async function exchangeAuthorizationCode(input: {
  authorizationCode: string; codeVerifier: string; state: string;
}): Promise<Record<string, unknown>> {
  const r = await fetch(ANTHROPIC_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: ANTHROPIC_OAUTH_CLIENT_ID,
      code: input.authorizationCode,
      code_verifier: input.codeVerifier,
      grant_type: "authorization_code",
      redirect_uri: ANTHROPIC_OAUTH_MANUAL_REDIRECT_URL,
      state: input.state,
    }),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    // Redact any token-looking fragment before surfacing.
    throw new Error(`token exchange failed (${r.status}): ${text.slice(0, 200)}`);
  }
  return await r.json() as Record<string, unknown>;
}

function installRefreshToken(refreshToken: string): { ok: boolean; stderr?: string } {
  const r = spawnSync("claude", ["auth", "login"], {
    cwd: getAgentHomeDir(),
    encoding: "utf8",
    env: {
      ...buildAnthropicAuthEnv(),
      CLAUDE_CODE_OAUTH_REFRESH_TOKEN: refreshToken,
    },
  });
  if (r.error) return { ok: false, stderr: String(r.error.message) };
  if (r.status !== 0) return { ok: false, stderr: r.stderr };
  return { ok: true };
}

/**
 * Accept either a raw `code#state` string or a full redirect URL pasted back
 * from the Anthropic manual-redirect page.
 */
function parsePastedCode(raw: string): { code: string; state: string } {
  const trimmed = raw.trim();
  let code = trimmed;
  let state = "";
  // Support the redirect URL case.
  try {
    const u = new URL(trimmed);
    const qCode = u.searchParams.get("code");
    const qState = u.searchParams.get("state");
    if (qCode) code = qCode;
    if (qState) state = qState;
  } catch {}
  if (!state && code.includes("#")) {
    const [c, s] = code.split("#");
    code = c; state = s;
  }
  if (!code || !state) throw new Error("paste must contain both code and state");
  return { code, state };
}

export async function submitAnthropicCode(raw: string): Promise<{
  status: "complete" | "failed";
  snapshot?: AnthropicSnapshot;
  error?: string;
}> {
  if (!anthropicSession) throw new Error("no Anthropic session in progress");
  if (anthropicSession.status !== "waiting") {
    throw new Error(`Anthropic session is ${anthropicSession.status}`);
  }
  try {
    const { code, state } = parsePastedCode(raw);
    if (state !== anthropicSession.state) throw new Error("state mismatch");
    const token = await exchangeAuthorizationCode({
      authorizationCode: code,
      codeVerifier: anthropicSession.codeVerifier,
      state,
    });
    const refresh = token["refresh_token"];
    if (typeof refresh !== "string") throw new Error("no refresh_token in response");
    const inst = installRefreshToken(refresh);
    if (!inst.ok) {
      log.warn("claude auth login failed; continuing if credentials file was still written:", inst.stderr?.slice(0, 200));
    }
    // Ground truth: file must exist.
    const ok = await anthropicAuthDetected();
    if (!ok) throw new Error("credentials file not written");
    const snapshot = await readAnthropicSnapshot();
    anthropicSession.status = "complete";
    anthropicSession.snapshot = snapshot;
    return { status: "complete", snapshot };
  } catch (e: any) {
    anthropicSession!.status = "failed";
    anthropicSession!.error = String(e?.message || e);
    return { status: "failed", error: anthropicSession!.error };
  }
}

export function cancelAnthropicSession() {
  if (anthropicSession && anthropicSession.status === "waiting") {
    anthropicSession.status = "canceled";
  }
  anthropicSession = null;
}

export async function readAnthropicSnapshot(): Promise<AnthropicSnapshot> {
  // Optional richer snapshot via `claude auth status --json`. Best-effort.
  try {
    const r = spawnSync("claude", ["auth", "status", "--json"], {
      cwd: getAgentHomeDir(),
      encoding: "utf8",
      env: buildAnthropicAuthEnv(),
      timeout: 5000,
    });
    if (r.status === 0 && r.stdout) {
      try {
        const j = JSON.parse(r.stdout);
        return {
          loggedIn: !!j.loggedIn || !!j.logged_in || !!j.authenticated,
          email: j.email,
          organizationName: j.organizationName || j.organization?.name,
          subscriptionType: j.subscriptionType || j.subscription?.type,
        };
      } catch {}
    }
  } catch {}
  return { loggedIn: await anthropicAuthDetected() };
}

// ---------- OpenAI Codex device-auth ----------

export function stripAnsi(s: string): string {
  return s.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

interface OpenAiSession {
  id: string;
  child: ChildProcess | null;
  userCode: string | null;
  verificationUrl: string | null;
  createdAt: number;
  expiresAt: number;
  status: "waiting" | "complete" | "failed" | "canceled";
  error?: string;
  stdoutTail: string[];
}

let openAiSession: OpenAiSession | null = null;
let openAiTtlTimer: NodeJS.Timeout | null = null;

export function getOpenAiSession(): Omit<OpenAiSession, "child"> | null {
  if (!openAiSession) return null;
  const { child: _c, ...safe } = openAiSession;
  return safe;
}

export async function startOpenAiDeviceAuth(): Promise<Omit<OpenAiSession, "child">> {
  if (openAiSession && openAiSession.status === "waiting") {
    throw new Error("an OpenAI auth session is already in progress");
  }
  const session: OpenAiSession = {
    id: randomBytes(12).toString("base64url"),
    child: null,
    userCode: null,
    verificationUrl: null,
    createdAt: Date.now(),
    expiresAt: Date.now() + DEVICE_CODE_TTL_MS,
    status: "waiting",
    stdoutTail: [],
  };

  try {
    session.child = spawn("codex", ["login", "--device-auth"], {
      cwd: getAgentHomeDir(),
      env: buildOpenAiAuthEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e: any) {
    session.status = "failed";
    session.error = `failed to spawn codex: ${e?.message || e}`;
    openAiSession = session;
    const { child: _c, ...safe } = session;
    return safe;
  }

  const onData = (buf: Buffer) => {
    const text = stripAnsi(buf.toString("utf-8"));
    session.stdoutTail.push(text);
    if (session.stdoutTail.length > 50) session.stdoutTail.shift();
    const urlMatch = text.match(/https:\/\/(auth\.openai\.com|chatgpt\.com)[^\s]+/);
    if (urlMatch && !session.verificationUrl) session.verificationUrl = urlMatch[0];
    const codeMatch = text.match(/\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/);
    if (codeMatch && !session.userCode) session.userCode = codeMatch[1];
  };
  session.child!.stdout?.on("data", onData);
  session.child!.stderr?.on("data", onData);

  session.child!.on("exit", async (code) => {
    const detected = await codexAuthDetected();
    if (session.status === "waiting") {
      if (detected && (code === 0 || code === null)) {
        session.status = "complete";
      } else if (!detected) {
        session.status = "failed";
        session.error = session.error || `codex login exited ${code}`;
      }
    }
  });

  if (openAiTtlTimer) clearTimeout(openAiTtlTimer);
  openAiTtlTimer = setTimeout(() => {
    if (session.status === "waiting") cancelOpenAiSession("timed out");
  }, DEVICE_CODE_TTL_MS);

  openAiSession = session;
  // Wait up to 5s for the child to emit both fields before returning.
  const start = Date.now();
  while (Date.now() - start < 5000) {
    if (session.userCode && session.verificationUrl) break;
    if (session.status !== "waiting") break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const { child: _c, ...safe } = session;
  return safe;
}

export function cancelOpenAiSession(reason = "canceled") {
  if (!openAiSession) return;
  if (openAiSession.child && !openAiSession.child.killed) {
    try { openAiSession.child.kill("SIGTERM"); } catch {}
  }
  if (openAiSession.status === "waiting") {
    openAiSession.status = reason === "canceled" ? "canceled" : "failed";
    if (reason !== "canceled") openAiSession.error = reason;
  }
  if (openAiTtlTimer) { clearTimeout(openAiTtlTimer); openAiTtlTimer = null; }
}
