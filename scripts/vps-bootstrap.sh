#!/usr/bin/env bash
# AIOS-VPS bootstrap installer.
# Idempotent, re-run safe. Turns a fresh Ubuntu/Debian VPS into an AIOS host.
#
# Usage (as root):
#   curl -fsSL .../vps-bootstrap.sh | sudo bash
#   # or, from a local checkout:
#   sudo ./scripts/vps-bootstrap.sh
#
# Env overrides:
#   AIOS_USER        (default: aios)
#   AIOS_HOME        (default: /home/aios)
#   AIOS_INSTALL_DIR (default: /opt/aios)
#   AIOS_REPO_DIR    (default: /home/aios/repo)
#   AIOS_PORT        (default: 3100)
#   AIOS_NODE_MAJOR  (default: 20)
#   AIOS_SKIP_CLIS   (default: 0; set 1 to skip Claude Code / Codex install)

set -euo pipefail

log() { printf '\033[1;34m[aios-bootstrap]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[aios-bootstrap]\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31m[aios-bootstrap]\033[0m %s\n' "$*" >&2; exit 1; }

if [[ $EUID -ne 0 ]]; then
  die "must run as root"
fi

AIOS_USER="${AIOS_USER:-aios}"
AIOS_HOME="${AIOS_HOME:-/home/${AIOS_USER}}"
AIOS_INSTALL_DIR="${AIOS_INSTALL_DIR:-/opt/aios}"
AIOS_REPO_DIR="${AIOS_REPO_DIR:-${AIOS_HOME}/repo}"
AIOS_PORT="${AIOS_PORT:-3100}"
AIOS_NODE_MAJOR="${AIOS_NODE_MAJOR:-20}"
AIOS_SKIP_CLIS="${AIOS_SKIP_CLIS:-0}"
AIOS_CODEX_SANDBOX="${AIOS_CODEX_SANDBOX:-danger-full-access}"

export DEBIAN_FRONTEND=noninteractive

run_as_aios_home() {
  local command="$1"
  sudo -u "${AIOS_USER}" env HOME="${AIOS_HOME}" USERPROFILE="${AIOS_HOME}" bash -c \
    "export HOME='${AIOS_HOME}' USERPROFILE='${AIOS_HOME}' PATH=\"\$HOME/.local/bin:\$PATH\"; ${command}"
}

# ---------- 1. Base packages ----------
log "installing base packages"
apt-get update -qq
apt-get install -y -qq \
  ca-certificates curl wget gnupg lsb-release \
  git build-essential python3 unzip ufw jq dnsutils rsync bubblewrap \
  debian-keyring debian-archive-keyring apt-transport-https

AWSCLI_APT_CANDIDATE="$(apt-cache policy awscli 2>/dev/null | awk '/Candidate:/ { print $2; exit }')"

if command -v aws >/dev/null 2>&1; then
  log "AWS CLI already present"
elif [[ -n "${AWSCLI_APT_CANDIDATE}" && "${AWSCLI_APT_CANDIDATE}" != "(none)" ]]; then
  log "installing AWS CLI from apt"
  apt-get install -y -qq awscli
else
  log "installing AWS CLI v2 from official bundle"
  case "$(dpkg --print-architecture)" in
    amd64) AWSCLI_ARCH="x86_64" ;;
    arm64) AWSCLI_ARCH="aarch64" ;;
    *)
      AWSCLI_ARCH=""
      warn "unsupported architecture for AWS CLI bundle: $(dpkg --print-architecture)"
      ;;
  esac
  if [[ -n "${AWSCLI_ARCH}" ]]; then
    TMP_DIR="$(mktemp -d)"
    trap 'rm -rf "${TMP_DIR}"' RETURN
    curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-${AWSCLI_ARCH}.zip" -o "${TMP_DIR}/awscliv2.zip"
    (cd "${TMP_DIR}" && unzip -q awscliv2.zip && ./aws/install --update)
    rm -rf "${TMP_DIR}"
    trap - RETURN
  fi
fi

# ---------- 2. Node.js LTS ----------
if ! command -v node >/dev/null 2>&1 \
  || ! node -v | grep -qE "^v${AIOS_NODE_MAJOR}\."; then
  log "installing Node.js ${AIOS_NODE_MAJOR}.x"
  curl -fsSL "https://deb.nodesource.com/setup_${AIOS_NODE_MAJOR}.x" | bash -
  apt-get install -y -qq nodejs
else
  log "Node.js $(node -v) already present"
fi

