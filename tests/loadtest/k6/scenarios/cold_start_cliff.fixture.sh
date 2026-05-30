#!/usr/bin/env bash
# tests/loadtest/k6/scenarios/cold_start_cliff.fixture.sh
#
# Fixture-mechanics check for the cold-start-cliff scenario.
#
# Validates that:
#   1. cold_start_cliff.js parses, runs both phases, and k6 exits 0.
#   2. The mid-run backend restart fires (SIGKILLs the first backend process and
#      starts a fresh one at the phase boundary), simulating the operational cliff.
#   3. k6 continues driving traffic through the restart window (503s may occur
#      during the brief restart gap; lenient ARTIFACT_KIND=fixture gates allow them).
#
# This is NOT the authoritative recovery gate (that is the EC2 operational block
# documented in cold_start_cliff.js). It only proves the scenario JS parses,
# both constant-arrival-rate phases run, and the mid-run restart hook fires.
# Runs against tests/fixtures/tfbp_test.duckdb.
#
# Operational EC2 restart block (Step 4b):
#   cd /opt/tfbp
#   export BASE_URL=https://tfbindingandperturbation.com ARTIFACT_KIND=real
#   export TARGET_RATE=15 PHASE1_DURATION=5m PHASE2_DURATION=10m
#   export ZIPF_EXP=1.1 RECOVERY_HIT_FLOOR=0.85
#   k6 run --out csv=cold_start_cliff.csv \
#     tests/loadtest/k6/scenarios/cold_start_cliff.js &
#   K6_PID=$!
#   sleep 300
#   docker compose restart tfbp
#   until curl -sf "$BASE_URL/readyz" >/dev/null; do sleep 1; done
#   wait "$K6_PID"
#   # Pass criteria: k6 exits 0 AND cold_start_cliff.summary.json shows
#   #   cacheHitRatePost >= 0.85, httpReqFailedRate == 0, readyzAvailableRate > 0.99.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
cd "$REPO_ROOT"

FIXTURE="tests/fixtures/tfbp_test.duckdb"
PORT="${PORT:-18118}"
BASE_URL="http://127.0.0.1:${PORT}"
SERVER_BIN="${SERVER_BIN:-/tmp/tfbp-srv}"

command -v k6 >/dev/null 2>&1 || { echo "SKIP: k6 not installed"; exit 0; }
[ -f "$FIXTURE" ] || { echo "FAIL: fixture missing: $FIXTURE"; exit 1; }

# Build the server if binary is missing.
if [ ! -f "$SERVER_BIN" ]; then
  echo "[cliff-fixture] building backend -> $SERVER_BIN"
  ( cd backend && go build -o "$SERVER_BIN" ./cmd/tfbp-server )
fi

start_backend() {
  DUCKDB_PATH="$(pwd)/${FIXTURE}" "$SERVER_BIN" --port="${PORT}" >/tmp/cliff_srv.log 2>&1 &
  echo $!
}

wait_ready() {
  local i
  for i in $(seq 1 60); do
    if curl -sf "${BASE_URL}/readyz" >/dev/null 2>&1; then return 0; fi
    sleep 0.5
  done
  echo "FAIL: backend never became ready on port ${PORT}"; return 1
}

BG_PID="$(start_backend)"
trap 'kill "$BG_PID" 2>/dev/null || true' EXIT
wait_ready

echo "[cliff-fixture] backend ready at ${BASE_URL} (pid=${BG_PID})"

# Toy scale — short phases and low rate so the whole fixture run takes ~25s.
# RECOVERY_HIT_FLOOR=0.0 so the post-phase cache gate never fails on the
# fixture (no real restart = no dip-then-recover; gate is disabled for mechanics).
export BASE_URL ARTIFACT_KIND=fixture
export TARGET_RATE=5
export PHASE1_DURATION=6s
export PHASE2_DURATION=10s
export ZIPF_EXP=1.1
export RECOVERY_HIT_FLOOR=0.0

echo "[cliff-fixture] launching k6 (PHASE1=${PHASE1_DURATION} PHASE2=${PHASE2_DURATION} rate=${TARGET_RATE})"

# Run k6 in the background so we can simulate the mid-run restart.
k6 run --quiet --no-usage-report \
  tests/loadtest/k6/scenarios/cold_start_cliff.js &
K6_PID=$!

# Mid-run restart: wait until phase-1 is ~halfway through, then SIGKILL the
# backend and restart it. This simulates the operational `docker compose restart`
# at the phase boundary.
# Phase-1 is 6s; wait 3s then restart so k6 is actively in phase-1 traffic.
sleep 3
echo "[cliff-fixture] simulating restart (SIGKILL pid=${BG_PID})"
kill -9 "$BG_PID" 2>/dev/null || true

# Brief gap — intentional; this is the "cliff" window where 503s may occur.
sleep 0.5

BG_PID="$(start_backend)"
trap 'kill "$BG_PID" 2>/dev/null || true' EXIT
echo "[cliff-fixture] restarted backend (new pid=${BG_PID})"
wait_ready
echo "[cliff-fixture] backend ready again"

# Wait for k6 to finish both phases.
wait "$K6_PID"
RC=$?

echo "cold_start_cliff fixture mechanics: k6 rc=${RC}"
[ "$RC" -eq 0 ] || { echo "FAIL: k6 exited ${RC}"; exit 1; }
echo "PASS"
