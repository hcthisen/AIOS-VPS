# AIOS - Product Requirements Document

## Overview

AIOS is a self-hosted execution layer that turns one or more GitHub monorepos into autonomous operating workspaces. A single VPS can manage multiple company repos from the same GitHub account. It runs Claude Code or Codex CLI agents against the active company's repo root or department folders on schedules, webhooks, Telegram messages, or manual dashboard prompts.

Each company repo remains the source of truth for operating context and agent work: `aios.yaml`, `CLAUDE.md`, `AGENTS.md`, `org.md`, `cron/`, `goals/`, `skills/`, `webhooks/`, `.env`, and `outbox/` define what that company does. The dashboard visualizes and edits those files, while SQLite and filesystem logs hold operational state such as companies, users, sessions, claims, runs, webhook deliveries, usage, notifications, setup state, and credentials metadata.

## Target User

AIOS is for solo operators, small teams, and agencies that want autonomous repository-backed operations without building a custom scheduler, claim system, GitHub sync loop, CLI auth flow, or dashboard for every business function.

The operator is expected to understand GitHub, VPS deployment, provider CLI subscriptions, and basic markdown/YAML configuration.

## Core Principles

- **Repo is the product.** Work definitions and shared operating context live in the monorepo.
- **Company isolation is repo-backed.** Each company maps to one GitHub repo/worktree and has separate runs, claims, backlog, webhooks, usage, notifications, and Telegram Root Agent state.
- **Dashboard is an interface, not the authority.** Dashboard edits commit back to the repo where appropriate.
- **Scopes are folders.** `_root` represents the repo root; department scopes are top-level folders listed in `aios.yaml`.
- **Agents are interchangeable.** Cron tasks, goals, manual prompts, webhooks, and Telegram turns can run through Claude Code or Codex when that provider is authorized.
- **Concurrency is claim-based.** Runs serialize within a claimed scope and can run in parallel across different scopes.

## External Systems

AIOS connects to:

- **GitHub** for the operator company repos. AIOS uses one GitHub PAT; every connected company repo must be accessible from that account. AIOS pulls before work, commits changes, pushes after successful runs, polls remotes every 60 seconds, and creates/updates GitHub push webhooks when connected with a PAT that has enough permission.
- **Claude Code CLI** through OAuth PKCE plus `claude auth login`.
- **OpenAI Codex CLI** through `codex login --device-auth`.
- **Telegram or SMTP email** for owner notifications.
- **Telegram Bot API** for optional inbound Root Agent chat.
- **S3-compatible object storage** per department, configured through `.env` keys and surfaced in the dashboard file browser.
- **Caddy** for HTTPS and managed public host routing.

PAT mode is the supported onboarding path for creating or attaching a GitHub repo and installing the push webhook. Deploy-key credential entry exists in the UI/settings, but it does not create/list repos or install webhooks.

## Deployment and Onboarding

The one-command installer is:

```bash
curl -fsSL https://raw.githubusercontent.com/hcthisen/AIOS-VPS/main/scripts/install.sh | sudo bash
```

It clones or refreshes the AIOS-VPS source under `/var/lib/aios/system-src`, runs bootstrap, builds server and UI, deploys to `/opt/aios`, writes the systemd unit, and starts `aios` on port `3100`.

Bootstrap installs base packages, Node.js, Git, Caddy, AWS CLI, Claude Code, Codex, and narrow sudoers for Caddy, AIOS restart, and the self-update wrapper. Caddy is installed with a placeholder config and kept disabled until domain setup.

On first visit to `http://<vps-ip>:3100`, the operator creates the first admin account. Signup is disabled after that first user. The setup phase sequence is:

1. `admin_setup` - create the first admin.
2. `domain_setup` - verify DNS, write managed Caddy config, enable HTTPS, or skip domain setup.
3. `provider_setup` - authorize Claude Code and/or Codex, or skip and connect later.
4. `github_setup` - connect GitHub, normally with a PAT.
5. `repo_setup` - create a new repo with AIOS scaffolding or attach an existing repo with root `aios.yaml`.
6. `context_setup` - write root `org.md`, `CLAUDE.md`, and `AGENTS.md` from shared organization/deployment context.
7. `notifications` - configure Telegram, email, or none.
8. `complete` - heartbeat starts doing work.

After onboarding, the first repo is the default company. The sidebar company switcher can add more companies by selecting an unused repo from the already-connected GitHub account, writing company context, and configuring that company's Telegram/email notifications. Settings can re-authorize providers, reconnect GitHub, update active-company notifications, configure the active-company Telegram Root Agent, and run system updates.

## Repo Manifest

