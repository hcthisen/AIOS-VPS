# AIOS-VPS — Build & Implementation Plan

Living tracker for the AIOS build. Update as work progresses; keep the **Current phase** header accurate.

**Legend:** `[ ]` pending · `[~]` in progress · `[x]` done

**Current phase:** Phase 0 — Bootstrap installer

**Guiding docs:**
- [`AIOS-PRD.md`](./AIOS-PRD.md) — what we're building
- [`onboarding-caddy.md`](./onboarding-caddy.md) — Caddy install + domain/HTTPS onboarding recipe
- [`onboarding-cli-auth.md`](./onboarding-cli-auth.md) — Claude Code + Codex install + auth onboarding recipe

---

## Why these phases

Caddy and the CLI auth recipes only work if bootstrap and onboarding cooperate:
- The bootstrap phase must install Caddy **stopped**, seed sudoers, and install both CLIs as the `aios` user with the right PATH.
- The onboarding phases must then write the Caddyfile, start Caddy, run `claude auth login` / `codex login --device-auth`, and confirm success by **file existence**, not DB flags.
- The execution engine must reuse the exact same env (HOME, PATH, CLAUDE_CONFIG_DIR, CODEX_HOME) or spawned agents lose their auth.

Each phase below has an **acceptance gate** that forces the integration to actually work, not just exist as code.

---

## Phase 0 — Bootstrap installer

**Goal:** a single idempotent script turns a fresh Ubuntu/Debian VPS into an AIOS-ready host.

- [ ] `scripts/vps-bootstrap.sh` scaffold, idempotent, re-run safe
- [ ] Install Node.js LTS, git, build-essentials, curl
- [ ] Create app user `aios` with home `/home/aios`
- [ ] **Caddy install** (ref: `onboarding-caddy.md` §1)
  - [ ] Install Caddy from Cloudsmith APT source
  - [ ] `systemctl stop caddy` and `systemctl disable caddy`
  - [ ] `chown aios:aios /etc/caddy/Caddyfile`
  - [ ] Drop `/etc/caddy/Caddyfile.template` for reference
  - [ ] Sudoers rule: `aios` NOPASSWD for `systemctl enable/start/reload caddy` and `systemctl restart aios`
- [ ] **CLI install** (ref: `onboarding-cli-auth.md` §1)
  - [ ] `sudo -u aios curl -fsSL https://claude.ai/install.sh | bash`
  - [ ] `npm install --global @openai/codex@latest`
  - [ ] Pre-create `/home/aios/.claude/` and `/home/aios/.codex/`
  - [ ] Seed empty `/home/aios/.claude.json` (legacy fallback)
  - [ ] Add `~/.local/bin` to front of `/home/aios/.bashrc` PATH
- [ ] systemd unit `aios.service`
  - [ ] `User=aios`, `WorkingDirectory=/opt/aios`
  - [ ] Env: `HOME=/home/aios`, `USERPROFILE=/home/aios`, `PATH=/home/aios/.local/bin:/usr/local/bin:/usr/bin:/bin`
  - [ ] `Restart=on-failure`
- [ ] Firewall: open TCP 80, 443, 3100
- [ ] Re-run safety: detect existing Caddyfile / credentials / user and preserve them

**Acceptance:** fresh VPS → run script → `systemctl status aios` shows server on `:3100`; `sudo -u aios which claude` and `which codex` both resolve; Caddy is installed but not running.

---

## Phase 1 — Dashboard server skeleton

**Goal:** Node server binds `0.0.0.0:3100`, first-admin signup, session auth, setup-phase state machine.

- [ ] `server/` init (TypeScript)
- [ ] Config module exposes `auth.publicBaseUrl`, port, data dir
- [ ] First-admin bootstrap: unauthenticated POST creates admin; thereafter requires login
- [ ] Session middleware + CSRF + auth guard for `/api/*`
- [ ] `GET /api/health`
- [ ] Persistent `setupPhase` state machine: `admin_setup → domain_setup → provider_setup → github_setup → repo_setup → notifications → complete`
- [ ] UI shell (`ui/`) with routing skeleton

**Acceptance:** visit `http://<ip>:3100` → create admin → land on the `domain_setup` step.

---

## Phase 2 — Onboarding: domain + HTTPS (Caddy wired in)

**Goal:** admin attaches a domain, Caddy provisions HTTPS, dashboard restarts into HTTPS. Implements [`onboarding-caddy.md`](./onboarding-caddy.md) end-to-end.

