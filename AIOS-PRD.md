\# AIOS — Product Requirements Document



\## Overview



AIOS is a self-hosted execution layer that turns a monorepo into an autonomous business operating system. It wraps a single GitHub repository, treats top-level folders as "departments," and runs Claude Code or Codex CLI agents inside those folders on schedules, webhooks, or manual triggers. Each department's behavior is defined entirely by the files inside it — `CLAUDE.md`, skills, env vars, scheduled tasks — making the repo itself the source of truth for everything the system does.



\## Target user



Solo operators, small teams, and agencies running multiple businesses or client engagements who want autonomous automation without managing custom workflow infrastructure for each use case. The user is technical enough to use Git and CC/Codex but does not want to build a goal-execution engine from scratch.



\## Core principles



The repo is the product. Every piece of state — context, scheduled tasks, goals, secrets templates, run logs — lives as files in the monorepo. The AIOS dashboard is a visual interface into those files; deleting AIOS and pointing a fresh install at the same repo restores the full system.



Departments are folders. A top-level folder with a `CLAUDE.md` becomes a department. Its identity, capabilities, and constraints are whatever that folder's files describe.



Agents are interchangeable. There is no persistent "marketing agent" — there is only CC or Codex started in a folder, becoming whatever that folder's `CLAUDE.md` defines. Any agent can move between folders by changing its working directory.



Concurrency is managed by claims, not by isolation. Multiple agents can run simultaneously across different departments. When one is working in a folder, that folder is "claimed" and other triggers wait.



\## What AIOS connects to



GitHub, as the source of truth and bidirectional sync target. AIOS clones the repo, pulls before each execution, and commits + pushes after. One repo per AIOS instance. Git is installed as part of the base system during bootstrap.



Claude Code CLI and OpenAI Codex CLI, both authenticated through their normal subscription login flows during onboarding. The operator chooses which provider runs each scheduled task. Both can coexist.



Notification channel (Telegram or email) for execution results, failures, and human-input-required events. Configured during onboarding.



Optional: external repository mirrors for one-way sync of specific subfolders to standalone repos (e.g., a `/site/` folder mirrored to a deployment-targeted repo).



\## Initiation and onboarding



When a fresh AIOS instance is deployed to a VPS, the operator visits the dashboard URL and is walked through:



1\. Setting the public dashboard domain (Caddy auto-provisions HTTPS)

2\. Authenticating Claude Code and/or Codex via their browser-based login flows

3\. Connecting GitHub via OAuth or deploy key

4\. Choosing how to set up the repo. The default option is \*\*"create a new repo"\*\* — AIOS scaffolds a fresh GitHub repo with the correct `aios.yaml` manifest, root `CLAUDE.md`, `org.md`, and the expected folder structure already in place. The alternative is to select an existing repo from the operator's GitHub account, which AIOS validates by checking for an `aios.yaml` manifest at the root (the system refuses to deploy without it).

5\. Setting up the notification channel

6\. Optionally running an onboarding skill that interviews the operator about their business and generates initial department folders, populates the root context files, and creates starter scheduled tasks



After onboarding, the system is operational. Subsequent operator interaction happens through the dashboard or by editing files locally and pushing.



\## The repo manifest



Every AIOS-compatible repo contains a root `aios.yaml` declaring which top-level folders are departments versus system infrastructure. Folders not listed (e.g., `node\_modules`, `.git`, `dashboard`) are ignored by the department view. The manifest also declares any external mirror configurations.



\## Department structure



Each department folder contains, by convention:



\- `CLAUDE.md` — context and instructions for any agent working in this department

\- `cron/` — markdown files defining scheduled tasks (each file is a prompt with frontmatter declaring its schedule)

\- `goals/` — markdown files defining longer-running objectives with state

\- `skills/` — reusable prompt patterns or workflows specific to this department

\- `.env` — environment variables (gitignored from the parent repo, managed through the dashboard)

\- `logs/` — append-only run history

