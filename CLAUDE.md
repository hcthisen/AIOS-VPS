# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with this repository.

## Repo status

AIOS-VPS is implemented as a TypeScript backend, a Vite/React dashboard, and VPS lifecycle scripts:

```
/scripts   install, bootstrap, deploy, backup/restore, and system-update scripts
/server    Node.js/TypeScript dashboard API, heartbeat, sync, claims, execution engine
/ui        React + TypeScript dashboard
```

The product docs are `AIOS-PRD.md`, `README.md`, `DEPLOY.md`, `onboarding-caddy.md`, and `onboarding-cli-auth.md`.

## Build, test, and development commands

- `cd server && npm install && npm run dev` starts the backend on `http://localhost:3100`.
- `cd ui && npm install && npm run dev` starts the dashboard on `http://localhost:5173` and proxies `/api` and `/webhooks`.
- `cd server && npm run build` compiles backend TypeScript to `server/dist`.
- `cd ui && npm run build` compiles TypeScript and creates `ui/dist`.
- `cd server && npm run build && npm test` runs the Node test suite against `dist/routes/*.test.js` and `dist/services/*.test.js`.
- `bash scripts/deploy-app.sh` builds and installs both apps into `/opt/aios`; use it on the target VPS with root access.

## Orientation for a new task

1. Read the code before changing behavior. Backend routes live in `server/src/routes`, domain logic in `server/src/services`, and shared runtime modules at `server/src/*.ts`.
2. If the task touches VPS install, HTTPS, or domain setup, use `onboarding-caddy.md`, `scripts/vps-bootstrap.sh`, `server/src/routes/vps-setup.ts`, and `server/src/services/caddy.ts` as the reference.
3. If the task touches Claude Code or Codex auth, use `onboarding-cli-auth.md`, `server/src/services/provider-auth.ts`, and `server/src/routes/provider-auth.ts` as the reference.
4. If the task changes onboarding, auth, execution, repo sync, notifications, storage, or deployment behavior, update the matching docs in the same change.

## Architectural invariants

- **The repo is the product.** Context, cron tasks, goals, skills, webhook handlers, outbox notifications, env templates, and generated shared context live in the operator's monorepo. Run logs, claims, webhook deliveries, usage metrics, sessions, and credentials are operational state outside the repo.
- **Root and department scopes are file-backed.** The root scope is `_root`; department scopes are listed in `aios.yaml`. Both can have `CLAUDE.md` / `AGENTS.md`, `cron/`, `goals/`, `skills/`, `webhooks/`, `outbox/`, and `logs/`.
- **Agents are stateless and folder-scoped by convention.** Claude Code or Codex starts in the target folder and becomes whatever that folder's files define. Cron tasks and goals require `provider: claude-code` or `provider: codex`.
- **Concurrency uses claims.** Serialize runs within one claimed scope and allow different scopes to run in parallel. Backlog entries wait for the claimed scope to release.
- **Detect provider auth by file existence.** `~/.claude/.credentials.json` / `~/.claude.json` and `~/.codex/auth.json` are the ground truth. Re-check on render; do not cache auth in the database.
- **Keep one provider auth session in flight per provider.** Reject duplicate `/start` calls and SIGTERM Codex device-auth children on cancellation.
- **Caddy is installed stopped while unconfigured.** The dashboard writes the managed `/etc/caddy/Caddyfile` and enables/starts/reloads Caddy only after domain setup or managed public storage host setup requires it.
- **Self-restart the server after `res.on("finish")`.** Domain configuration must flush the HTTP response before restarting `aios`.
- **Env contract must remain consistent.** systemd, provider auth, execution, and Git helpers must agree on `HOME`, `USERPROFILE`, `PATH`, `CLAUDE_CONFIG_DIR`, `CLAUDE_CREDENTIALS_PATH`, and `CODEX_HOME`.
- **Sudoers is narrow.** `aios` is NOPASSWD only for the specific Caddy/systemd commands and `/usr/local/bin/aios-system-update`.
- **Sync commits as `aios: sync`.** Sync mirrors `CLAUDE.md` and `AGENTS.md`, copies root `org.md`, regenerates `_org.md`, mirrors `skills/`, refreshes default automation skills, and applies managed outbox instructions.
- **Setup phase is persistent.** `admin_setup -> domain_setup -> provider_setup -> github_setup -> repo_setup -> context_setup -> notifications -> complete`. `/api/health` and `/api/auth/me` expose the current phase.

## Key constants

- Anthropic OAuth client ID: `9d1c250a-e61b-44d9-88ed-5944d1962f5e`
- Anthropic authorize URL: `https://claude.ai/oauth/authorize`
- Anthropic token URL: `https://platform.claude.com/v1/oauth/token`
- Anthropic manual redirect URL: `https://platform.claude.com/oauth/code/callback`
- Scopes: `org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload`
- Dashboard port: `3100` (firewall opens 80, 443, 3100)
- App user: `aios`; app home: `/home/aios`; install dir: `/opt/aios`; repo clone: `/home/aios/repo`
- Claim timeout default: 6 hours
- Codex device-auth TTL ceiling: 15 minutes
- System update source checkout: `/var/lib/aios/system-src`
