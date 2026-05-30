#!/usr/bin/env bash
# =============================================================================
# OPERATIONAL SCRIPT — requires Docker + a running tfbp container on EC2.
# DO NOT run in CI or on a local dev machine without an active container.
# =============================================================================
#
# docker_stop.sh — SIGTERM (graceful) the tfbp container with a drain timeout,
# then start it back and poll /readyz.
#
# Contrast with docker_kill.sh (SIGKILL):
#   SIGTERM lets the Go server drain in-flight requests via its HTTP shutdown
#   handler; in-flight requests should COMPLETE (no client-visible 502 /
#   connection-reset) rather than being severed mid-response.
#
# Best run alongside a constant-arrival-rate k6 scenario so you can confirm
# that http_req_failed stays 0 across the drain window:
#   k6 run --out csv=stop_impact.csv tests/loadtest/k6/scenarios/soak.js &
#   K6=$!
#   bash tests/loadtest/k6/chaos/docker_stop.sh
#   kill "$K6"
#
# PRECONDITIONS:
#   - Docker CLI + docker compose plugin available.
#   - docker-compose.yml deployed; CONTAINER service exists.
#   - The Go server registers a graceful shutdown handler (os.Signal → server.Shutdown).
#
# PASS CRITERIA:
#   - With a co-running load generator, http_req_failed stays 0 across the drain.
#   - /readyz returns 200 within READY_TIMEOUT seconds of the stop+start.
#   - No manual intervention required.
#
# Env vars (all have defaults):
#   CONTAINER      compose service name             (default: tfbp)
#   BASE_URL       base URL for /readyz polling     (default: http://127.0.0.1:8080)
#   DRAIN_TIMEOUT  seconds for docker stop -t       (default: 30)
#   READY_TIMEOUT  max seconds to wait for recovery (default: 120)
# =============================================================================
set -euo pipefail

CONTAINER="${CONTAINER:-tfbp}"
BASE_URL="${BASE_URL:-http://127.0.0.1:8080}"
DRAIN_TIMEOUT="${DRAIN_TIMEOUT:-30}"
READY_TIMEOUT="${READY_TIMEOUT:-120}"

echo "=== docker_stop.sh ==="
echo "container: ${CONTAINER}"
echo "stop time: $(date -u +%FT%TZ)  drain_timeout=${DRAIN_TIMEOUT}s"
t0=$(date +%s)

docker compose stop -t "$DRAIN_TIMEOUT" "$CONTAINER"
echo "SIGTERM+drain complete; starting ${CONTAINER} back..."

docker compose start "$CONTAINER"
echo "start issued; polling ${BASE_URL}/readyz (timeout ${READY_TIMEOUT}s)..."

deadline=$(( t0 + READY_TIMEOUT ))
while ! curl -sf --max-time 3 "${BASE_URL}/readyz" >/dev/null 2>&1; do
  now=$(date +%s)
  if [ "$now" -ge "$deadline" ]; then
    echo "FAIL: /readyz not green within ${READY_TIMEOUT}s after graceful stop+start"
    exit 1
  fi
  sleep 1
done

t1=$(date +%s)
recovery=$(( t1 - t0 ))
echo "PASS: /readyz green ${recovery}s after graceful stop+start  (drain=${DRAIN_TIMEOUT}s)"
