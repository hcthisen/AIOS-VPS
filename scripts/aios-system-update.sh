#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "--probe" ]]; then
  exit 0
fi

umask 022

STATUS_PATH="${AIOS_UPDATER_STATUS_PATH:?missing AIOS_UPDATER_STATUS_PATH}"
VERSION_PATH="${AIOS_UPDATER_VERSION_PATH:?missing AIOS_UPDATER_VERSION_PATH}"
LOG_PATH="${AIOS_UPDATER_LOG_PATH:?missing AIOS_UPDATER_LOG_PATH}"
SOURCE_DIR="${AIOS_UPDATER_SOURCE_DIR:?missing AIOS_UPDATER_SOURCE_DIR}"
REPO_URL="${AIOS_UPDATER_REPO_URL:?missing AIOS_UPDATER_REPO_URL}"
BRANCH="${AIOS_UPDATER_BRANCH:-main}"
AUTH_MODE="${AIOS_UPDATER_AUTH_MODE:-none}"
AIOS_USER="${AIOS_USER:-aios}"
AIOS_INSTALL_DIR="${AIOS_INSTALL_DIR:-/opt/aios}"

TMP_DIR=""
GIT_REMOTE_URL="${REPO_URL}"
PERSISTED_REMOTE_URL="${REPO_URL}"

mkdir -p "$(dirname "${STATUS_PATH}")" "$(dirname "${VERSION_PATH}")" "$(dirname "${LOG_PATH}")"
: > "${LOG_PATH}"

log_line() {
  printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "${LOG_PATH}" >/dev/null
}

write_status() {
  python3 - "$STATUS_PATH" "$@" <<'PY'
import json
import os
import sys
import time

path = sys.argv[1]
pairs = sys.argv[2:]
data = {}
try:
    with open(path, "r", encoding="utf-8") as handle:
        data = json.load(handle) or {}
except Exception:
    data = {}

for pair in pairs:
    key, value = pair.split("=", 1)
    if value == "__null__":
        data[key] = None
    elif value == "__true__":
        data[key] = True
    elif value == "__false__":
        data[key] = False
    elif value == "__now__":
        data[key] = int(time.time() * 1000)
    else:
        data[key] = value

with open(path, "w", encoding="utf-8") as handle:
    json.dump(data, handle, indent=2)
    handle.write("\n")
PY
}

cleanup() {
  if [[ -n "${TMP_DIR}" && -d "${TMP_DIR}" ]]; then
    rm -rf "${TMP_DIR}"
  fi
}

fail() {
  local message="$1"
  log_line "ERROR: ${message}"
  write_status \
    inProgress=__false__ \
    maintenance=__false__ \
    stage=failed \
    message="${message}" \
    lastError="${message}" \
    finishedAt=__now__
  cleanup
  exit 1
}

prepare_auth() {
  case "${AUTH_MODE}" in
    pat)
      local username="${AIOS_UPDATER_GITHUB_USERNAME:-}"
      local token="${AIOS_UPDATER_GITHUB_TOKEN:-}"
      if [[ -z "${username}" || -z "${token}" ]]; then
        fail "PAT auth requested but username/token were not provided"
      fi
      TMP_DIR="$(mktemp -d)"
      cat > "${TMP_DIR}/git-askpass.sh" <<'EOF'
#!/usr/bin/env bash
case "${1:-}" in
  *Username*) printf '%s\n' "${AIOS_UPDATER_GIT_USERNAME:-}" ;;
  *Password*) printf '%s\n' "${AIOS_UPDATER_GIT_PASSWORD:-}" ;;
  *) printf '\n' ;;