- [ ] `server/src/routes/vps-setup.ts`
- [ ] `GET /api/vps/network-info` — returns public IP + port for DNS instructions
- [ ] `POST /api/vps/verify-dns` — resolves A record, compares to server IP, returns mismatch details
- [ ] `POST /api/vps/configure-domain`
  - [ ] Write `/etc/caddy/Caddyfile` from template (reverse proxy → `localhost:3100`)
  - [ ] `sudo systemctl enable caddy` + `sudo systemctl start caddy`
  - [ ] Wait ~3s for ACME cert issuance
  - [ ] `sudo systemctl reload caddy` to pick up certs
  - [ ] Update `auth.publicBaseUrl = https://<domain>`
  - [ ] Schedule self-restart via `res.on("finish")` with ~250ms delay
  - [ ] Idempotent on re-run with same domain
- [ ] `GET /api/vps/domain-readiness?domain=` — polls HTTPS health endpoint
- [ ] `POST /api/vps/skip-domain` — escape hatch to stay on raw IP
- [ ] `ui/src/pages/VpsDomainSetup.tsx`
  - [ ] Show DNS instructions with server IP
  - [ ] Verify button wires to `/verify-dns`, shows ✅/❌ with resolved IPs
  - [ ] Configure button wires to `/configure-domain`
  - [ ] Poll `/domain-readiness` every 3s, then `window.location.href` to HTTPS URL

**Acceptance:** enter `foo.example.com` with matching A record → click Configure → browser redirected to `https://foo.example.com` with valid cert; `setupPhase` advanced to `provider_setup`.

---

## Phase 3 — Onboarding: provider auth (Claude Code + Codex wired in)

**Goal:** admin authenticates Claude Code and/or Codex; credentials land on disk. Implements [`onboarding-cli-auth.md`](./onboarding-cli-auth.md) end-to-end.

- [ ] `server/src/services/provider-auth.ts`
  - [ ] `buildCommonAuthEnv()` — HOME, PATH (with `~/.local/bin` first), `FORCE_COLOR=0`, `NO_COLOR=1`, `TERM=dumb`
  - [ ] `buildAnthropicAuthEnv()` — adds `CLAUDE_CONFIG_DIR`, `CLAUDE_CREDENTIALS_PATH`
  - [ ] `buildOpenAiAuthEnv()` — adds `CODEX_HOME`
  - [ ] Module-scoped singletons: one Anthropic session + one OpenAI session at a time
- [ ] `server/src/routes/provider-auth.ts`
- [ ] **Claude Code OAuth PKCE** (ref: `onboarding-cli-auth.md` §3)
  - [ ] Constants: `ANTHROPIC_OAUTH_AUTHORIZE_URL`, `ANTHROPIC_OAUTH_TOKEN_URL`, `ANTHROPIC_OAUTH_CLIENT_ID = 9d1c250a-e61b-44d9-88ed-5944d1962f5e`, scopes
  - [ ] `POST /api/provider-auth/anthropic/start` — generate PKCE verifier + state, return authorize URL + session id
  - [ ] `POST /api/provider-auth/anthropic/submit` — split `code#state`, exchange for refresh token, invoke `claude auth login` with `CLAUDE_CODE_OAUTH_REFRESH_TOKEN` env
  - [ ] `POST /api/provider-auth/anthropic/cancel`
  - [ ] `GET /api/provider-auth/anthropic` — current session state
  - [ ] Completion gate: `/home/aios/.claude/.credentials.json` exists
  - [ ] Redact refresh tokens from all logs
- [ ] **Codex device-auth** (ref: `onboarding-cli-auth.md` §4)
  - [ ] `POST /api/provider-auth/openai/start` — spawn `codex login --device-auth`, strip ANSI from stdout, parse verification URL + user code
  - [ ] `GET /api/provider-auth/openai` — poll; `complete` only when `/home/aios/.codex/auth.json` exists **and** child has exited cleanly
  - [ ] `POST /api/provider-auth/openai/cancel` — SIGTERM the child, don't just drop the session object
  - [ ] 15-minute TTL auto-cancel
- [ ] `ui/src/pages/ProviderAuth.tsx` at `/setup/providers`
  - [ ] Two cards (Claude Code, Codex) with states `idle → waiting → complete | failed | canceled`
  - [ ] Claude card: opens verify URL in new tab, paste-code input, submit
  - [ ] Codex card: displays big monospaced user code + clickable URL, polls every ~2s
  - [ ] Skip link advances `setupPhase`

**Acceptance:** click Connect on each card, complete browser flow → `/home/aios/.claude/.credentials.json` and `/home/aios/.codex/auth.json` both present → both cards show Complete → `setupPhase` advanced.

---

## Phase 4 — Onboarding: GitHub + repo + notifications