\- Domain-specific working files (the actual content of the department's work)



Departments may contain a nested folder that is itself the working directory for a custom application (e.g., a Next.js site at `/site/`). That nested content lives in the same repo (monorepo model). Optionally, AIOS can be configured to one-way mirror that subfolder to a standalone external repo on every push.



\## Execution model



A single heartbeat scanner runs on the VPS at a fixed interval (e.g., every minute). On each tick it:



1\. Pulls the latest from GitHub

2\. Scans every department's `cron/` folder for tasks due to fire

3\. Scans every department's `goals/` folder for goals eligible for action

4\. Receives any pending webhook triggers from external systems

5\. For each candidate execution, checks whether the target department folder is currently claimed

6\. If unclaimed, claims it and starts the agent (CC or Codex) in that folder with the relevant prompt

7\. If claimed, queues the execution in a backlog with its trigger metadata



Agents execute with full repo access. They are not technically restricted to their starting folder, but the convention (enforced through `CLAUDE.md` discipline) is that they operate within their department unless explicitly coordinating across departments.



When an agent finishes, the system commits any changes, pushes to GitHub, releases the folder claim, sends a notification, and processes the next item in the backlog for that folder.



\## Folder claims and the backlog



A folder claim is a lightweight state record (in a small embedded DB or as a lock file in a system directory outside the repo) marking a department as "in use" by a specific run, with a timestamp and a timeout. While a folder is claimed, any new triggers targeting that folder go into a backlog queue.



When the active run completes, the claim releases and the backlog is processed in order. If a claimed run exceeds its timeout (e.g., 6 hours), the system assumes the agent is dead, releases the claim, logs the incident, and notifies the operator.



Multiple departments can have active claims simultaneously. The system can run agents in `accounting/` and `marketing/` in parallel; it only serializes within a single folder.



Triggers that span multiple folders (rare, but possible — e.g., a cross-department orchestration goal) claim multiple folders at once. If any required folder is busy, the trigger waits for all to be free before executing.



\## Trigger types



Three trigger types fire executions:



\*\*Scheduled.\*\* Defined by markdown files in a department's `cron/` folder. Each file's frontmatter declares its cron expression. The heartbeat scanner reads these and fires the agent at the appropriate times.



\*\*Webhook.\*\* Each department can expose webhook endpoints (configured through the dashboard, mapped to specific prompt files in the department). Inbound POSTs trigger the corresponding agent execution with the webhook payload included as context.



\*\*Manual.\*\* Operator-initiated through the dashboard or via the local CLI. Useful for testing or one-off work.



\## Goals vs. scheduled tasks



Scheduled tasks are stateless and recurring — they fire on schedule, do their work, and finish.



Goals are stateful and converging — they have a definition of done, may take many runs to complete, and track their own progress in their goal file. The heartbeat treats goals as "candidates for action" and asks the agent to evaluate which goal (if any) deserves work this cycle.



Both ultimately invoke the same execution model: an agent started in a folder with a prompt. The difference is whether state is preserved between runs.



\## System-managed sync layer



AIOS keeps certain files in sync across the repo automatically, so that agents always have consistent context regardless of which provider runs them or which folder they start in. The operator never edits the synced copies directly — they edit one canonical source and AIOS propagates.



\*\*Provider file sync.\*\* `CLAUDE.md` and `AGENTS.md` are kept identical in every folder. The operator edits one; AIOS syncs to the other. This makes provider switching (CC ↔ Codex) seamless and removes the need to maintain parallel instruction files.



\*\*Skills sync.\*\* Skills are stored once in their canonical location per department (e.g., `department/skills/`) and AIOS copies or symlinks them into provider-specific locations as each provider expects (CC's preferred skills directory, Codex's, etc.). The operator writes a skill once; both providers find it where they look.



\*\*Organization map.\*\* Every department folder receives an auto-maintained `\_org.md` listing all other departments in the repo, with a one-line description of each pulled from their root `CLAUDE.md`. When a new department is added, this map updates everywhere on the next sync. Agents reading their own folder always know what other folders exist and what they do, so they can navigate intentionally if cross-department work is needed.



\*\*Organization context.\*\* A root-level `org.md` describes the business as a whole — what it does, who runs it, top-level priorities, shared conventions. AIOS copies or references this into every department so every agent inherits the organizational context regardless of where it starts.



\## When sync runs



The sync layer runs at three moments:



1\. After every `git pull` on the VPS, before any heartbeat scan

2\. After any agent execution that modified a synced source file

3\. On manual trigger from the dashboard



Sync is idempotent and produces a single commit ("aios: sync") so it's clear in git history what was system-generated versus operator-authored.



\## Sync conflict handling



If an operator accidentally edits a synced \*copy\* instead of the source, AIOS detects the divergence on next sync and surfaces it as a notification rather than silently overwriting. The operator chooses which version wins.



\## Local development workflow



The operator can clone the AIOS repo to their laptop and work directly in CC or Codex without any AIOS infrastructure running. Files edited locally — new departments, new scheduled tasks, updated `CLAUDE.md` files, refined skills — are pushed to GitHub. The VPS pulls on its next heartbeat and the changes take effect on the next applicable trigger.



The convention is "pull before you start working locally." Conflicts are minimized because the VPS only writes to specific output paths (logs, run history, goal state) and the operator typically writes to definition paths (configs, prompts, context).



\## Sync, commit, and external mirrors



After every agent execution that produces file changes, AIOS commits with a structured message identifying the trigger and pushes to the main branch. The operator can configure whether commits go directly to main or through pull requests requiring review.



Optional one-way mirrors push specific subfolders to external standalone repos on every change, using path-filtered GitHub Actions or equivalent. This supports cases where a subfolder needs to exist as its own deployable unit (e.g., a website repo that a deploy platform watches).



\## Dashboard



The dashboard is a web interface that visualizes and edits the underlying files. It does not hold state independently of the repo (with the exception of run logs, claims, webhook delivery records, and usage metrics, which are operational data not suited for the repo). Its primary views:



\*\*Work overview (live).\*\* Shows which departments currently have active claims, what trigger started each run (cron task name, webhook source, or manual prompt), the prompt being executed, and a real-time stream of the agent's output — stdout, tool calls, and reasoning where the provider exposes it. Includes a kill button per active run that stops the agent, releases the claim, and logs the manual termination.



\*\*Master run log.\*\* Paginated chronological list of every run across all departments. Each entry links to the full transcript of that run.



\*\*Per-department run log.\*\* Same view filtered to a single department. Accessible from the department view.



\*\*Department list.\*\* Derived from `aios.yaml` and the folder structure. Each entry shows the department's current claim status and a link into its detail view.



\*\*Per-department view.\*\* Scheduled tasks (with pause/resume toggle per task), goals, recent runs, env vars, current claim status, and backlog.



\*\*Env var editor.\*\* Writes to each department's `.env` file.



\*\*Cron task editor.\*\* Writes to each department's `cron/` markdown files. Each task has a pause/resume toggle that disables firing without deleting the file.



\*\*Goal editor.\*\* Writes to each department's `goals/` markdown files.



\*\*Backlog viewer.\*\* Shows queued triggers waiting on claimed folders, with their wait time and trigger source.



\*\*Manual prompt box.\*\* Type a prompt, pick a target department, fire it through the same execution path as scheduled tasks.



\*\*Webhook delivery log.\*\* Every inbound webhook hit, with timestamp, source, payload, and outcome (triggered run, queued, rejected). Separate from the run log so missed deliveries can be diagnosed.



\*\*Usage and cost panel.\*\* Token consumption per run, per department, per day. Shows current cumulative spend against the operator's Claude/Codex subscription limits.



\*\*System controls.\*\* Provider selection, GitHub config, notification channel, mirrors, and a global kill switch that halts all active runs and pauses the heartbeat scanner.



\*\*Embedded terminal.\*\* Direct CLI access to the VPS when needed.



\## Notifications



Every execution can produce notifications: success summaries, failure alerts, and human-input-required pauses. The operator configures one or more channels during onboarding (Telegram bot, email, etc.). Departments can override or extend the default notification routing in their `CLAUDE.md`.



\## Provider neutrality



AIOS supports both Claude Code and Codex as execution backends. Each scheduled task and goal can specify its preferred provider, or fall back to the system default. Both providers run via their respective CLI in headless mode against the same folder, with the same prompt, and the agent has no awareness of which one it is.



\## In scope (v1)



Single-tenant deployment: one AIOS instance, one operator, one repo.



Bootstrap installer for a fresh Ubuntu/Debian VPS, including Git, Docker, Caddy, Node.js, and the provider CLIs (Claude Code, Codex).



Onboarding flow with "create a new repo" as the default path and "connect existing repo" as an alternative, both fully scaffolded so the operator never has to hand-construct `aios.yaml` or the folder layout.



Department model with folder-based identity, per-department `CLAUDE.md`, skills, env vars, cron tasks, and goals.



Heartbeat scanner that fires scheduled tasks, evaluates goals, and processes webhook triggers.



Folder-level claim system with backlog queueing and timeout-based recovery.



Cross-department coordination via multi-folder claims when explicitly requested by a trigger.



System-managed sync layer for `CLAUDE.md` ↔ `AGENTS.md`, skills directories, organization map (`\_org.md`), and organization context (`org.md`).



Provider-neutral execution against both Claude Code and Codex CLIs.



Two-way GitHub sync (pull before heartbeat, commit and push after each execution).



Optional one-way mirroring of specific subfolders to external standalone repos.



Notification channel (Telegram or email) for run results, failures, and human-input-required events.



Web dashboard with: live work overview (active claims, current prompts, real-time agent output), master and per-department run logs, department list and detail views, env/cron/goal editors, backlog viewer, manual prompt box, webhook delivery log, usage and cost panel, pause/resume per cron task, kill switch per run and global, and system settings.



Embedded terminal for direct CLI access when needed.



Local development workflow: the same repo can be cloned and worked on locally with CC or Codex without any AIOS components running.



\## Success criteria



An operator can deploy AIOS to a fresh VPS, complete onboarding in under 15 minutes, and have their first scheduled task running against a real department within an hour.



A non-technical operator can add a new scheduled task by editing a markdown file in the dashboard, without writing any code or touching the VPS directly.



The system runs unattended for weeks without operator intervention, with notifications surfacing only the events that need human attention.



The same repo, cloned to a laptop, works identically in CC or Codex without any AIOS components running locally.



A department can be moved to a different AIOS instance by copying its folder to a new repo, with no code changes required.

