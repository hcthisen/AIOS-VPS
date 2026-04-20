---
title: Claude Code + Codex CLI Onboarding
summary: Portable recipe for installing Claude Code and Codex on a VPS, then onboarding both from a dashboard in a way that survives real production use.
---

This is the working pattern from this repo after debugging a real VPS onboarding flow. It covers bootstrap install, server-side auth orchestration, and the frontend behavior needed to make both providers usable from a setup wizard.

Reference implementation in this repo:

- Installer: `scripts/vps-bootstrap.sh`
- Server auth logic: `server/src/services/provider-auth.ts`
- Server endpoints: `server/src/routes/provider-auth.ts`
- Frontend page: `ui/src/pages/ProviderAuth.tsx`

## What actually works

1. Install both CLIs during bootstrap, not during onboarding.
2. Store credentials only in the app user's home directory.
3. Use Claude Code with OAuth PKCE plus `claude auth login` fed by env vars.
4. Use Codex with `codex login --device-auth`.
5. Detect auth by files on disk, not by a database flag.

The most important lesson: do not drive Claude Code by spawning a terminal and pasting the `code#state` back into the CLI. That was brittle in practice. The stable flow is PKCE on the server, token exchange on the server, then let `claude auth login` write credentials itself.

## Part 1 - Bootstrap install

Run as root. Install Claude as the app user, install Codex globally, and make sure the app user's home is the same home your server later exports via systemd.

```bash
APP_USER="myapp"
APP_HOME="/home/${APP_USER}"

run_as_app_home() {
  local command="$1"
  sudo -u "${APP_USER}" env HOME="${APP_HOME}" USERPROFILE="${APP_HOME}" bash -c \
    "export HOME='${APP_HOME}' USERPROFILE='${APP_HOME}' PATH=\"\$HOME/.local/bin:\$PATH\"; ${command}"
}

mkdir -p "${APP_HOME}/.claude" "${APP_HOME}/.codex"
[[ -f "${APP_HOME}/.claude.json" ]] || printf '{}\n' > "${APP_HOME}/.claude.json"
[[ -f "${APP_HOME}/.claude/.claude.json" ]] || cp "${APP_HOME}/.claude.json" "${APP_HOME}/.claude/.claude.json"
chown -R "${APP_USER}:${APP_USER}" "${APP_HOME}/.claude" "${APP_HOME}/.codex" "${APP_HOME}/.claude.json"
chmod 600 "${APP_HOME}/.claude.json" "${APP_HOME}/.claude/.claude.json"

if ! grep -qs '.local/bin' "${APP_HOME}/.bashrc"; then
  echo 'export PATH="$HOME/.local/bin:$PATH"' >> "${APP_HOME}/.bashrc"
  chown "${APP_USER}:${APP_USER}" "${APP_HOME}/.bashrc"
fi

if ! run_as_app_home 'command -v claude' >/dev/null 2>&1; then
  run_as_app_home 'set -o pipefail && curl -fsSL https://claude.ai/install.sh | bash' || true
  if ! run_as_app_home 'command -v claude' >/dev/null 2>&1; then
    run_as_app_home 'npm install --global --prefix "$HOME/.local" @anthropic-ai/claude-code@latest'
  fi
fi

if ! command -v codex >/dev/null 2>&1; then
  npm install --global --silent @openai/codex@latest
fi
```

Notes from production:

- Use `bash -c`, not `bash -lc`, in the helper. The login shell reset `HOME` and `PATH` in ways that broke Claude install.
- Seed both `~/.claude.json` and `~/.claude/.claude.json`. Some Claude versions expect both to exist.
- Verify install with:

```bash
sudo -u "${APP_USER}" env HOME="${APP_HOME}" USERPROFILE="${APP_HOME}" PATH="${APP_HOME}/.local/bin:/usr/local/bin:/usr/bin:/bin" \
  bash -c 'command -v claude && claude --version && command -v codex && codex --version'
```

## Part 2 - systemd environment contract

Your app service must export the same home and path the CLIs use.

```ini
[Service]
User=myapp
Environment=HOME=/home/myapp
Environment=USERPROFILE=/home/myapp
Environment=PATH=/home/myapp/.local/bin:/usr/local/bin:/usr/bin:/bin
Environment=CLAUDE_CONFIG_DIR=/home/myapp/.claude
Environment=CLAUDE_CREDENTIALS_PATH=/home/myapp/.claude/.credentials.json
Environment=CODEX_HOME=/home/myapp/.codex
```

## Part 3 - Shared env helpers in the server

Every subprocess should inherit a clean auth env:

```ts
function getAgentHomeDir(): string {
  return process.env.AIOS_HOME || process.env.HOME || process.env.USERPROFILE || "/home/myapp";
}

function buildCommonAuthEnv(): NodeJS.ProcessEnv {
  const home = getAgentHomeDir();
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    PATH: [join(home, ".local", "bin"), "/usr/local/bin", "/usr/bin", "/bin", process.env.PATH || ""]
      .filter(Boolean).join(":"),
    FORCE_COLOR: "0",
    NO_COLOR: "1",
    TERM: "dumb",
  };
}
```