esac
EOF
      chmod 700 "${TMP_DIR}/git-askpass.sh"
      export GIT_ASKPASS="${TMP_DIR}/git-askpass.sh"
      export GIT_TERMINAL_PROMPT=0
      export AIOS_UPDATER_GIT_USERNAME="${username}"
      export AIOS_UPDATER_GIT_PASSWORD="${token}"
      ;;
    deploy_key)
      local key_path="${AIOS_UPDATER_DEPLOY_KEY_PATH:-}"
      if [[ -z "${key_path}" ]]; then
        fail "deploy-key auth requested but no private key path was provided"
      fi
      if [[ "${REPO_URL}" != http://* && "${REPO_URL}" != https://* ]]; then
        export GIT_SSH_COMMAND="ssh -i \"${key_path}\" -o StrictHostKeyChecking=accept-new"
      fi
      ;;
    none)
      ;;
    *)
      fail "unsupported auth mode: ${AUTH_MODE}"
      ;;
  esac
}

run_logged() {
  "$@" >> "${LOG_PATH}" 2>&1
}

schedule_aios_restart() {
  local unit="aios-post-update-restart-$(date +%s)"
  log_line "Scheduling AIOS service restart"
  if command -v systemd-run >/dev/null 2>&1; then
    if systemd-run --unit="${unit}" --description="Restart AIOS after system update" --on-active=2s /usr/bin/systemctl restart aios >> "${LOG_PATH}" 2>&1; then
      log_line "AIOS service restart scheduled via systemd-run (${unit})"
      return 0
    fi
    log_line "systemd-run scheduling failed; falling back to nohup"
  fi
  nohup /bin/sh -c 'sleep 2; /usr/bin/systemctl restart aios' >> "${LOG_PATH}" 2>&1 &
  log_line "AIOS service restart scheduled via nohup fallback"
}

prepare_auth
trap cleanup EXIT

write_status \
  inProgress=__true__ \
  maintenance=__true__ \
  stage=fetching \
  message="Updating AIOS-VPS source checkout" \
  lastError=__null__

log_line "Using source directory ${SOURCE_DIR}"
if [[ ! -d "${SOURCE_DIR}/.git" ]]; then
  mkdir -p "$(dirname "${SOURCE_DIR}")"
  log_line "Cloning ${REPO_URL} (${BRANCH})"
  run_logged git clone --branch "${BRANCH}" --single-branch "${GIT_REMOTE_URL}" "${SOURCE_DIR}" || fail "git clone failed"
else
  log_line "Fetching ${REPO_URL} (${BRANCH})"
  run_logged git -C "${SOURCE_DIR}" remote set-url origin "${PERSISTED_REMOTE_URL}" || fail "failed to set updater remote"
  run_logged git -C "${SOURCE_DIR}" fetch --prune origin "${BRANCH}" || fail "git fetch failed"
  run_logged git -C "${SOURCE_DIR}" checkout -B "${BRANCH}" "origin/${BRANCH}" || fail "failed to checkout ${BRANCH}"
  run_logged git -C "${SOURCE_DIR}" reset --hard "origin/${BRANCH}" || fail "failed to reset updater checkout"
  run_logged git -C "${SOURCE_DIR}" clean -fdx || fail "failed to clean updater checkout"
fi

log_line "Updater checkout ready at $(git -C "${SOURCE_DIR}" rev-parse --short HEAD 2>/dev/null || printf 'unknown')"

write_status \
  inProgress=__true__ \
  maintenance=__true__ \
  stage=bootstrapping \
  message="Applying system bootstrap changes"

run_logged bash "${SOURCE_DIR}/scripts/vps-bootstrap.sh" || fail "bootstrap failed"

write_status \
  inProgress=__true__ \
  maintenance=__true__ \
  stage=deploying \
  message="Deploying AIOS-VPS application"

run_logged env AIOS_USER="${AIOS_USER}" AIOS_INSTALL_DIR="${AIOS_INSTALL_DIR}" AIOS_DEPLOY_SKIP_RESTART=1 bash "${SOURCE_DIR}/scripts/deploy-app.sh" || fail "deploy failed"

write_status \
  inProgress=__false__ \
  maintenance=__false__ \
  stage=succeeded \
  message="System update complete" \
  lastError=__null__ \
  finishedAt=__now__

log_line "System update completed successfully"
schedule_aios_restart
