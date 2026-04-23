import { createHash, randomBytes } from "crypto";
import { spawn, spawnSync, ChildProcess } from "child_process";
import { stat, readFile, mkdir, writeFile } from "fs/promises";
import { delimiter, join } from "path";

import { log } from "../log";

export const DEVICE_CODE_TTL_MS = 15 * 60 * 1000;

const ANTHROPIC_OAUTH_AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const ANTHROPIC_OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const ANTHROPIC_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const ANTHROPIC_OAUTH_MANUAL_REDIRECT_URL = "https://platform.claude.com/oauth/code/callback";
const ANTHROPIC_OAUTH_SCOPES = [
  "org:create_api_key",
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
];

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
    ].filter(Boolean).join(delimiter),
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

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function encodeBase64Url(value: Buffer): string {
  return value.toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function generateCodeVerifier(): string {
  return encodeBase64Url(randomBytes(32));
}

function generateOAuthState(): string {
  return encodeBase64Url(randomBytes(32));
}

function createCodeChallenge(codeVerifier: string): string {
  return encodeBase64Url(createHash("sha256").update(codeVerifier).digest());
}

function parseScopeList(value: unknown): string[] {
  return typeof value === "string"
    ? value.split(/\s+/).map((part) => part.trim()).filter(Boolean)
    : [];
}

function buildAnthropicVerificationUrl(codeVerifier: string, state: string): string {
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

function parseAnthropicCallback(value: string): { code: string; state: string } | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    try {
      const url = new URL(trimmed);
      const code = url.searchParams.get("code")?.trim();
      const state = url.searchParams.get("state")?.trim();
      if (code && state) return { code, state };
    } catch {}
  }
  const match = trimmed.match(/^([A-Za-z0-9_-]+)#([A-Za-z0-9_-]+)$/);
  return match ? { code: match[1], state: match[2] } : null;
}

async function ensureAnthropicConfigFiles(): Promise<void> {
  const home = getAgentHomeDir();
  const claudeDir = join(home, ".claude");
  const legacyPath = join(home, ".claude.json");
  const nestedLegacyPath = join(claudeDir, ".claude.json");

  await mkdir(claudeDir, { recursive: true });
  if (!(await pathExists(legacyPath))) {
    await writeFile(legacyPath, "{}\n", "utf-8");
  }
  if (!(await pathExists(nestedLegacyPath))) {
    await writeFile(nestedLegacyPath, "{}\n", "utf-8");
  }
}

export async function anthropicAuthDetected(): Promise<boolean> {
  const home = getAgentHomeDir();
  const credentialsPath = join(home, ".claude", ".credentials.json");
  if (await pathExists(credentialsPath)) return true;

  const legacyPath = join(home, ".claude.json");
  if (await pathExists(legacyPath)) {
    try {
      const content = JSON.parse(await readFile(legacyPath, "utf-8"));
      if (content.oauthAccount || content.sessionKey || content.apiKey) return true;
    } catch {}
  }
  return false;
}

export async function codexAuthDetected(): Promise<boolean> {
  return pathExists(join(getAgentHomeDir(), ".codex", "auth.json"));
}

export interface AnthropicSnapshot {
  loggedIn: boolean;
  email?: string;
  organizationName?: string;
  subscriptionType?: string;
}

interface AnthropicSession {
  id: string;
  codeVerifier: string;
  oauthState: string;
  verificationUrl: string;
  createdAt: number;
  status: "waiting" | "complete" | "failed" | "canceled";
  error?: string;
  snapshot?: AnthropicSnapshot;
}

let anthropicSession: AnthropicSession | null = null;

export function getAnthropicSession(): Omit<AnthropicSession, "codeVerifier" | "oauthState"> | null {
  if (!anthropicSession) return null;
  const { codeVerifier: _codeVerifier, oauthState: _oauthState, ...safe } = anthropicSession;
  return safe;
}

async function exchangeAnthropicAuthorizationCode(input: {
  authorizationCode: string;
  codeVerifier: string;
  state: string;
}): Promise<Record<string, unknown>> {
  const response = await fetch(ANTHROPIC_OAUTH_TOKEN_URL, {
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

  if (response.ok) {
    return await response.json() as Record<string, unknown>;
  }

  const detail = (await response.text()).trim();
  throw new Error(
    detail
      ? `Claude token exchange failed (${response.status}): ${detail}`
      : `Claude token exchange failed (${response.status}).`,
  );
}

function installAnthropicRefreshToken(refreshToken: string, scopes: string[]): void {
  const result = spawnSync("claude", ["auth", "login"], {
    cwd: getAgentHomeDir(),
    encoding: "utf8",
    env: {
      ...buildAnthropicAuthEnv(),
      CLAUDE_CODE_OAUTH_REFRESH_TOKEN: refreshToken,
      CLAUDE_CODE_OAUTH_SCOPES: scopes.join(" "),
    },
    timeout: 15000,
  });

  if (result.status === 0) return;

  const detail = [
    String(result.error?.message || "").trim(),
    String(result.stderr || "").trim(),
    String(result.stdout || "").trim(),
  ].filter(Boolean).join("\n");
  throw new Error(
    detail
      ? `Claude credential install failed: ${detail}`
      : `Claude credential install failed with code ${result.status ?? "unknown"}.`,
  );
}

export async function startAnthropicSession(): Promise<{
  id: string;
  verificationUrl: string;
  status: AnthropicSession["status"];
  error?: string;
}> {
  if (anthropicSession && anthropicSession.status === "waiting") {
    throw new Error("an Anthropic auth session is already in progress");
  }

  await ensureAnthropicConfigFiles();

  const session: AnthropicSession = {
    id: randomBytes(12).toString("base64url"),
    codeVerifier: generateCodeVerifier(),
    oauthState: generateOAuthState(),
    verificationUrl: "",
    createdAt: Date.now(),
    status: "waiting",
  };
  session.verificationUrl = buildAnthropicVerificationUrl(session.codeVerifier, session.oauthState);
  anthropicSession = session;

  return {
    id: session.id,
    verificationUrl: session.verificationUrl,
    status: session.status,
    error: session.error,
  };
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

  const payload = parseAnthropicCallback(raw);
  if (!payload) {
    throw new Error("Paste the Claude callback URL or the full code#state value.");
  }
  if (payload.state !== anthropicSession.oauthState) {
    anthropicSession.status = "failed";
    anthropicSession.error = "This callback belongs to a different sign-in attempt. Start again.";
    return { status: "failed", error: anthropicSession.error };
  }

  try {
    const tokenResponse = await exchangeAnthropicAuthorizationCode({
      authorizationCode: payload.code,
      codeVerifier: anthropicSession.codeVerifier,
      state: anthropicSession.oauthState,
    });
    const refreshToken = optionalString(tokenResponse.refresh_token);
    if (!refreshToken) {
      throw new Error("Token exchange did not return a refresh token.");
    }

    const scopes = parseScopeList(tokenResponse.scope);
    installAnthropicRefreshToken(refreshToken, scopes.length ? scopes : ANTHROPIC_OAUTH_SCOPES);

    const snapshot = await readAnthropicSnapshot();
    if (!snapshot.loggedIn) {
      throw new Error("Login finished without persisting credentials.");
    }

    anthropicSession.status = "complete";
    anthropicSession.error = undefined;
    anthropicSession.snapshot = snapshot;
    return { status: "complete", snapshot };
  } catch (e: any) {
    anthropicSession.status = "failed";
    anthropicSession.error = String(e?.message || e);
    return { status: "failed", error: anthropicSession.error };
  }
}

export function cancelAnthropicSession() {
  if (anthropicSession && anthropicSession.status === "waiting") {
    anthropicSession.status = "canceled";
  }
  anthropicSession = null;
}

export async function readAnthropicSnapshot(): Promise<AnthropicSnapshot> {
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

export function stripAnsi(s: string): string {
  return s.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

function extractOpenAiVerificationUrl(text: string): string | null {
  const match = text.match(/https:\/\/(?:auth\.openai\.com|chatgpt\.com)[^\s]+/);
  return match ? match[0] : null;
}

function extractOpenAiUserCode(text: string): string | null {
  const patterns = [
    /\b([A-Z0-9]{4}-[A-Z0-9]{5})\b/,
    /\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/,
    /\b([A-Z0-9]{3}-[A-Z0-9]{3}-[A-Z0-9]{3})\b/,
    /\b([A-Z0-9]{9})\b/,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1];
  }
  return null;
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
    const combined = stripAnsi(session.stdoutTail.join("\n"));
    if (!session.verificationUrl) session.verificationUrl = extractOpenAiVerificationUrl(combined);
    if (!session.userCode) session.userCode = extractOpenAiUserCode(combined);
  };
  session.child.stdout?.on("data", onData);
  session.child.stderr?.on("data", onData);

  session.child.on("exit", async (code) => {
    if (openAiTtlTimer) {
      clearTimeout(openAiTtlTimer);
      openAiTtlTimer = null;
    }
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
  if (openAiTtlTimer) {
    clearTimeout(openAiTtlTimer);
    openAiTtlTimer = null;
  }
}
