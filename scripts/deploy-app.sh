#!/usr/bin/env bash
# Build server + ui and install into /opt/aios. Run as root.
set -euo pipefail

AIOS_USER="${AIOS_USER:-aios}"
AIOS_INSTALL_DIR="${AIOS_INSTALL_DIR:-/opt/aios}"
SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"

if [[ $EUID -ne 0 ]]; then
  echo "must run as root" >&2
  exit 1
fi

echo "[deploy-app] building server"
(cd "${SRC_DIR}/server" && npm install --silent && npm run build)

echo "[deploy-app] building ui"
(cd "${SRC_DIR}/ui" && npm install --silent && npm run build)

install -d -m 0755 -o "${AIOS_USER}" -g "${AIOS_USER}" \
  "${AIOS_INSTALL_DIR}/server/dist" \
  "${AIOS_INSTALL_DIR}/server/node_modules" \
  "${AIOS_INSTALL_DIR}/ui/dist"

rsync -a --delete "${SRC_DIR}/server/dist/"         "${AIOS_INSTALL_DIR}/server/dist/"
rsync -a --delete "${SRC_DIR}/server/node_modules/" "${AIOS_INSTALL_DIR}/server/node_modules/"
rsync -a --delete "${SRC_DIR}/server/package.json"  "${AIOS_INSTALL_DIR}/server/package.json"
rsync -a --delete "${SRC_DIR}/ui/dist/"             "${AIOS_INSTALL_DIR}/ui/dist/"

chown -R "${AIOS_USER}":"${AIOS_USER}" "${AIOS_INSTALL_DIR}"

echo "[deploy-app] restarting aios"
systemctl restart aios
systemctl status aios --no-pager --lines=5 || true
