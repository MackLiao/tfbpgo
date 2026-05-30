#!/usr/bin/env bash
# =============================================================================
# OPERATIONAL SCRIPT — requires Docker + a running tfbp container on EC2.
# DO NOT run in CI or on a local dev machine without an active container.
# =============================================================================
#
# docker_kill.sh — SIGKILL the tfbp container (ungraceful, simulates a crash /
# OOM-kill), then poll /readyz until the orchestrator restarts it (via
# restart: unless-stopped in docker-compose.yml).  Measures recovery time to
# green.
#
# Pair with cold_start_cliff.js running against the same host to capture the
# client-visible impact of the kill:
#   k6 run --out csv=kill_impact.csv tests/loadtest/k6/scenarios/cold_start_cliff.js &
#   K6=$!
#   bash tests/loadtest/k6/chaos/docker_kill.sh
#   kill "$K6"
#
# PRECONDITIONS:
#   - Docker CLI available and authenticated (or socket accessible).
#   - docker-compose.yml deployed with restart: unless-stopped for the tfbp service.
#   - CONTAINER service or container name is running.
#   - BASE_URL resolves to the tfbp HTTP listener (usually http://127.0.0.1:8080
#     on the EC2 host; or https://tfbindingandperturbation.com behind Traefik).
#
# PASS CRITERIA:
#   - /readyz returns 200 within READY_TIMEOUT seconds of the SIGKILL.
#   - The startup fail-fast log (§9.5) re-emits startup_ok (artifact unchanged).
#   - No manual intervention required; orchestrator restarts automatically.
#
# Env vars (all have defaults):
#   CONTAINER      compose service / container name   (default: tfbp)
#   BASE_URL       base URL for /readyz polling       (default: http://127.0.0.1:8080)
#   READY_TIMEOUT  max seconds to wait for recovery   (default: 120)
# =============================================================================
set -euo pipefail

CONTAINER="${CONTAINER:-tfbp}"
BASE_URL="${BASE_URL:-http://127.0.0.1:8080}"
READY_TIMEOUT="${READY_TIMEOUT:-120}"

# Resolve container id — try compose first, fall back to plain docker ps.
cid="$(docker compose ps -q "$CONTAINER" 2>/dev/null || true)"
if [ -z "$cid" ]; then
  cid="$(docker ps -qf "name=${CONTAINER}" 2>/dev/null || true)"
fi
if [ -z "$cid" ]; then
  echo "FAIL: no running container found for service/name '${CONTAINER}'"
  exit 1
fi

echo "=== docker_kill.sh ==="
echo "container: ${CONTAINER} (id=${cid})"
echo "kill time: $(date -u +%FT%TZ)"
t0=$(date +%s)

docker kill --signal=KILL "$cid"
echo "SIGKILL sent; polling ${BASE_URL}/readyz (timeout ${READY_TIMEOUT}s)..."

deadline=$(( t0 + READY_TIMEOUT ))
while ! curl -sf --max-time 3 "${BASE_URL}/readyz" >/dev/null 2>&1; do
  now=$(date +%s)
  if [ "$now" -ge "$deadline" ]; then
    echo "FAIL: /readyz not green within ${READY_TIMEOUT}s after SIGKILL"
    exit 1
  fi
  sleep 1
done

t1=$(date +%s)
recovery=$(( t1 - t0 ))
echo "PASS: /readyz green ${recovery}s after SIGKILL"
