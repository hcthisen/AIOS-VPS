# Deploy AIOS to a fresh VPS

Target: fresh VPS to first scheduled task in under 15 minutes.

## 1. Provision and open ports

Ubuntu 22.04+ (or Debian 12). Open TCP **80, 443, 3100**.

## 2. Install and deploy with one command

SSH into the VPS as `root` or as an admin user with sudo, then paste exactly this:

```bash
curl -fsSL https://raw.githubusercontent.com/hcthisen/AIOS-VPS/main/scripts/install.sh | sudo bash
```

This command uses `https://github.com/hcthisen/AIOS-VPS` as the AIOS-VPS source repository. It installs prerequisites, clones or refreshes the source checkout under `/var/lib/aios/system-src`, runs bootstrap, builds the server and UI, deploys them to `/opt/aios`, and enables the `aios` systemd service.

After it completes:

- `aios` user exists (`/home/aios`)
- Node.js LTS, git, Caddy, `aws`, `claude`, `codex` are installed
- Caddy is **stopped and disabled** (the dashboard starts it after domain setup)
- systemd unit `/etc/systemd/system/aios.service` is installed and running
- Narrow sudoers lets `aios` run exactly: `systemctl enable/start/reload caddy`, `systemctl restart aios`, and the self-update wrapper
- Firewall opens 80, 443, 3100
- app code is deployed to `/opt/aios`

## 3. First-admin signup

Visit `http://<vps-ip>:3100`. The page prompts you to create the first admin. After that the onboarding wizard runs through:

1. **Domain** — DNS verification → `Configure HTTPS` writes `/etc/caddy/Caddyfile` and brings Caddy up. The server self-restarts; the browser is redirected to `https://<domain>/setup/providers`.
2. **Providers** — Connect Claude Code (OAuth PKCE paste flow) and/or Codex (device-auth with a big monospaced user code and a clickable URL). Skip links are always available.
3. **GitHub** — Paste a PAT with `repo` scope. PAT mode is the supported onboarding path for creating or attaching a repo and for automatic GitHub webhook setup.
4. **Repo** — Create a new repo (scaffolded with `aios.yaml`, root context, automation folders, and a sample department) or attach an existing repo (validated for `aios.yaml`).
5. **Context** — Confirm organization and deployment-scope context. AIOS writes root `org.md`, `CLAUDE.md`, and `AGENTS.md`, then syncs shared context into departments.
6. **Notifications** — Telegram, SMTP email, or none. Telegram pairing requires saving the bot token, sending the bot a message, and approving the detected chat.
7. **Complete** — `setupPhase = complete`, the heartbeat begins ticking, and the main dashboard is reachable.

When using a PAT, AIOS automatically creates or updates a GitHub `push` webhook for the connected repo. The webhook points to `/github/webhook` on the configured dashboard URL and uses an AIOS-managed HMAC secret. If the webhook cannot be created because the PAT lacks repo admin/webhook permission, AIOS still falls back to polling GitHub every 60 seconds.

The first repo becomes the default company. After onboarding, use the sidebar company switcher to add more companies from the same GitHub account. Adding a company reuses the existing GitHub PAT and only asks for a repo, company context, and that company's Telegram/email notification connection. Repos already connected to another company are hidden from the picker.

If an attached repo already contains department `.env` files with `AIOS_STORAGE_*` and `AIOS_STORAGE_PUBLIC_BASE_URL`, AIOS treats storage as configured and checks the public file host. When that HTTPS hostname points at the VPS, AIOS adds it to the managed Caddy config and performs a rate-limited repair attempt so Caddy can obtain TLS. Files remains browsable if public-link HTTPS is still pending, but the dashboard shows a warning.

After onboarding, `Settings` can be used to:
- re-authorize Claude Code or Codex
- reconnect GitHub with a PAT or deploy key
- update notifications
- enable the Telegram Root Agent once Telegram is paired
- apply future AIOS-VPS updates in place from `https://github.com/hcthisen/AIOS-VPS`

## 4. Verify

```bash
# Server is up
curl -s http://localhost:3100/api/health | jq
# → { "status": "ok", "setupPhase": "complete", "ts": … }

# Caddy is running after domain setup
systemctl status caddy

# Heartbeat is ticking
curl -s http://localhost:3100/api/controls/status -H "Cookie: aios_session=…" -H "x-csrf: …"
```

The sample department has `sample/cron/hello.md` set to `0 * * * *` with `provider: claude-code`. Edit the schedule to `* * * * *` and choose an authorized provider if needed; after the change is saved or pushed to GitHub, a run appears within one heartbeat.

## 5. Upgrade

Once this release (or newer) is deployed, future upgrades can be started from `Settings -> System update`.

For terminal upgrades, the same one-command installer is idempotent and safe to re-run:

```bash
curl -fsSL https://raw.githubusercontent.com/hcthisen/AIOS-VPS/main/scripts/install.sh | sudo bash
```

The installer refreshes `/var/lib/aios/system-src`, reruns the idempotent bootstrap, rebuilds, deploys, writes the deployed version manifest, and restarts `aios`.

## 6. Backup / restore

```bash
sudo scripts/backup-restore.sh backup  /root/aios-$(date +%F).tar.gz
sudo scripts/backup-restore.sh restore /root/aios-2024-01-01.tar.gz
```

Backs up the repo clone/worktrees, the sqlite state directory, both provider credential trees, the Caddyfile, and the systemd unit.
