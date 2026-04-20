---
title: Caddy Onboarding (VPS + Domain)
summary: Portable recipe for exposing a dashboard on a raw VPS IP first, then attaching a domain with Caddy and automatic HTTPS during onboarding.
---

This is the working pattern from this repo after debugging a real VPS onboarding flow. The key fixes were not about Caddy syntax. They were about file ownership, systemd permissions, and refusing to silently continue when the real Caddyfile was not written.

Reference implementation in this repo:

- Bootstrap: `scripts/vps-bootstrap.sh`
- Domain routes: `server/src/routes/vps-setup.ts`
- Frontend page: `ui/src/pages/VpsDomainSetup.tsx`

## What actually works

1. The app is reachable first on `http://<vps-ip>:3100`
2. Caddy is installed during bootstrap but left disabled
3. Bootstrap creates a real `/etc/caddy/Caddyfile` placeholder owned by the app user
4. The app rewrites `/etc/caddy/Caddyfile` during domain setup
5. The app restarts Caddy through a narrow sudoers rule
6. If writing the real Caddyfile fails, onboarding must fail and stay on the domain step

The most important lesson: do not fall back to a fake dev Caddyfile in production. That masked the real permission error and advanced onboarding with a broken proxy.

## Part 1 - Bootstrap install

Run as root:

```bash
APP_USER="myapp"
APP_PORT="3100"

apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
apt-get update -qq
apt-get install -y -qq caddy

systemctl stop caddy 2>/dev/null || true
systemctl disable caddy 2>/dev/null || true

install -d -m 0755 /etc/caddy
if [[ ! -f /etc/caddy/Caddyfile ]]; then
  cat > /etc/caddy/Caddyfile <<EOF
:80 {
    respond "MyApp domain setup pending" 200
}
EOF
fi
chown "${APP_USER}:${APP_USER}" /etc/caddy/Caddyfile
chmod 0644 /etc/caddy/Caddyfile

if [[ ! -f /etc/caddy/Caddyfile.template ]]; then
  cat > /etc/caddy/Caddyfile.template <<EOF
# Managed by MyApp VPS setup. Manual edits will be overwritten.
{\$MYAPP_DOMAIN} {
    reverse_proxy localhost:{\$MYAPP_PORT:${APP_PORT}}
}
EOF
  chown "${APP_USER}:${APP_USER}" /etc/caddy/Caddyfile.template
fi
```

Why the placeholder matters:

- it gives Caddy a valid config if it is restarted before a domain is attached
- it ensures `/etc/caddy/Caddyfile` exists and is writable by the app user
- it removes the "file missing" failure that broke onboarding in production

## Part 2 - sudoers

The dashboard runs as an unprivileged user but needs to restart Caddy and its own service.

```bash
cat > /etc/sudoers.d/myapp-systemctl <<'EOF'
myapp ALL=(root) NOPASSWD: /usr/bin/systemctl enable caddy, \
    /usr/bin/systemctl start caddy, \
    /usr/bin/systemctl reload caddy, \
    /usr/bin/systemctl restart caddy, \
    /usr/bin/systemctl restart myapp
EOF

visudo -c -f /etc/sudoers.d/myapp-systemctl
chmod 440 /etc/sudoers.d/myapp-systemctl
```

`restart caddy` matters. In practice, a clean restart was simpler and more reliable than a `start` plus `reload` sequence.

## Part 3 - App service before domain setup

Serve the app directly on a non-80/443 port first:

```ini
[Service]
User=myapp
Environment=HOST=0.0.0.0
Environment=PORT=3100
ExecStart=/usr/bin/node /opt/myapp/server/dist/index.js
```

Open the firewall:

```bash
ufw allow 3100/tcp
ufw allow 80/tcp
ufw allow 443/tcp
```

The onboarding flow starts on `http://<vps-ip>:3100`, not on the domain.

## Part 4 - Domain onboarding endpoints

### `GET /api/vps/network-info`

Return the public IP so the UI can tell the operator which A record to create.

### `POST /api/vps/verify-dns`

Resolve the requested hostname and compare it to the server's public IPv4.

### `POST /api/vps/configure-domain`

This is the critical endpoint. It should:

1. validate the domain
2. write `/etc/caddy/Caddyfile`
3. `systemctl enable caddy`
4. `systemctl restart caddy`
5. update app config with:

```json
{
  "auth": {
    "baseUrlMode": "explicit",
    "publicBaseUrl": "https://example.com",
    "domain": "example.com"
  }
}
```

6. advance setup from `domain_setup` to `provider_setup`
7. schedule `systemctl restart myapp` after the HTTP response flushes

Minimal Caddyfile body:

```txt
# Managed by MyApp VPS setup. Manual edits will be overwritten.
example.com {
    reverse_proxy localhost:3100
}
```

Production rule: if writing `/etc/caddy/Caddyfile` fails, return an error. Do not write a fallback file under the app data dir.

Production rule: if `systemctl restart caddy` fails, return an error and do not advance setup.

### `GET /api/vps/domain-readiness`

Poll `https://<domain>/api/health` until it returns `{ "status": "ok" }`.

### `POST /api/vps/skip-domain`

Keep a skip path for raw-IP installs. Persist a sentinel like `"domain": "skipped"` and move to the next onboarding phase.

## Part 5 - Server-side shape

The failure handling that mattered:

```ts
async function writeCaddyfile(domain: string, port: number) {
  const body = `# Managed by MyApp VPS setup. Manual edits will be overwritten.
${domain} {
    reverse_proxy localhost:${port}
}
`;
  await writeFile("/etc/caddy/Caddyfile", body, "utf-8");
}

router.post("/api/vps/configure-domain", async (req, res) => {
  await writeCaddyfile(domain, port);

  await sudoSystemctl("enable", "caddy");
  await sudoSystemctl("restart", "caddy");

  saveConfig({
    ...config,
    auth: {
      ...config.auth,
      baseUrlMode: "explicit",
      publicBaseUrl: `https://${domain}`,
      domain,
    },
  });

  if (getSetupPhase() === "domain_setup") advanceSetupPhase("domain_setup");

  res.on("finish", () => {
    setTimeout(() => {
      execFile("/usr/bin/sudo", ["/usr/bin/systemctl", "restart", "myapp"], () => {});
    }, 250);
  });

  res.json({ ok: true, url: `https://${domain}` });
});
```

## Part 6 - Frontend flow

The page should do this:

1. show the VPS IP
2. ask for the domain
3. run DNS verification
4. only then show `Configure HTTPS`
5. after success, poll readiness until the HTTPS origin answers
6. then redirect to the HTTPS URL

Do not redirect immediately after `configure-domain`. Certificate issuance and the app self-restart are not instantaneous.

## Part 7 - What broke in production

- `/etc/caddy/Caddyfile` did not exist, so `systemctl start caddy` failed before any cert request even happened
- the app caught that file-write error, wrote a dev fallback file elsewhere, and continued
- onboarding advanced even though the real reverse proxy was still broken

That is why the bootstrap placeholder and the "fail loudly in production" rule both matter.

## Part 8 - Testing advice

- Use a fresh subdomain during repeated tests. ACME duplicate-certificate limits are real.
- Do not wipe Caddy storage unless you intentionally want a clean machine.
- Verify `curl http://<vps-ip>` returns the placeholder response before domain setup. That proves Caddy can at least start.
- Verify the app user can do:

```bash
sudo -u myapp /usr/bin/sudo /usr/bin/systemctl restart caddy
sudo -u myapp /usr/bin/sudo /usr/bin/systemctl restart myapp
```

If those fail, onboarding will fail too.

## Part 9 - Replication checklist

- [ ] Bootstrap installs Caddy and leaves it disabled
- [ ] Bootstrap creates a real `/etc/caddy/Caddyfile` placeholder
- [ ] `/etc/caddy/Caddyfile` is owned by the app user
- [ ] sudoers allows `enable/start/reload/restart caddy` and `restart <appservice>`
- [ ] App starts on raw IP and a non-80/443 port before domain onboarding
- [ ] Domain setup writes the real `/etc/caddy/Caddyfile`
- [ ] Domain setup restarts Caddy and fails if that restart fails
- [ ] App config supports `publicBaseUrl`, `baseUrlMode`, and `domain`
- [ ] Frontend polls HTTPS readiness before redirecting
- [ ] Domain onboarding does not silently continue after a Caddy write error