**Goal:** finish the remaining onboarding steps from the PRD.

- [ ] GitHub OAuth app or deploy-key flow
- [ ] Repo picker UI
  - [ ] Create new: scaffold with `aios.yaml`, root `org.md`, sample department folder
  - [ ] Attach existing: validate `aios.yaml` present
- [ ] Clone repo to `/home/aios/repo`
- [ ] Notification channel setup
  - [ ] Telegram bot token + chat id, OR SMTP creds
  - [ ] Test-send button
- [ ] Mark `setupPhase = complete`

**Acceptance:** repo cloned on disk, `aios.yaml` parsed, test notification delivered.

---

## Phase 5 — Heartbeat scanner

**Goal:** every-minute loop pulls repo, discovers triggers, enqueues runs.

- [ ] Heartbeat loop (systemd timer or in-process interval)
- [ ] `git pull` on repo with error surfacing
- [ ] Parse `cron/*.md` frontmatter for cron schedules
- [ ] Parse `goals/*.md` for active goals
- [ ] Inbound webhook handler + delivery log
- [ ] Enqueue triggers into per-department backlog

**Acceptance:** push a `cron/*.md` with `schedule: "* * * * *"` → within one heartbeat cycle, run appears in logs.

---

## Phase 6 — Execution engine

**Goal:** spawn provider subprocess per run, serialize per department, parallelize across departments.

- [ ] Per-folder claim lock (timestamped file + timeout, default 6h)
- [ ] Per-dept backlog queue, FIFO
- [ ] Agent subprocess spawner — **reuses env builders from Phase 3** so auth is inherited
- [ ] Stream stdout/stderr to `logs/`
- [ ] After successful run: commit changes and `git push`
- [ ] Kill switch: per-run SIGTERM + global pause
- [ ] Provider selection: per-task override, falling back to system default

**Acceptance:** two departments run concurrently; same department serializes; agent inherits auth without any re-login.

---

## Phase 7 — Sync layer

**Goal:** keep context and org files consistent across folders.

- [ ] Mirror `CLAUDE.md ↔ AGENTS.md` in every department folder
- [ ] Copy root `org.md` into every folder on change
- [ ] Regenerate `_org.md` (list of departments) in every folder
- [ ] Sync `skills/` to provider-specific skill directories
- [ ] Trigger: after pull, after user edit, manual button

**Acceptance:** add a new department folder → after next sync, it appears in every folder's `_org.md`.

---

## Phase 8 — Dashboard UI

**Goal:** full operator surface described in the PRD.

- [ ] Live overview: active claims + real-time streaming output
- [ ] Master run log + per-department run logs
- [ ] Department list + detail views
- [ ] Editors: env vars, cron tasks, goals
- [ ] Backlog viewer, manual prompt box
- [ ] Webhook delivery log
- [ ] Usage / cost tracking view
- [ ] Embedded terminal to the VPS
- [ ] Pause/resume per cron task; kill switch per run and globally

**Acceptance:** a non-technical operator can create a cron task from the UI and watch it run to completion.

---

## Phase 9 — Hardening + docs polish

**Goal:** hit the PRD success criteria and ship.

- [ ] End-to-end deploy rehearsal on a fresh VPS (target: <15 min to first scheduled task)
- [ ] Target: first real task running within 1 hour of deploy
- [ ] Backup + restore flow for `/home/aios/repo` and state dir
- [ ] Refresh-token rotation verified (Claude Code) + device-auth re-auth path
- [ ] Re-bootstrap on existing host preserves Caddyfile, credentials, repo
- [ ] README + onboarding docs reviewed against shipped behaviour

**Acceptance:** PRD success criteria met; unattended run survives at least a week in a pilot.

---

## Integration guarantees (why this plan won't produce dead recipes)

1. **Phase 0 is a hard prerequisite for Phase 2 and Phase 3.** If Caddy isn't installed-stopped, if sudoers isn't scoped, if `~/.local/bin` isn't on the `aios` user's PATH, or if the systemd unit doesn't export `HOME` and `PATH`, the onboarding endpoints fail. Phase 0 acceptance explicitly checks each of these.
2. **Phase 2 acceptance is HTTPS working end-to-end**, not just files written — so the Caddy pipeline is validated live.
3. **Phase 3 acceptance is credential files existing**, per `onboarding-cli-auth.md`'s "detect by file existence" principle — no brittle DB flags.
4. **Phase 6 explicitly reuses the env builders from Phase 3**, so agent subprocesses inherit the same HOME / PATH / `CLAUDE_CONFIG_DIR` / `CODEX_HOME` that authenticated the CLIs. No path drift, no silent "claude not installed" at runtime.
