# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repo status

Pre-code. The tree contains only specs (`AIOS-PRD.md`), a phased build tracker (`PLAN.md`), two implementation recipes (`onboarding-caddy.md`, `onboarding-cli-auth.md`), and `README.md`. There is no `package.json`, no `scripts/`, no `server/`, no `ui/` yet — so there are no build/lint/test commands to run. New work starts by picking up the **Current phase** in `PLAN.md`.

Planned layout (do not invent deviations without updating the PRD):

```
/scripts   bootstrap scripts (vps-bootstrap.sh), systemd units
/server    Node.js/TypeScript dashboard server + heartbeat + execution engine
/ui        React + TypeScript dashboard
```

## Orientation for a new task

1. Read `PLAN.md` — the **Current phase** header is authoritative for what to build next. Check the boxes in that phase and stop at its **Acceptance** gate; don't leapfrog into later phases.
2. If the task touches the VPS install / HTTPS / domain path, `onboarding-caddy.md` is the reference implementation — match its endpoints, env expectations, and gotchas exactly.
3. If the task touches Claude Code or Codex auth, `onboarding-cli-auth.md` is the reference — match its constants (client ID, URLs, scopes), credential paths, and env-builder structure exactly.
4. `AIOS-PRD.md` is the product spec; use it for intent questions ("should goals persist state?"), not for implementation details.

## Architectural invariants (the "why this won't produce dead recipes" contract)

These cut across phases. Breaking one silently breaks a later phase.

- **The repo is the product.** State — context, cron tasks, goals, env templates — lives as files in the operator's monorepo. The dashboard is a view over files; it is not the source of truth. Run logs, claims, webhook deliveries, and usage metrics are the only operational data that may live outside the repo.
- **Agents are stateless and folder-scoped by convention.** A top-level folder with a `CLAUDE.md` is a "department." The same agent binary (Claude Code or Codex) becomes whatever that folder's files describe. Provider selection is per-task.
- **Concurrency via claims, not isolation.** Serialize within one department folder; parallelize across folders. Multi-folder triggers must claim every required folder before running.
- **Detect auth by file existence, not DB flags.** `~/.claude/.credentials.json` and `~/.codex/auth.json` are the ground truth. Re-check on every render; don't cache.
- **One Anthropic auth session + one OpenAI auth session at a time, module-scoped.** Reject `/start` while a session is live or you leak `codex` subprocesses.
- **Caddy is installed stopped.** Bootstrap installs Caddy but leaves it disabled; the dashboard's `configure-domain` endpoint writes the Caddyfile and brings Caddy up. Dashboard serves directly on `:3100` until then.
- **Self-restart the server *after* `res.on("finish")`.** The `configure-domain` response must flush before `systemctl restart` fires, or the browser hangs.
- **Env contract must match across phases.** The systemd unit, the Phase 3 auth env builders, and the Phase 6 execution-engine spawner must all export the same `HOME`, `USERPROFILE`, and `PATH` (with `~/.local/bin` first), plus `CLAUDE_CONFIG_DIR` / `CLAUDE_CREDENTIALS_PATH` for Anthropic and `CODEX_HOME` for OpenAI. Phase 6 **reuses** the Phase 3 builders — do not fork them.
- **Sudoers is narrow.** `aios` user is NOPASSWD only for `systemctl enable/start/reload caddy` and `systemctl restart aios`. No wildcards.
- **Parse Codex device-auth stdout with ANSI stripped.** Spawn with `TERM=dumb`, `NO_COLOR=1`, `FORCE_COLOR=0`, and still run `stripAnsi` before regexing for the verification URL and `XXXX-XXXX` user code.
- **Redact refresh tokens.** Never log `CLAUDE_CODE_OAUTH_REFRESH_TOKEN` or the raw token-exchange response.
- **Cancellation SIGTERMs the child.** Dropping the session object alone leaves `codex login` orphaned.
- **Bootstrap is re-run safe.** Detect existing Caddyfile / credentials / `aios` user and preserve them; do not clobber domain config on re-bootstrap.
- **Sync layer commits as `aios: sync`.** Keeps system-generated mirror churn (`CLAUDE.md ↔ AGENTS.md`, `org.md` propagation, regenerated `_org.md`) separable from operator edits in git history. Sync runs after every `git pull`, after any run that modified a synced source file, and on manual trigger.
- **Setup-phase state machine is persistent.** `admin_setup → domain_setup → provider_setup → github_setup → repo_setup → notifications → complete`. `/api/health` returns `{ status, setupPhase }` and the frontend uses it to route.

## Key constants (don't re-derive these)

- Anthropic OAuth client ID: `9d1c250a-e61b-44d9-88ed-5944d1962f5e`
- Anthropic authorize URL: `https://claude.ai/oauth/authorize`
- Anthropic token URL: `https://platform.claude.com/v1/oauth/token`
- Anthropic manual redirect URL: `https://platform.claude.com/oauth/code/callback`
- Scopes: `org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload`
- Dashboard port: `3100` (firewall must open 80, 443, 3100)
- App user: `aios`; app home: `/home/aios`; working dir: `/opt/aios`; repo clone: `/home/aios/repo`
- Claim timeout default: 6 hours
- Codex device-auth TTL ceiling: 15 minutes

## Branch discipline

Develop on the branch named in the session's task brief (e.g. `claude/init-project-setup-mmwC7`). Create it locally if it doesn't exist, commit with clear messages, and push to that branch only. Don't open a PR unless explicitly asked.
