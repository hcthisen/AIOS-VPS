---
title: Claude Code + Codex CLI Onboarding
summary: Portable recipe for installing the Claude Code and Codex CLIs on a VPS during bootstrap, then letting an admin sign in with their Claude.ai and ChatGPT subscriptions from a dashboard UI.
---

This guide describes the pattern Paperclip uses to (1) install the Claude Code and OpenAI Codex CLIs on a fresh VPS and (2) let a logged-in admin bind their Claude subscription (OAuth PKCE) and their ChatGPT subscription (OpenAI device-auth) to the server from a dashboard page. Both CLIs then run as the app user, reading credentials from disk.

Reference implementation in this repo:

- Installer: `scripts/vps-bootstrap.sh` (Phase 8, `install_cli_tools()`)
- Server auth logic: `server/src/services/provider-auth.ts`
- Server endpoints: `server/src/routes/provider-auth.ts`
- Frontend page: `ui/src/pages/ProviderAuth.tsx` (route `/setup/providers`)
- Credential paths: `~/.claude/.credentials.json`, `~/.codex/auth.json`

---

## Design principles

1. **CLIs are installed once, at bootstrap, as the unprivileged app user.** No per-session install. Claude Code goes into `~/.local/bin`, Codex is installed globally via npm.
2. **Credentials live on disk under the app user's home.** Not in the database, not in env vars. Both CLIs already know how to find them, so any subprocess we spawn inherits auth for free.
3. **The dashboard never handles raw passwords or API keys.** Claude Code uses an OAuth PKCE round-trip; Codex uses OpenAI's device-auth flow. The user authenticates against the vendor; we just receive the token the CLI writes to disk.
4. **Auth state is detected by file existence, not a DB flag.** Server checks `~/.claude/.credentials.json` and `~/.codex/auth.json` on each poll. That keeps the dashboard honest even if a sibling process logged in or out.

---

## Part 1 — Bootstrap-time CLI install

Runs as root during VPS bootstrap, with an app user named here `myapp`.

```bash
APP_USER="myapp"
APP_HOME="/home/${APP_USER}"

# 1. Create config dirs and fix ownership
mkdir -p "${APP_HOME}/.claude" "${APP_HOME}/.codex"
# Seed an empty legacy file; some Claude Code versions require it to exist
[[ -f "${APP_HOME}/.claude.json" ]] || printf '{}\n' > "${APP_HOME}/.claude.json"
chmod 600 "${APP_HOME}/.claude.json"
chown -R "${APP_USER}":"${APP_USER}" \
  "${APP_HOME}/.claude" "${APP_HOME}/.codex" "${APP_HOME}/.claude.json"

# 2. Put ~/.local/bin on PATH for the app user
if ! grep -q '.local/bin' "${APP_HOME}/.bashrc" 2>/dev/null; then
  echo 'export PATH="$HOME/.local/bin:$PATH"' >> "${APP_HOME}/.bashrc"
  chown "${APP_USER}":"${APP_USER}" "${APP_HOME}/.bashrc"
fi

# 3. Claude Code — per-user install via the official installer
sudo -u "${APP_USER}" bash -lc \
  'export PATH="$HOME/.local/bin:$PATH" && curl -fsSL https://claude.ai/install.sh | bash'

# 4. Codex — global npm install (goes to /usr/lib/node_modules, root runs it)
npm install --global @openai/codex@latest
```

After this, `sudo -u myapp bash -lc 'command -v claude && command -v codex'` should print both paths.

### systemd environment contract

When you launch the server under systemd, make sure the unit exports the same PATH and HOME the CLIs expect:

```ini
# /etc/systemd/system/myapp.service (excerpt)
[Service]
User=myapp
Environment=HOME=/home/myapp
Environment=PATH=/home/myapp/.local/bin:/usr/local/bin:/usr/bin:/bin
```

The server uses these to build the child-process environment when it later spawns `claude` / `codex`.

---

## Part 2 — Environment helpers (server-side)

Every subprocess call uses the same curated env so the CLIs find their own config regardless of how the parent process was started.

```ts
// server/src/services/provider-auth.ts
function getAgentHomeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || "/home/myapp";
}

function buildCommonAuthEnv(): NodeJS.ProcessEnv {
  const home = getAgentHomeDir();
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    PATH: [
      join(home, ".local", "bin"),
      "/usr/local/bin",
      "/usr/bin",
      process.env.PATH || "",
    ].join(":"),
    FORCE_COLOR: "0",
    NO_COLOR: "1",
    TERM: "dumb", // keep ANSI sequences out of parsed output
  };
}

function buildAnthropicAuthEnv() {
  const home = getAgentHomeDir();
  return {
    ...buildCommonAuthEnv(),
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    CLAUDE_CREDENTIALS_PATH: join(home, ".claude", ".credentials.json"),
    CLAUDE_LEGACY_CREDENTIALS_PATH: join(home, ".claude.json"),
  };
}

function buildOpenAiAuthEnv() {
  return { ...buildCommonAuthEnv(), CODEX_HOME: join(getAgentHomeDir(), ".codex") };
}
```

