#!/usr/bin/env bash
# shvix e2e — diagnose-only smoke test against a real Ollama+daemon.
# Exit 0 = passed. Exit 77 = SKIP (Ollama or model missing). Other = failure.
set -euo pipefail

start_ts=$(date +%s)
SHVIX_PORT="${SHVIX_PORT:-7749}"
HEALTH_URL="http://localhost:${SHVIX_PORT}/health"
CLASSIFY_URL="http://localhost:${SHVIX_PORT}/classify"
MODEL="${SHVIX_MODEL:-gemma4:e4b}"
OLLAMA_URL="${SHVIX_OLLAMA_URL:-http://localhost:11434}"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PIDFILE="${HOME}/.shvix/daemon.pid"

log() { printf '[e2e] %s\n' "$*" >&2; }

# Stop the Python daemon via the CLI (which reads the pidfile), not via the
# launcher PID — the `node ... daemon` process exits as soon as the daemon
# is healthy, so $! on it goes stale and would leak the real daemon.
cleanup() {
  if [ -f "${PIDFILE}" ]; then
    log "stopping daemon"
    node "${REPO_ROOT}/shvix/dist/cli.js" daemon stop >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

# Pre-flight
command -v node    >/dev/null || { log "node not installed"; exit 1; }
command -v python3 >/dev/null || { log "python3 not installed"; exit 1; }
command -v jq      >/dev/null || { log "jq not installed"; exit 1; }
command -v curl    >/dev/null || { log "curl not installed"; exit 1; }
command -v ollama  >/dev/null || { log "ollama not installed; e2e requires Ollama"; exit 77; }

log "compiling cli.ts"
( cd "${REPO_ROOT}/shvix" && npx tsc )

log "checking ollama reachable at ${OLLAMA_URL}"
curl -fsS "${OLLAMA_URL}/api/tags" >/dev/null 2>&1 || { log "ollama not running"; exit 77; }

log "checking model ${MODEL} pulled"
if ! curl -fsS "${OLLAMA_URL}/api/tags" | jq -e --arg m "${MODEL}" '.models[]?.name | select(. == $m or startswith($m + ":"))' >/dev/null; then
  log "model ${MODEL} not pulled (ollama pull ${MODEL})"
  exit 77
fi

log "starting daemon"
node "${REPO_ROOT}/shvix/dist/cli.js" daemon >/dev/null 2>&1

log "waiting for /health (up to 60s)"
for i in $(seq 1 60); do
  if curl -fsS "${HEALTH_URL}" 2>/dev/null | jq -e '.ollama_reachable == true' >/dev/null 2>&1; then
    log "daemon healthy after ${i}s"
    break
  fi
  sleep 1
  if [ "${i}" = "60" ]; then log "daemon failed to come up"; exit 1; fi
done

log "POST /classify"
RESP=$(curl -fsS -X POST "${CLASSIFY_URL}" \
  -H 'content-type: application/json' \
  -d '{"symptom":"my session is frozen","candidates":["frozen-pty","lockfile-stuck","session-corrupted","port-conflict"]}')
CLASSIFICATION=$(printf '%s' "${RESP}" | jq -r '.classification')
log "classification=${CLASSIFICATION}"

case "${CLASSIFICATION}" in
  frozen-pty|lockfile-stuck|session-corrupted|port-conflict|unknown) ;;
  *) log "unexpected classification: ${CLASSIFICATION}"; exit 1 ;;
esac

log "stopping daemon"
node "${REPO_ROOT}/shvix/dist/cli.js" daemon stop >/dev/null 2>&1 || true

if [ -f "${PIDFILE}" ]; then log "pid file still present at ${PIDFILE}"; exit 1; fi

elapsed=$(( $(date +%s) - start_ts ))
log "e2e PASSED in ${elapsed}s"