Every AIOS-managed repo contains a root `aios.yaml`. The current implementation supports:

```yaml
version: 1
rootName: Root
departments:
  - sample
ignored:
  - node_modules
  - .git
  - dashboard
```

`departments` controls which top-level folders appear as department scopes. Missing department folders are pruned from `aios.yaml` during sync when they have no tracked or pending repo content. `rootName` controls the display name for `_root`.

The parser also tolerates simple `mirrors` metadata, but external subfolder mirroring is not implemented.

## Scope Structure

The root scope and each department can contain:

- `CLAUDE.md` and `AGENTS.md` - provider-neutral agent instructions, kept in sync.
- `org.md` - root-authored organization/deployment context copied into departments.
- `_org.md` - auto-generated map of sibling departments.
- `cron/*.md` - scheduled prompts with YAML frontmatter.
- `goals/*.md` - long-running goals with status, schedule, provider, and state.
- `skills/<name>/SKILL.md` - reusable local procedures mirrored into provider-specific skill folders.
- `webhooks/*.md` - webhook handler prompts.
- `.env` - environment variables and department storage credentials.
- `outbox/*.md` - owner-facing notification requests written by agents.
- `logs/` - optional repo-local logs or artifacts.

New departments are created from the dashboard by adding the folder, updating `aios.yaml`, creating provider context files, and scaffolding automation folders.

## Scheduled Tasks

Scheduled tasks live in `cron/*.md` and require frontmatter like:

```md
---
schedule: "0 * * * *"
provider: claude-code
paused: false
---

Do the scheduled work.
```

The dashboard can create, edit, pause, resume, and delete cron tasks. The backend validates that `provider` is `claude-code` or `codex` and that the selected provider is authorized before saving cron or goal files through the dashboard.

The heartbeat checks due cron tasks roughly once per minute after setup is complete.

## Goals

Goals live in `goals/*.md` and require frontmatter like:

```md
---
status: active
schedule: "0 9 * * *"
provider: codex
state: {}
---

Advance this objective by taking the next smallest useful step.
```

Goals are not evaluated continuously. The heartbeat scans goals every tick, but a goal only starts when its own schedule is due. Active goals with wake intervals below 10 minutes are skipped to avoid runaway backlog and budget waste. Agents are instructed to update the goal file state, pause goals that should stop, and mark goals complete when done.

## Webhooks

A webhook handler is a markdown file at:

```txt
<department>/webhooks/<name>.md
```

Public POSTs to `/webhooks/<company>/<department>/<name>` load that file from the named company, append the JSON payload to the prompt, and start a run in the target department. The legacy `/webhooks/<department>/<name>` route targets the default company. Optional frontmatter keys `webhookKey`, `webhookSecret`, `key`, or `secret` require the caller to provide a matching `x-webhook-key`, `x-webhook-secret`, `?key=`, or `?secret=`.

Webhook deliveries are recorded in SQLite and shown in the Webhooks dashboard. Current webhook execution uses provider selection fallback from the execution engine rather than a webhook-specific provider picker.

## Manual Runs and Telegram Root Agent

The Manual Run dashboard page lets an admin choose a scope, enter a prompt, optionally select a provider, and start a run through the same claim/execution path as scheduled work.

The optional Telegram Root Agent converts approved Telegram messages into root-scope conversation turns using the configured provider. Provider session IDs are tracked so a Telegram conversation can continue until reset.

There is no separate local CLI for manual runs in this repository.

## Execution Model

The heartbeat:

1. Iterates every fully configured company.
2. Checks whether onboarding is complete, company pause is off, and no system update is blocking work.
3. Checks that company's GitHub remote for changes and syncs when needed.
4. Runs the sync layer when that company worktree is not blocked by active runs.
5. Processes owner notification outbox files and notification retries.
6. Scans cron tasks and scheduled goals.
7. Starts or queues candidate runs based on company-scoped claims.

Each run:

1. Syncs the repo with remote before starting.
2. Claims the requested scope or queues into backlog if busy.
3. Spawns Claude Code or Codex in the root or department folder.
4. Streams output to run logs and dashboard events.
5. On success, processes outbox notifications, runs sync without committing, commits repo changes as `aios: run <id> (<trigger>)`, and pushes.
6. Records basic token/cost usage when the provider output exposes parseable values.
7. Releases claims and dispatches backlog entries.

Codex sandbox mode defaults to `danger-full-access` and can be changed with `AIOS_CODEX_SANDBOX`.

## Claims and Backlog

Claims are stored in SQLite with a six-hour default timeout and are scoped by company. A claimed scope rejects simultaneous work inside that company; new triggers for that scope go into the backlog unless a caller explicitly disables queueing. Different scopes and different companies can run at the same time.