`TERM=dumb` and `NO_COLOR=1` matter because Codex emits ANSI-decorated device auth output.

## Part 4 - Claude Code onboarding

Use OAuth PKCE on the server, then install the returned refresh token through the CLI.

Constants:

```ts
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
```

Flow:

1. `POST /api/provider-auth/anthropic/start`
2. Server creates `codeVerifier` + `state`, stores them in memory, and returns `verificationUrl`
3. Frontend opens that URL in a new tab
4. User signs in and pastes back either the full callback URL or the raw `code#state`
5. `POST /api/provider-auth/anthropic/submit`
6. Server exchanges the code for tokens
7. Server runs:

```ts
spawnSync("claude", ["auth", "login"], {
  cwd: getAgentHomeDir(),
  encoding: "utf8",
  env: {
    ...buildAnthropicAuthEnv(),
    CLAUDE_CODE_OAUTH_REFRESH_TOKEN: refreshToken,
    CLAUDE_CODE_OAUTH_SCOPES: scopes.join(" "),
  },
  timeout: 15000,
});
```

8. Server verifies `~/.claude/.credentials.json` exists and optionally reads `claude auth status --json`

Important details:

- Accept both a full callback URL and raw `code#state`
- Reject `state` mismatches
- Return the CLI stderr/stdout summary if `claude auth login` fails
- Keep only one Claude session in flight at a time

Do not use the PTY flow that launches `claude auth login --claudeai` and waits for terminal text. It looked simpler but was unreliable once the browser step moved outside the terminal.

## Part 5 - Codex onboarding

Codex should still use device auth driven by a child process.

Flow:

1. `POST /api/provider-auth/openai/start`
2. Spawn:

```ts
spawn("codex", ["login", "--device-auth"], {
  cwd: getAgentHomeDir(),
  env: buildOpenAiAuthEnv(),
  stdio: ["ignore", "pipe", "pipe"],
});
```

3. Parse `verificationUrl` and `userCode` from stdout/stderr
4. Return both to the UI
5. Frontend auto-opens the URL and keeps polling `GET /api/provider-auth/openai`
6. Auth is complete once `~/.codex/auth.json` exists and the child exits cleanly

Useful extraction patterns:

```ts
const url = text.match(/https:\/\/(?:auth\.openai\.com|chatgpt\.com)[^\s]+/);
const code = text.match(/\b([A-Z0-9]{4}-[A-Z0-9]{5}|[A-Z0-9]{4}-[A-Z0-9]{4}|[A-Z0-9]{9})\b/);
```

## Part 6 - Detection and status

Ground truth is the filesystem:

```ts
await pathExists(join(home, ".claude", ".credentials.json"));
await pathExists(join(home, ".codex", "auth.json"));
```

Optional richer Claude snapshot:

```ts
spawnSync("claude", ["auth", "status", "--json"], {
  cwd: getAgentHomeDir(),
  encoding: "utf8",
  env: buildAnthropicAuthEnv(),
  timeout: 5000,
});
```

Use a combined status endpoint for the onboarding page:

```ts
GET /api/provider-auth/status
-> {
  anthropic: { detected, session },
  openai: { detected, session },
  setupPhase
}
```

## Part 7 - Frontend behavior

Claude card:

- click `Connect Claude Code`
- open returned `verificationUrl` in a new tab
- show a text input for callback paste
- submit to `/api/provider-auth/anthropic/submit`

Codex card:

- click `Connect Codex`
- open returned `verificationUrl` automatically
- show `userCode`
- poll until complete

Both cards should:

- treat server state as source of truth
- allow cancel
- show exact error text from the server

## Part 8 - Failure cases that matter

- Claude installer may finish without placing `claude` on PATH. Always include the npm fallback install.
- If `claude auth login` returns success but no credentials file exists, treat that as failure.
- If you change the app user's home after bootstrap, auth will appear broken because the files are in the wrong home.
- Do not cache auth state in the database.
- Keep one in-flight auth session per provider. Multiple overlapping sessions create confusing browser callbacks and leaked subprocesses.

## Part 9 - Replication checklist

- [ ] Bootstrap installs Claude and Codex before onboarding begins
- [ ] App user home contains `.claude`, `.codex`, `.claude.json`, `.claude/.claude.json`
- [ ] systemd exports `HOME`, `USERPROFILE`, `PATH`, `CLAUDE_CONFIG_DIR`, `CLAUDE_CREDENTIALS_PATH`, `CODEX_HOME`
- [ ] Claude onboarding uses PKCE plus refresh-token install, not a PTY paste flow
- [ ] Codex onboarding uses `codex login --device-auth`
- [ ] Auth detection reads the real credential files
- [ ] Frontend auto-opens the provider URL and reflects server session state