# ---------- 3. App user ----------
if ! id -u "${AIOS_USER}" >/dev/null 2>&1; then
  log "creating user ${AIOS_USER}"
  useradd --system --create-home --home-dir "${AIOS_HOME}" --shell /bin/bash "${AIOS_USER}"
else
  log "user ${AIOS_USER} already exists"
fi

install -d -m 0755 -o "${AIOS_USER}" -g "${AIOS_USER}" "${AIOS_HOME}"
install -d -m 0755 "${AIOS_INSTALL_DIR}"
install -d -m 0755 -o "${AIOS_USER}" -g "${AIOS_USER}" "${AIOS_INSTALL_DIR}/data"
install -d -m 0755 -o "${AIOS_USER}" -g "${AIOS_USER}" "${AIOS_INSTALL_DIR}/logs"

# ---------- 4. Caddy (installed stopped) ----------
if ! command -v caddy >/dev/null 2>&1; then
  log "installing Caddy from Cloudsmith"
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  apt-get update -qq
  apt-get install -y -qq caddy
else
  log "Caddy already installed"
fi

# Seed a writable placeholder so the dashboard can rewrite it without root.
install -d -m 0755 /etc/caddy
if [[ ! -f /etc/caddy/Caddyfile ]]; then
  cat > /etc/caddy/Caddyfile <<EOF
:80 {
    respond "AIOS domain setup pending" 200
}
EOF
fi
chown "${AIOS_USER}":"${AIOS_USER}" /etc/caddy/Caddyfile
chmod 0644 /etc/caddy/Caddyfile

# Keep Caddy off only while the placeholder config is still in place. On a
# configured host, preserve the existing service state so re-running bootstrap
# for package updates cannot take the public dashboard offline.
if grep -Fq 'AIOS domain setup pending' /etc/caddy/Caddyfile; then
  log "Caddy placeholder config detected; keeping Caddy disabled until domain setup"
  systemctl stop caddy 2>/dev/null || true
  systemctl disable caddy 2>/dev/null || true
else
  log "Caddy appears configured; preserving current service state"
fi

# Drop a reference template (never overwrites an operator-hand-edited one).
if [[ ! -f /etc/caddy/Caddyfile.template ]]; then
  cat > /etc/caddy/Caddyfile.template <<EOF
# Managed by AIOS VPS setup. Manual edits will be overwritten.
{\$AIOS_DOMAIN} {
    reverse_proxy localhost:{\$AIOS_PORT:${AIOS_PORT}}
}
EOF
  chown "${AIOS_USER}":"${AIOS_USER}" /etc/caddy/Caddyfile.template
fi

# ---------- 5. Narrow sudoers for aios ----------
SUDOERS_FILE="/etc/sudoers.d/aios-systemctl"
cat > "${SUDOERS_FILE}.tmp" <<EOF
${AIOS_USER} ALL=(root) NOPASSWD: /usr/bin/systemctl enable caddy, \\
    /usr/bin/systemctl start caddy, \\
    /usr/bin/systemctl reload caddy, \\
    /usr/bin/systemctl restart caddy, \\
    /usr/bin/systemctl restart aios
${AIOS_USER} ALL=(root) NOPASSWD: SETENV: /usr/local/bin/aios-system-update
EOF
# visudo -c -f validates before swap, so a typo can't lock us out.
if visudo -c -f "${SUDOERS_FILE}.tmp" >/dev/null; then
  mv "${SUDOERS_FILE}.tmp" "${SUDOERS_FILE}"
  chmod 440 "${SUDOERS_FILE}"
else
  rm -f "${SUDOERS_FILE}.tmp"
  die "refusing to install invalid sudoers file"
fi

if [[ -f "$(cd "$(dirname "$0")/.." && pwd)/scripts/aios-system-update.sh" ]]; then
  install -m 0755 "$(cd "$(dirname "$0")/.." && pwd)/scripts/aios-system-update.sh" /usr/local/bin/aios-system-update
fi

# ---------- 6. Provider CLIs ----------
install -d -m 0700 -o "${AIOS_USER}" -g "${AIOS_USER}" "${AIOS_HOME}/.claude"
install -d -m 0700 -o "${AIOS_USER}" -g "${AIOS_USER}" "${AIOS_HOME}/.codex"
if [[ ! -f "${AIOS_HOME}/.claude.json" ]]; then
  printf '{}\n' > "${AIOS_HOME}/.claude.json"
  chown "${AIOS_USER}":"${AIOS_USER}" "${AIOS_HOME}/.claude.json"
  chmod 600 "${AIOS_HOME}/.claude.json"
