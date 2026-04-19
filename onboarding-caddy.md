---
title: Caddy Onboarding (VPS + Domain)
summary: Portable recipe for installing Caddy, exposing a dashboard on the raw VPS IP, then attaching a domain with automatic HTTPS during first-run onboarding.
---

This guide describes the pattern Paperclip uses to ship a dashboard that starts reachable on `http://<vps-ip>:3100`, then lets a signed-in admin attach a custom domain from the UI, at which point Caddy is enabled and HTTPS is provisioned automatically. It is written to be replicated in any repo that runs a Node/HTTP service behind a reverse proxy.

Reference implementation in this repo:

- Installer / bootstrap: `scripts/vps-bootstrap.sh`
- Domain-setup HTTP endpoints: `server/src/routes/vps-setup.ts`
- Frontend onboarding page: `ui/src/pages/VpsDomainSetup.tsx`
- Caddyfile template: written by bootstrap to `/opt/paperclip/Caddyfile.template`, final file at `/etc/caddy/Caddyfile`

---

## Design principles

1. **Install Caddy, don't start it.** Caddy sits idle until the user supplies a domain. Before that, the dashboard is served directly on a public port so the admin can reach it with just the VPS IP.
2. **The app writes the Caddyfile, not the user.** The dashboard's "Configure HTTPS" button renders a new Caddyfile and tells systemd to start or reload Caddy.
3. **Dashboard restarts itself last.** After writing the Caddyfile and updating its own config with the new `publicBaseUrl`, the app schedules its own `systemctl restart` so the next request lands on a fully HTTPS-aware process.
4. **Frontend polls a readiness endpoint** before redirecting the browser to the HTTPS URL, avoiding a broken redirect during cert provisioning.

---

## Part 1 — Bootstrap-time Caddy install (runs once, as root)

Run this from your VPS bootstrap / install script. It installs Caddy on Ubuntu/Debian, disables the default service, and gives the non-root app user permission to manage the Caddyfile.

```bash
# 1. Install Caddy from Cloudsmith
apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | tee /etc/apt/sources.list.d/caddy-stable.list
apt-get update -qq
apt-get install -y -qq caddy

# 2. Make sure Caddy is NOT running yet. The app starts it after the admin
#    picks a domain.
systemctl stop caddy 2>/dev/null || true
systemctl disable caddy 2>/dev/null || true

# 3. Let the app user write /etc/caddy/Caddyfile without root.
APP_USER="myapp"
chown "${APP_USER}":"${APP_USER}" /etc/caddy/Caddyfile
```

### Make the app user allowed to restart Caddy via sudo

The dashboard runs as an unprivileged user but needs to `systemctl enable/start/reload caddy` and `systemctl restart <itsownservice>`. Add a narrow sudoers rule:

```bash
cat > /etc/sudoers.d/myapp-systemctl <<'EOF'
myapp ALL=(root) NOPASSWD: /usr/bin/systemctl enable caddy, \
    /usr/bin/systemctl start caddy, \
    /usr/bin/systemctl reload caddy, \
    /usr/bin/systemctl restart myapp
EOF
chmod 440 /etc/sudoers.d/myapp-systemctl
```

### Drop an optional template for reference

Useful if an operator wants to inspect or hand-edit later:

```bash
cat > /opt/myapp/Caddyfile.template <<'EOF'
# Managed by MyApp domain setup. Manual edits will be overwritten.
{$MYAPP_DOMAIN} {
    reverse_proxy localhost:{$MYAPP_PORT:3100}
}
EOF
```

---

## Part 2 — Dashboard reachable on raw IP before domain is set

The app service binds to `0.0.0.0:3100` (or whatever you pick) and is exposed directly. Pick any port that is not 80/443 so Caddy can later claim those.

```ini
# /etc/systemd/system/myapp.service (excerpt)
[Service]
User=myapp
Environment=HOST=0.0.0.0
Environment=PORT=3100
ExecStart=/usr/bin/node /opt/myapp/server/dist/index.js
Restart=always
```

Open the port in the firewall:

```bash
ufw allow 3100/tcp
ufw allow 80/tcp    # Caddy will use these once the domain is attached
ufw allow 443/tcp
```

The admin loads `http://<vps-ip>:3100`, signs up as the first admin, and then reaches the domain-setup screen.

---

## Part 3 — Domain-setup UX (three endpoints + a readiness poll)

The frontend walks the admin through three steps. All endpoints require an authenticated instance-admin.

### 3.1 `GET /api/vps/network-info`

Tell the UI which IP to show the admin in DNS instructions.

```ts
// server/src/routes/vps-setup.ts
router.get("/vps/network-info", async (req, res) => {
  if (!req.actor.isInstanceAdmin) throw forbidden("admin required");
  let ip = "unknown";
  try {
    const { stdout } = await execFileAsync("curl",
      ["-4", "-sf", "--max-time", "5", "https://icanhazip.com"]);
    ip = stdout.trim();
  } catch { /* fall back to ifconfig.me, then hostname -I */ }
  res.json({ ip, port: Number(process.env.PORT) || 3100 });
});
```

### 3.2 `POST /api/vps/verify-dns`

Look up the domain's A record and compare to the server's public IP. Uses Node's built-in `dns.resolve4`:

```ts
router.post("/vps/verify-dns", async (req, res) => {
  const domain = String(req.body?.domain || "").trim();
  if (!/^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)*\.[a-z]{2,}$/i.test(domain))
    throw badRequest("Invalid domain format");

  const { stdout } = await execFileAsync("curl",
    ["-4", "-sf", "--max-time", "5", "https://icanhazip.com"]);
  const expectedIp = stdout.trim();

  let resolvedIps: string[] = [];
  try { resolvedIps = await dns.resolve4(domain); } catch { /* NXDOMAIN */ }

  res.json({
    domain,
    resolved: resolvedIps.length > 0,
    resolvedIps,
    expectedIp,
    matches: resolvedIps.includes(expectedIp),
  });
});
```

### 3.3 `POST /api/vps/configure-domain`

The keystone endpoint. It:

1. Writes `/etc/caddy/Caddyfile`.
2. Enables, starts, waits ~3 s for cert issuance, then reloads Caddy.
3. Updates the app's own config.json (`auth.publicBaseUrl = "https://<domain>"`, `baseUrlMode = "explicit"`).
4. Schedules a self-restart 250 ms after the response flushes so the next request is served by a process that knows its own public URL.

```ts
router.post("/vps/configure-domain", async (req, res) => {
  const domain = String(req.body?.domain || "").trim();
  const port = Number(process.env.PORT) || 3100;

  // 1. Caddyfile
  const caddyfile = `# Managed by MyApp VPS setup
${domain} {
    reverse_proxy localhost:${port}
}
`;
  await writeFile("/etc/caddy/Caddyfile", caddyfile, "utf-8");

  // 2. Bring Caddy up
  await execFileAsync("/usr/bin/sudo",
    ["/usr/bin/systemctl", "enable", "caddy"]);
  await execFileAsync("/usr/bin/sudo",
    ["/usr/bin/systemctl", "start", "caddy"]);
  await new Promise(r => setTimeout(r, 3000)); // allow ACME to run
  await execFileAsync("/usr/bin/sudo",
    ["/usr/bin/systemctl", "reload", "caddy"]).catch(() => {});

  // 3. Update our own config with the public URL
  const configPath = process.env.MYAPP_CONFIG
    || `${process.env.HOME}/.myapp/instances/default/config.json`;
  const config = JSON.parse(await readFile(configPath, "utf-8"));
  config.auth = { ...(config.auth || {}),
    baseUrlMode: "explicit",
    publicBaseUrl: `https://${domain}` };
  await writeFile(configPath, JSON.stringify(config, null, 2));

  // 4. Self-restart after response is sent
  res.on("finish", () => {
    setTimeout(() => {
      execFileAsync("/usr/bin/sudo",
        ["/usr/bin/systemctl", "restart", "myapp"]).catch(() => {});
    }, 250);
  });

  res.json({
    ok: true,
    domain,
    url: `https://${domain}`,
    nextUrl: `https://${domain}/auth?next=${encodeURIComponent("/setup/providers")}`,
    restartScheduled: true,
  });
});
```

### 3.4 `GET /api/vps/domain-readiness?domain=<domain>`

Polled by the frontend every 3 s after `configure-domain`. Returns `{ ready: true }` once `https://<domain>/api/health` answers with `status: "ok"`. This is what unblocks the redirect to the new HTTPS origin.