`TERM=dumb` + `NO_COLOR=1` matter — the Codex device-auth prompt prints the verification URL and user code with ANSI styling, and you need to parse it.

---

## Part 3 — Claude Code: OAuth PKCE

Claude Code ships with an OAuth client you can drive without the user ever touching the CLI. The flow:

1. Server generates a PKCE verifier + state, builds an authorize URL, returns it to the browser.
2. User opens the URL, signs in to Claude, is redirected to `https://platform.claude.com/oauth/code/callback?code=...&state=...` and shown a code of the form `<code>#<state>`.
3. User pastes that code back into the dashboard.
4. Server exchanges it for a refresh token, then invokes `claude auth login` with `CLAUDE_CODE_OAUTH_REFRESH_TOKEN` in the env to let the CLI write the token to `~/.claude/.credentials.json` itself.
5. Auth state flips to `complete` once `~/.claude/.credentials.json` exists.

### 3.1 Constants

```ts
const ANTHROPIC_OAUTH_AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const ANTHROPIC_OAUTH_TOKEN_URL     = "https://platform.claude.com/v1/oauth/token";
const ANTHROPIC_OAUTH_MANUAL_REDIRECT_URL = "https://platform.claude.com/oauth/code/callback";
const ANTHROPIC_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const ANTHROPIC_OAUTH_SCOPES = [
  "org:create_api_key",
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
];
```

### 3.2 Build the authorize URL

```ts
function generateCodeVerifier() {
  return randomBytes(32).toString("base64url");
}
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
```

### 3.3 Exchange the code and hand it to the CLI

```ts
async function exchangeAuthorizationCode(input: {
  authorizationCode: string; codeVerifier: string; state: string;
}) {
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
  if (!r.ok) throw new Error(`Token exchange failed (${r.status})`);
  return await r.json() as Record<string, unknown>;
}

function installRefreshToken(refreshToken: string) {
  spawnSync("claude", ["auth", "login"], {
    cwd: getAgentHomeDir(),
    encoding: "utf8",
    env: {
      ...buildAnthropicAuthEnv(),
      CLAUDE_CODE_OAUTH_REFRESH_TOKEN: refreshToken,
    },
  });
}
```

### 3.4 Detect whether we are signed in

```ts
async function anthropicAuthDetected(): Promise<boolean> {
  const home = getAgentHomeDir();
  if (await pathExists(join(home, ".claude", ".credentials.json"))) return true;
  // Legacy path: only counts if it carries real auth material
  const legacy = join(home, ".claude.json");
  if (await pathExists(legacy)) {
    try {
      const c = JSON.parse(await readFile(legacy, "utf-8")) as any;
      if (c.oauthAccount || c.sessionKey || c.apiKey) return true;
    } catch {}
  }
  return false;
}

// Optional richer snapshot: `claude auth status --json`
export async function getAnthropicAuthSnapshot() {
  const r = spawnSync("claude", ["auth", "status", "--json"], {
    cwd: getAgentHomeDir(), encoding: "utf8", env: buildAnthropicAuthEnv(),
  });
  // parse JSON → { loggedIn, email, organizationName, subscriptionType, ... }
}
```

### 3.5 Endpoints

```ts
// POST /api/provider-auth/anthropic/start
// Creates a fresh PKCE session, returns { verificationUrl, sessionId, status: "waiting" }.
router.post("/provider-auth/anthropic/start", adminOnly, startAnthropicSession);

// POST /api/provider-auth/anthropic/submit
// Body: { code: "<code>#<state>" }  (accepts the pasted redirect URL too)
// Exchanges, installs token via `claude auth login`, returns { status: "complete", snapshot }.
router.post("/provider-auth/anthropic/submit", adminOnly, submitAnthropicCode);

// GET  /api/provider-auth/anthropic         — current session state
// POST /api/provider-auth/anthropic/cancel  — drop the in-memory session
```

Session state is kept in a module-scoped variable (`let anthropicSession: AnthropicSession | null`), not the database. Only one auth flow is ever in flight.

---

## Part 4 — Codex: OpenAI device-auth

Codex doesn't expose an OAuth URL you can render yourself — instead the server spawns `codex login --device-auth`, parses the verification URL and user code from its stdout, and shows them to the admin. The child process stays alive until the user authenticates or the server kills it.

### 4.1 Start: spawn and scrape stdout

```ts
function stripAnsi(s: string) {
  return s.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

async function startOpenAiDeviceAuth() {
  const child = spawn("codex", ["login", "--device-auth"], {
    cwd: getAgentHomeDir(),
    env: buildOpenAiAuthEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });

  let userCode: string | null = null;
  let verificationUrl: string | null = null;

  const onData = (buf: Buffer) => {
    const text = stripAnsi(buf.toString("utf8"));
    const urlMatch = text.match(/https:\/\/auth\.openai\.com\/[^\s]+/);
    if (urlMatch) verificationUrl = urlMatch[0];
    const codeMatch = text.match(/\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/);
    if (codeMatch) userCode = codeMatch[1];
    // update session snapshot as soon as both are known
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);

  child.on("exit", () => {
    // When the child exits cleanly, ~/.codex/auth.json exists — session flips
    // to "complete". If it exits non-zero before we got both fields, it's an error.
  });

  return { child, getSnapshot: () => ({ userCode, verificationUrl }) };
}
```

