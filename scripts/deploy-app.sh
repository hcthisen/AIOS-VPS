#!/usr/bin/env bash
# Build server + ui and install into /opt/aios. Run as root.
set -euo pipefail

AIOS_USER="${AIOS_USER:-aios}"
AIOS_INSTALL_DIR="${AIOS_INSTALL_DIR:-/opt/aios}"
AIOS_DEPLOY_SKIP_RESTART="${AIOS_DEPLOY_SKIP_RESTART:-0}"
SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SYSTEM_VERSION_PATH="${AIOS_INSTALL_DIR}/data/system-version.json"
SUDOERS_FILE="/etc/sudoers.d/aios-systemctl"
DEFAULT_SYSTEM_REPO_URL="${AIOS_SYSTEM_REPO_URL:-https://github.com/hcthisen/AIOS-VPS}"

if [[ $EUID -ne 0 ]]; then
  echo "must run as root" >&2
  exit 1
fi

echo "[deploy-app] building server"
(cd "${SRC_DIR}/server" && npm install --silent && npm run build)

echo "[deploy-app] building ui"
(cd "${SRC_DIR}/ui" && npm install --silent && npm run build)

install -d -m 0755 -o "${AIOS_USER}" -g "${AIOS_USER}" \
  "${AIOS_INSTALL_DIR}/data" \
  "${AIOS_INSTALL_DIR}/server/dist" \
  "${AIOS_INSTALL_DIR}/server/node_modules" \
  "${AIOS_INSTALL_DIR}/ui/dist"

rsync -a --delete "${SRC_DIR}/server/dist/"         "${AIOS_INSTALL_DIR}/server/dist/"
rsync -a --delete "${SRC_DIR}/server/node_modules/" "${AIOS_INSTALL_DIR}/server/node_modules/"
rsync -a --delete "${SRC_DIR}/server/package.json"  "${AIOS_INSTALL_DIR}/server/package.json"
rsync -a --delete "${SRC_DIR}/ui/dist/"             "${AIOS_INSTALL_DIR}/ui/dist/"

if [[ -f "${SRC_DIR}/scripts/aios-system-update.sh" ]]; then
  install -m 0755 "${SRC_DIR}/scripts/aios-system-update.sh" /usr/local/bin/aios-system-update
fi

cat > "${SUDOERS_FILE}.tmp" <<EOF
${AIOS_USER} ALL=(root) NOPASSWD: /usr/bin/systemctl enable caddy, \\
    /usr/bin/systemctl start caddy, \\
    /usr/bin/systemctl reload caddy, \\
    /usr/bin/systemctl restart caddy, \\
    /usr/bin/systemctl restart aios
${AIOS_USER} ALL=(root) NOPASSWD: SETENV: /usr/local/bin/aios-system-update
EOF
if visudo -c -f "${SUDOERS_FILE}.tmp" >/dev/null; then
  mv "${SUDOERS_FILE}.tmp" "${SUDOERS_FILE}"
  chmod 440 "${SUDOERS_FILE}"
else
  rm -f "${SUDOERS_FILE}.tmp"
  echo "refusing to install invalid sudoers file" >&2
  exit 1
fi

python3 - "${SRC_DIR}" "${SYSTEM_VERSION_PATH}" "${DEFAULT_SYSTEM_REPO_URL}" <<'PY'
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

src_dir = Path(sys.argv[1])
out_path = Path(sys.argv[2])
default_repo_url = sys.argv[3]

def git_value(*args):
    try:
        result = subprocess.run(
            ["git", "-C", str(src_dir), *args],
            capture_output=True,
            text=True,
            check=True,
        )
        return result.stdout.strip() or None
    except Exception:
        return None

payload = {
    "commit": git_value("rev-parse", "HEAD"),
    "branch": git_value("branch", "--show-current"),
    "repoUrl": git_value("config", "--get", "remote.origin.url") or default_repo_url,
    "deployedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
}
out_path.parent.mkdir(parents=True, exist_ok=True)
out_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
PY

chown -R "${AIOS_USER}":"${AIOS_USER}" "${AIOS_INSTALL_DIR}"

if [[ "${AIOS_DEPLOY_SKIP_RESTART}" == "1" || "${AIOS_DEPLOY_SKIP_RESTART}" == "true" ]]; then
  echo "[deploy-app] restart skipped (AIOS_DEPLOY_SKIP_RESTART=${AIOS_DEPLOY_SKIP_RESTART})"
else
  echo "[deploy-app] restarting aios"
  systemctl restart aios
  systemctl status aios --no-pager --lines=5 || true
fi
