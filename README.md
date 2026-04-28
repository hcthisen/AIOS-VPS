# AIOS — A repository-driven autonomous operating system for solo operators

Self-hosted platform that turns a single GitHub monorepo into an autonomous OS. Claude Code or Codex agents run on schedules, webhooks, or manual triggers across "departments" (top-level folders). All state and behaviour live in the repo; the dashboard is a visual interface, not a state holder.

## What is AIOS

- **Repo is the product.** Every task, goal, skill, and env var is a file in the monorepo.
- **Dashboard is a view.** It renders what's in the repo and lets you edit it; the repo remains source of truth.
- **Agents are stateless and interchangeable.** The same folder can run against Claude Code or Codex without code changes.
- **Concurrency via claims.** One department runs at a time; multiple departments run in parallel.

See [`AIOS-PRD.md`](./AIOS-PRD.md) for the full product specification.

## Features

- Scheduled (cron), webhook, and manual triggers
- Root and department execution scopes (`CLAUDE.md` / `AGENTS.md`, `cron/`, `goals/`, `skills/`, `.env`, `webhooks/`, `outbox/`, `logs/`)
- Per-folder claims with backlog queue
- Two-way GitHub sync (pull before run, commit + push after)
- GitHub push webhook registration when using a PAT, with 60-second polling fallback
- System-managed sync layer: `CLAUDE.md ↔ AGENTS.md`, `org.md` propagation, auto-generated `_org.md`
- Provider-neutral execution (Claude Code or Codex, selectable per task)
- Owner notification outbox with Telegram / email delivery
- Optional inbound Telegram Root Agent chat
- Per-department S3-compatible file storage with dashboard browsing and public URL support
- Self-update from Settings against the configured AIOS-VPS repo/branch
- Re-authorize providers, GitHub, and notifications from Settings after onboarding
- Embedded terminal, per-run and global kill switches
- Usage + cost tracking, live streaming output

## Tech stack

- **Backend:** Node.js (dashboard server, heartbeat scanner, execution engine)
- **Frontend:** React + TypeScript dashboard
- **Reverse proxy:** Caddy (auto-HTTPS via Let's Encrypt)
- **Process manager:** systemd
- **Execution providers:** Claude Code CLI, OpenAI Codex CLI
- **Source of truth:** GitHub
- **State:** filesystem (repo) + lightweight embedded store for claims, logs, metrics

## Architecture

```
Internet ──▶ Caddy (80/443) ──▶ aios server (:3100)
                                     │
                         ┌───────────┼────────────┐
                         ▼           ▼            ▼
                 heartbeat scanner  exec engine  dashboard API
                         │           │
                         └─── reads/writes ───▶ /home/aios/repo ──▶ GitHub
```

## Quickstart (VPS deploy)

See [`DEPLOY.md`](./DEPLOY.md) for the full walkthrough. The deployment command is intentionally one pasteable command:

1. **Provision** an Ubuntu/Debian VPS. Open TCP ports **80, 443, 3100**.
2. **Install and deploy**:
   ```bash
   curl -fsSL https://raw.githubusercontent.com/hcthisen/AIOS-VPS/main/scripts/install.sh | sudo bash
   ```
3. **Sign up** as first admin at `http://<vps-ip>:3100` and walk through the onboarding wizard:
   - attach a domain (Caddy auto-provisions HTTPS)
   - authenticate Claude Code and/or Codex (OAuth PKCE / device auth)
   - connect GitHub with a PAT, create or attach a repo
   - confirm shared organization context
   - configure notifications (Telegram or email)
4. **Later changes** live in `Settings`:
   - re-authorize Claude Code or Codex
   - reconnect GitHub
   - update notifications
   - apply future AIOS-VPS updates in place
5. **Done.** First scheduled task runs within one heartbeat cycle.

Target: fresh VPS to first scheduled run in under 15 minutes, first real task within an hour.

## Repository layout

```
/scripts     bootstrap scripts, systemd units
  install.sh             one-command VPS install + deploy
  vps-bootstrap.sh       idempotent VPS bootstrap (root)
  deploy-app.sh          build + rsync server & ui into /opt/aios
  backup-restore.sh      tar+restore repo, state, credentials, Caddyfile
/server      Node.js dashboard + heartbeat + execution engine (TypeScript)
/ui          React dashboard (TypeScript)
AIOS-PRD.md               product spec
onboarding-caddy.md       domain + HTTPS setup recipe
onboarding-cli-auth.md    Claude Code / Codex auth recipe
DEPLOY.md                 end-to-end deploy walkthrough
README.md                 this file
```

## Docs

- [`AIOS-PRD.md`](./AIOS-PRD.md) — full product specification
- [`DEPLOY.md`](./DEPLOY.md) — deploy walkthrough
- [`onboarding-caddy.md`](./onboarding-caddy.md) — domain attachment + automatic HTTPS
- [`onboarding-cli-auth.md`](./onboarding-cli-auth.md) — Claude Code + Codex CLI install and auth

## Status

The implementation is present under `server/`, `ui/`, and `scripts/`. See [`DEPLOY.md`](./DEPLOY.md) for deploying to a fresh VPS.

## License

TBD.