fi
if [[ ! -f "${AIOS_HOME}/.claude/.claude.json" ]]; then
  cp "${AIOS_HOME}/.claude.json" "${AIOS_HOME}/.claude/.claude.json"
  chown "${AIOS_USER}":"${AIOS_USER}" "${AIOS_HOME}/.claude/.claude.json"
  chmod 600 "${AIOS_HOME}/.claude/.claude.json"
fi

if ! grep -qs '.local/bin' "${AIOS_HOME}/.bashrc"; then
  echo 'export PATH="$HOME/.local/bin:$PATH"' >> "${AIOS_HOME}/.bashrc"
  chown "${AIOS_USER}":"${AIOS_USER}" "${AIOS_HOME}/.bashrc"
fi

if [[ "${AIOS_SKIP_CLIS}" != "1" ]]; then
  if ! run_as_aios_home 'command -v claude' >/dev/null 2>&1; then
    log "installing Claude Code for ${AIOS_USER}"
    run_as_aios_home \
      'set -o pipefail && curl -fsSL https://claude.ai/install.sh | bash' \
      || warn "Claude Code install returned non-zero; continuing"
    if run_as_aios_home 'command -v claude' >/dev/null 2>&1; then
      log "Claude Code installed"
    else
      warn "Claude Code not found after installer; falling back to npm user-local install"
      run_as_aios_home \
        'npm install --global --prefix "$HOME/.local" @anthropic-ai/claude-code@latest' \
        || warn "Claude Code npm fallback install returned non-zero; continuing"
      if run_as_aios_home 'command -v claude' >/dev/null 2>&1; then
        log "Claude Code installed via npm fallback"
      else
        warn "Claude Code still not found on PATH after fallback install"
      fi
    fi
  else
    log "Claude Code already present"
  fi

  if ! command -v codex >/dev/null 2>&1; then
    log "installing Codex via npm"
    npm install --global --silent @openai/codex@latest \
      || warn "Codex install returned non-zero; continuing"
  else
    log "Codex already present"
  fi
fi

# ---------- 7. systemd unit ----------
UNIT_FILE="/etc/systemd/system/aios.service"
cat > "${UNIT_FILE}" <<EOF
[Unit]
Description=AIOS dashboard + heartbeat + execution engine
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${AIOS_USER}
Group=${AIOS_USER}
WorkingDirectory=${AIOS_INSTALL_DIR}
Environment=NODE_ENV=production
Environment=HOST=0.0.0.0
Environment=PORT=${AIOS_PORT}
Environment=HOME=${AIOS_HOME}
Environment=USERPROFILE=${AIOS_HOME}
Environment=PATH=${AIOS_HOME}/.local/bin:/usr/local/bin:/usr/bin:/bin
Environment=CLAUDE_CONFIG_DIR=${AIOS_HOME}/.claude
Environment=CLAUDE_CREDENTIALS_PATH=${AIOS_HOME}/.claude/.credentials.json
Environment=CODEX_HOME=${AIOS_HOME}/.codex
Environment=AIOS_DATA_DIR=${AIOS_INSTALL_DIR}/data
Environment=AIOS_REPO_DIR=${AIOS_REPO_DIR}
Environment=AIOS_USER=${AIOS_USER}
Environment=AIOS_HOME=${AIOS_HOME}
Environment=AIOS_CODEX_SANDBOX=${AIOS_CODEX_SANDBOX}
ExecStart=/usr/bin/node ${AIOS_INSTALL_DIR}/server/dist/index.js
Restart=on-failure
RestartSec=3
StandardOutput=append:${AIOS_INSTALL_DIR}/logs/aios.log
StandardError=append:${AIOS_INSTALL_DIR}/logs/aios.log

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload

# ---------- 8. Firewall ----------
if command -v ufw >/dev/null 2>&1; then
  log "opening TCP 80, 443, ${AIOS_PORT}"
  ufw allow 80/tcp   >/dev/null 2>&1 || true
  ufw allow 443/tcp  >/dev/null 2>&1 || true
  ufw allow "${AIOS_PORT}"/tcp >/dev/null 2>&1 || true
fi

# ---------- 9. Application code ----------
if [[ -f "${AIOS_INSTALL_DIR}/server/dist/index.js" ]]; then
  log "server already built at ${AIOS_INSTALL_DIR}/server/dist/index.js"
else
  warn "server build not present at ${AIOS_INSTALL_DIR}; run: scripts/deploy-app.sh"
fi

log "bootstrap complete"
log "next: deploy /server + /ui to ${AIOS_INSTALL_DIR} then: systemctl enable --now aios"