### 4.2 Detect whether we are signed in

```ts
async function codexAuthDetected(): Promise<boolean> {
  return pathExists(join(getAgentHomeDir(), ".codex", "auth.json"));
}
```

### 4.3 Endpoints

```ts
// POST /api/provider-auth/openai/start
// Spawns `codex login --device-auth`, waits until it prints both fields,
// returns { userCode, verificationUrl, sessionId, status: "waiting", expiresAt }.
router.post("/provider-auth/openai/start", adminOnly, startOpenAiSession);

// GET  /api/provider-auth/openai         — current session (frontend polls this)
// POST /api/provider-auth/openai/cancel  — kills the child (SIGTERM)
```

Frontend polls `GET /api/provider-auth/openai` every ~2 seconds until `status === "complete"`. `DEVICE_CODE_TTL_MS = 15 * 60 * 1000` is a sensible ceiling after which the server force-cancels the session.

### 4.4 Combined status

```ts
// GET /api/provider-auth/status → { anthropic: {...}, openai: {...} }
// Used by the provider-setup page to render both cards in one request.
```

---

## Part 5 — Frontend page (`/setup/providers`)

Two cards on one page. Each card goes through the same states: `idle → waiting → complete | failed | canceled`.

### Claude Code card

1. Admin clicks **Connect Claude Code** → `POST /api/provider-auth/anthropic/start`.
2. Frontend opens `verificationUrl` in a new tab and shows a text input: "Paste the code from Claude".
3. On submit, `POST /api/provider-auth/anthropic/submit` with `{ code }`.
4. If `status: "complete"`, render the organization name / email / subscription type the snapshot returned.

### Codex card

1. Admin clicks **Connect Codex** → `POST /api/provider-auth/openai/start`.
2. Frontend renders the returned `userCode` (big, monospaced) and a clickable `verificationUrl`.
3. Poll `GET /api/provider-auth/openai` every 2 s. When `status: "complete"`, show success.
4. "Cancel" button hits `POST /api/provider-auth/openai/cancel`.

### Skip

Both cards should show a **Skip for now** link that advances the setup phase — the app keeps working, the admin just cannot run those adapters yet.

---

## Part 6 — Credential storage summary

| Provider    | File                          | Written by            | Read by                       |
| ----------- | ----------------------------- | --------------------- | ----------------------------- |
| Claude Code | `~/.claude/.credentials.json` | `claude auth login`   | `claude` and any subprocess   |
| Claude Code | `~/.claude.json` (legacy)     | Older CLI versions    | Fallback auth check           |
| Codex       | `~/.codex/auth.json`          | `codex login --device-auth` | `codex` and any subprocess |

Nothing about these files is app-specific. If you back them up, you back up the subscription binding.

---

## Part 7 — Gotchas worth knowing

- **Path drift.** If the server is launched without `~/.local/bin` on PATH, `claude` is simply "not installed". Always pin PATH in both the systemd unit and every `spawn()` env.
- **ANSI in stdout.** The Codex CLI styles its device-auth output. Strip ANSI before regexing, and don't trust the first line — the URL and code may appear on different lines.
- **Credentials file appears before the child exits.** Watch both file existence and child exit to decide when to mark `complete`.
- **One session at a time.** Keep `anthropicSession` and `openAiSession` as module-level singletons and reject `/start` while one is live. Otherwise, you leak Codex subprocesses.
- **Refresh tokens rotate.** When refresh tokens expire, `claude auth status --json` returns `loggedIn: false` even though the file exists. Don't cache detection; re-check on every page render.
- **Legacy `~/.claude.json`.** Some fresh installs write it as an empty `{}`. Treat "exists" as authenticated only if it contains `oauthAccount`, `sessionKey`, or `apiKey`.
- **Do not log the refresh token.** Redact it before anywhere near your logger.
- **Cancellation must SIGTERM the child, not just clear the session object.** Otherwise the Codex process lingers.

---

## Part 8 — Replication checklist

- [ ] Bootstrap script installs Claude Code as app user via `curl https://claude.ai/install.sh | bash`.
- [ ] Bootstrap script installs Codex via `npm install --global @openai/codex@latest`.
- [ ] systemd unit exports `HOME`, `USERPROFILE`, and `PATH` with `~/.local/bin` first.
- [ ] `provider-auth` service with the Anthropic constants above and the Codex spawn wrapper.
- [ ] Endpoints: `anthropic/start`, `anthropic/submit`, `anthropic/cancel`, `anthropic`, `openai/start`, `openai/cancel`, `openai`, and a combined `status`.
- [ ] Frontend `/setup/providers` page with two cards (OAuth paste flow + device-code flow) and polling.
- [ ] Setup phase machine: after providers are bound (or skipped), flip `setupPhase` to `complete` so `/api/health` returns the terminal state and the page redirects into the app.
- [ ] Admin-only guards on every endpoint (instance-admin role, not ordinary users).
