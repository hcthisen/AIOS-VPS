#!/usr/bin/env bash
# One-command AIOS-VPS installer. Run as root on a fresh Ubuntu/Debian VPS.
set -euo pipefail

AIOS_SOURCE_REPO_URL="https://github.com/hcthisen/AIOS-VPS"
AIOS_SOURCE_BRANCH="${AIOS_SOURCE_BRANCH:-main}"
AIOS_SOURCE_DIR="${AIOS_SOURCE_DIR:-/var/lib/aios/system-src}"
AIOS_USER="${AIOS_USER:-aios}"
AIOS_INSTALL_DIR="${AIOS_INSTALL_DIR:-/opt/aios}"

log() { printf '\033[1;34m[aios-install]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[aios-install]\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31m[aios-install]\033[0m %s\n' "$*" >&2; exit 1; }

if [[ $EUID -ne 0 ]]; then
  die "must run as root; use: curl -fsSL https://raw.githubusercontent.com/hcthisen/AIOS-VPS/main/scripts/install.sh | sudo bash"
fi

if ! command -v apt-get >/dev/null 2>&1; then
  die "this installer expects Ubuntu/Debian with apt-get"
fi

export DEBIAN_FRONTEND=noninteractive

log "installing installer prerequisites"
apt-get update -qq
apt-get install -y -qq ca-certificates curl git

log "preparing source checkout ${AIOS_SOURCE_DIR}"
mkdir -p "$(dirname "${AIOS_SOURCE_DIR}")"
if [[ -d "${AIOS_SOURCE_DIR}/.git" ]]; then
  git -C "${AIOS_SOURCE_DIR}" remote set-url origin "${AIOS_SOURCE_REPO_URL}" || true
  git -C "${AIOS_SOURCE_DIR}" fetch --prune origin "${AIOS_SOURCE_BRANCH}"
  git -C "${AIOS_SOURCE_DIR}" reset --hard
  git -C "${AIOS_SOURCE_DIR}" clean -fdx
  git -C "${AIOS_SOURCE_DIR}" checkout -B "${AIOS_SOURCE_BRANCH}" "origin/${AIOS_SOURCE_BRANCH}"
  git -C "${AIOS_SOURCE_DIR}" reset --hard "origin/${AIOS_SOURCE_BRANCH}"
  git -C "${AIOS_SOURCE_DIR}" clean -fdx
else
  if [[ -e "${AIOS_SOURCE_DIR}" ]]; then
    backup_path="${AIOS_SOURCE_DIR}.bak.$(date +%s)"
    warn "${AIOS_SOURCE_DIR} exists but is not a git checkout; moving it to ${backup_path}"
    mv "${AIOS_SOURCE_DIR}" "${backup_path}"
  fi
  git clone --branch "${AIOS_SOURCE_BRANCH}" --single-branch "${AIOS_SOURCE_REPO_URL}" "${AIOS_SOURCE_DIR}"
fi

log "running VPS bootstrap"
bash "${AIOS_SOURCE_DIR}/scripts/vps-bootstrap.sh"

log "building and deploying AIOS"
AIOS_USER="${AIOS_USER}" \
AIOS_INSTALL_DIR="${AIOS_INSTALL_DIR}" \
bash "${AIOS_SOURCE_DIR}/scripts/deploy-app.sh"

log "enabling AIOS service"
systemctl enable --now aios

log "AIOS-VPS deployment complete"
log "open http://<vps-ip>:3100 to create the first admin"