```ts
router.get("/vps/domain-readiness", async (req, res) => {
  const domain = String(req.query.domain || "").trim();
  const url = `https://${domain}/api/health?ts=${Date.now()}`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const body = r.ok ? await r.json() as { status?: string } : {};
    res.json({ ready: body.status === "ok", url, statusCode: r.status });
  } catch (e) {
    res.json({ ready: false, url, error: String(e) });
  }
});
```

Your `/api/health` endpoint needs to return `{ status: "ok", setupPhase }` where `setupPhase` drives the next redirect (`admin_setup` → `domain_setup` → `provider_setup` → `complete`).

### 3.5 `POST /api/vps/skip-domain`

Always expose an escape hatch. Persist a sentinel like `domain: "skipped"` so the setup phase advances even if the admin decides to stay on the raw IP.

---

## Part 4 — Frontend flow (VpsDomainSetup.tsx)

High-level state machine the page implements:

1. On mount, `GET /api/vps/network-info`; render DNS instructions showing the IP.
2. Admin types their domain; on blur or click, call `POST /api/vps/verify-dns`. Show ✅ or ❌ with the resolved IPs vs expected IP.
3. Once DNS matches (or admin confirms anyway), reveal the "Configure HTTPS" button.
4. On click: `POST /api/vps/configure-domain`. Start a polling loop (`setInterval` at 3000 ms) against `GET /api/vps/domain-readiness?domain=<d>`.
5. When `ready: true`, `window.location.href = nextUrl`. The browser lands on `https://<domain>/...` and authenticates against the process that just restarted with the correct `publicBaseUrl`.
6. While polling, show a progress UI and a "skip" fallback that hits `POST /api/vps/skip-domain`.

---

## Part 5 — Gotchas worth knowing

- **ACME rate limits.** Let's Encrypt will refuse if DNS doesn't actually point at the box yet; always verify DNS before calling `configure-domain`.
- **Cert provisioning can exceed 3 s.** The 3-second sleep is an optimistic hand-off; the readiness poll is the real gate. Don't block the HTTP response waiting for certs.
- **The self-restart must come after `res.on("finish")`.** Restarting before the response flushes leaves the browser hanging.
- **Sudoers scope.** Only allow `enable`, `start`, `reload`, `restart` for the exact services involved. No `*` wildcards.
- **Idempotency.** Re-running `configure-domain` with the same domain should be a no-op that reloads Caddy and flushes the config. That makes recovery safe.
- **Firewall.** Ports 80 and 443 must be open before you start Caddy, or the HTTP-01 challenge fails.
- **Re-runs of the bootstrap script.** Detect existing installs (`command -v caddy`) and preserve the existing Caddyfile so domain config is not lost.

---

## Part 6 — Replication checklist

Copy these into the target repo:

- [ ] Bootstrap script installs Caddy, leaves it disabled, chowns `/etc/caddy/Caddyfile` to the app user.
- [ ] `sudoers.d` file allowing `systemctl enable/start/reload caddy` and `systemctl restart <appservice>` for the app user.
- [ ] systemd unit for the app binding `0.0.0.0:<port>` with the port opened in the firewall.
- [ ] `/api/health` returning `{ status: "ok", setupPhase }`.
- [ ] Four endpoints: `network-info`, `verify-dns`, `configure-domain`, `domain-readiness` (+ `skip-domain`).
- [ ] Frontend page that walks IP → DNS check → configure → poll → redirect.
- [ ] Config file supports `auth.publicBaseUrl` / `baseUrlMode` so the app can announce its own canonical URL after the switch.
