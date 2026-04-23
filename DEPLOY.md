# Deploy AIOS to a fresh VPS

Target: fresh VPS to first scheduled task in under 15 minutes.

## 1. Provision and open ports

Ubuntu 22.04+ (or Debian 12). Open TCP **80, 443, 3100**.

## 2. Bootstrap as root

From a local checkout (recommended while iterating):

```bash
git clone https://github.com/<you>/AIOS-VPS.git /tmp/aios-vps
cd /tmp/aios-vps
sudo bash scripts/vps-bootstrap.sh
```

After bootstrap:

- `aios` user exists (`/home/aios`)
- Node.js LTS, git, Caddy, `aws`, `claude`, `codex` are installed
- Caddy is **stopped and disabled** (the dashboard starts it after domain setup)
- systemd unit `/etc/systemd/system/aios.service` is installed but not yet started (no app code yet)
- Narrow sudoers lets `aios` run exactly: `systemctl enable/start/reload caddy`, `systemctl restart aios`, and the self-update wrapper
- Firewall opens 80, 443, 3100

## 3. Deploy the app

From the same checkout, as root:

```bash
sudo AIOS_USER=aios AIOS_INSTALL_DIR=/opt/aios bash scripts/deploy-app.sh
sudo systemctl enable --now aios
```

This builds `server/` and `ui/`, rsyncs them into `/opt/aios`, and restarts the systemd unit.

## 4. First-admin signup

Visit `http://<vps-ip>:3100`. The page prompts you to create the first admin. After that the onboarding wizard runs through:

1. **Domain** — DNS verification → `Configure HTTPS` writes `/etc/caddy/Caddyfile` and brings Caddy up. The server self-restarts; the browser is redirected to `https://<domain>/setup/providers`.
2. **Providers** — Connect Claude Code (OAuth PKCE paste flow) and/or Codex (device-auth with a big monospaced user code and a clickable URL). Skip links are always available.
3. **GitHub** — Paste a PAT with `repo` scope.
4. **Repo** — Create a new repo (scaffolded with `aios.yaml` + sample department) or attach an existing repo (validated for `aios.yaml`).
5. **Notifications** — Telegram or SMTP. "Save and send test" verifies end-to-end.
6. **Complete** — `setupPhase = complete`, the heartbeat begins ticking, and the main dashboard is reachable.

After onboarding, `Settings` can be used to:
- re-authorize Claude Code or Codex
- reconnect GitHub
- update notifications
- apply future AIOS-VPS updates in place

## 5. Verify

```bash
# Server is up
curl -s http://localhost:3100/api/health | jq
# → { "status": "ok", "setupPhase": "complete", "ts": … }

# Caddy is running after domain setup
systemctl status caddy

# Heartbeat is ticking
curl -s http://localhost:3100/api/controls/status -H "Cookie: aios_session=…" -H "x-csrf: …"
```

The sample department has `sample/cron/hello.md` set to `0 * * * *`. Edit the file to `* * * * *` (push to GitHub) and a run appears within one heartbeat.

## 6. Upgrade

Once this release (or newer) is deployed, future upgrades can be started from `Settings -> System update`.

```bash
cd /tmp/aios-vps
git pull
sudo bash scripts/deploy-app.sh
```

`deploy-app.sh` rsyncs the new build, refreshes the self-update wrapper/sudoers entry, writes the deployed version manifest, and restarts `aios`. The bootstrap script is idempotent — re-run safely if you change it.

## 7. Backup / restore

```bash
sudo scripts/backup-restore.sh backup  /root/aios-$(date +%F).tar.gz
sudo scripts/backup-restore.sh restore /root/aios-2024-01-01.tar.gz
```

Backs up the repo clone, the sqlite state directory, both provider credential trees, the Caddyfile, and the systemd unit.
