#!/usr/bin/env bash
# Backup + restore the AIOS working set.
#
# Backed up:
#   - /home/aios/repo         (the operator's monorepo)
#   - /opt/aios/data          (sqlite db + config.json)
#   - /home/aios/.claude/     (Claude Code credentials)
#   - /home/aios/.codex/      (Codex credentials)
#   - /etc/caddy/Caddyfile    (domain + HTTPS config)
#   - /etc/systemd/system/aios.service
#
# Usage:
#   scripts/backup-restore.sh backup  <dest.tar.gz>
#   scripts/backup-restore.sh restore <src.tar.gz>

set -euo pipefail

AIOS_USER="${AIOS_USER:-aios}"
AIOS_HOME="${AIOS_HOME:-/home/${AIOS_USER}}"
AIOS_INSTALL_DIR="${AIOS_INSTALL_DIR:-/opt/aios}"

cmd="${1:-}"
target="${2:-}"

if [[ -z "$cmd" || -z "$target" ]]; then
  echo "usage: $0 [backup|restore] <path.tar.gz>" >&2
  exit 1
fi

PATHS=(
  "${AIOS_HOME}/repo"
  "${AIOS_INSTALL_DIR}/data"
  "${AIOS_HOME}/.claude"
  "${AIOS_HOME}/.codex"
  "${AIOS_HOME}/.claude.json"
  "/etc/caddy/Caddyfile"
  "/etc/systemd/system/aios.service"
)

case "$cmd" in
  backup)
    existing=()
    for p in "${PATHS[@]}"; do
      [[ -e "$p" ]] && existing+=("$p")
    done
    tar -czf "$target" "${existing[@]}"
    echo "wrote $target"
    ;;
  restore)
    if [[ ! -f "$target" ]]; then
      echo "no such file: $target" >&2
      exit 1
    fi
    systemctl stop aios  2>/dev/null || true
    systemctl stop caddy 2>/dev/null || true
    tar -xzf "$target" -C /
    systemctl daemon-reload
    systemctl start caddy 2>/dev/null || true
    systemctl start aios  2>/dev/null || true
    echo "restored from $target"
    ;;
  *)
    echo "unknown command: $cmd" >&2
    exit 1
    ;;
esac