The execution engine accepts multi-scope run requests internally, but the current dashboard and file-based trigger flows primarily create single-scope runs.

## GitHub Sync

AIOS uses a queued Git sync path to avoid concurrent Git operations. It fetches, rebases against the upstream branch, stashes local changes when needed, pushes when ahead, and records sync status for the dashboard.

If conflicts occur, AIOS can attempt provider-assisted conflict resolution for small non-secret text files when an authorized provider is available. If resolution is not possible, it can reset to remote and notify the operator when configured.

Dashboard file edits, department creation, cron/goal changes, storage instruction changes, and successful runs create commits. Pull-request mode is not implemented.

## System-Managed Sync Layer

The sync layer runs after successful pulls, after successful agent runs, and when triggered manually from the dashboard. It:

- Mirrors `CLAUDE.md` and `AGENTS.md` in the repo root and every department.
- Ensures standard automation folders and default skills exist.
- Applies managed owner-notification instructions into provider context files.
- Copies root `org.md` into each department.
- Regenerates `_org.md`.
- Mirrors `skills/` into `.claude/skills/` and `.codex/skills/`.
- Ensures a root README exists for newly scaffolded AIOS repos.

When sync commits directly, it uses `aios: sync`.

## Dashboard

The dashboard includes:

- First-admin auth and setup wizard.
- Company switcher and add-company wizard.
- Overview with active work, controls, and owner notifications.
- Runs list and per-run log/detail views with live streaming.
- Departments list and department detail views.
- Root and department task, goal, file, environment, run, backlog, and storage views.
- Manual run form.
- Backlog view.
- Webhook handler and delivery views.
- Usage view.
- Embedded VPS terminal.
- Settings for providers, GitHub, notifications, Telegram Root Agent, and system updates.

## Notifications

The operator can configure Telegram, SMTP email, or no external notification channel per company. Agents do not call those services directly; they write markdown files into `outbox/`. AIOS stores owner notifications in SQLite, deletes processed outbox files, shows notifications in the dashboard, and attempts delivery through the active company's configured channel.

Outbox notifications support title, priority, tags, body, read/unread state, retry, delivery attempts, and last-error tracking.

## Storage

Each scope can configure S3-compatible storage through dashboard UI. Storage credentials are serialized into that scope's `.env` using `AIOS_STORAGE_*` keys. AIOS can:

- Probe credentials before saving.
- List public/private prefixes.
- Upload and delete objects.
- Generate signed URLs.
- Use Caddy-managed public host routing when a public storage hostname resolves to the VPS.
- Add or reset managed storage instructions in `CLAUDE.md` and `AGENTS.md`.

## System Updates

Settings can check and apply updates from the configured AIOS-VPS repository and branch. Updates run through `/usr/local/bin/aios-system-update`, refresh the source checkout, rebuild/deploy, write status/version files, and restart AIOS. Updates are blocked while active agent processes are running.

## In Scope for the Current Implementation

- Multi-company deployment with first-admin signup and one GitHub PAT.
- Ubuntu/Debian VPS bootstrap and one-command install.
- Caddy-managed HTTPS onboarding.
- Claude Code and Codex CLI authorization.
- PAT-based GitHub onboarding with create/attach repo and push webhook fallback to polling.
- Root and department scopes from `aios.yaml`.
- Cron tasks, scheduled goals, manual runs, public webhooks, and Telegram Root Agent turns.
- Claim/backlog execution control.
- Repo sync, system sync layer, run commits, and dashboard file edits.
- Owner notification outbox with Telegram/email delivery.
- S3-compatible department storage.
- Embedded terminal, usage view, kill switches, global pause, and self-update.
- Backend tests for core route/service behavior.

## Explicitly Out of Scope Right Now

- Multi-user administration beyond the first admin account.
- GitHub OAuth app onboarding.
- Pull-request-based run commits.
- External subfolder mirror automation.
- A separate local CLI for manual AIOS runs.
- Hard filesystem isolation restricting an agent to its starting folder.
- Docker-based deployment; bootstrap uses systemd, Node.js, Caddy, Git, and provider CLIs directly.

## Success Criteria

- A fresh VPS can be deployed with one command and completed through onboarding without SSH edits after install.
- An operator can create or attach a repo, configure at least one provider, and see scheduled work execute through the dashboard.
- Dashboard edits to tasks, goals, context, environment, storage, and department structure are reflected in repo files and committed when appropriate.
- Active runs stream to the UI, can be killed, and release claims/backlog correctly.
- The same repo remains understandable and editable outside AIOS because the operating model is stored in files.
