#!/usr/bin/env bash
# tests/loadtest/k6/scenarios/export_contention.fixture.sh
#
# Fixture-mechanics check for the export-contention starvation-guard scenario.
#
# Validates that:
#   1. export_contention.js parses, all three executor roles start, and k6
#      exits 0.
#   2. VU A gets 200 on its export; VU B gets 200 or 408 (both acceptable on
#      the fixture since exports complete in < 1 ms).
#   3. JSON co-traffic (role C) stays 200 (http_req_failed{role:C}==0).
#
# FIXTURE REALITY: The committed test fixture produces exports of ~1-2 KB that
#   complete in under 1 ms. VU B fires 1 s after A; by that time A's export is
#   long done and the semaphore is released, so B also gets 200. The 408 path
#   (semaphore timeout) and the p95-hold gate are ARTIFACT_KIND=real-gated.
#   EXPECT_408 is set to 0 here so the export_queue_408 threshold is >=0 (no
#   failure on fixture).
#
# Authoritative EC2 run (Step 4b of task_21.md):
#   cd /opt/tfbp
#   SAMPLE_INTERVAL=1 SAMPLE_OUT=export_contention_sample.csv \
#     BASE_URL=https://tfbindingandperturbation.com CONTAINER=tfbp \
#     bash tests/loadtest/k6/chaos/sampler.sh &
#   SAMP=$!
#   export BASE_URL=https://tfbindingandperturbation.com ARTIFACT_KIND=real
#   export EXPECT_408=1 DURATION=3m
#   k6 run --out csv=export_contention.csv \
#     tests/loadtest/k6/scenarios/export_contention.js
#   kill "$SAMP"
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
cd "$REPO_ROOT"

FIXTURE="tests/fixtures/tfbp_test.duckdb"
PORT="${PORT:-18121}"
BASE_URL="http://127.0.0.1:${PORT}"
SERVER_BIN="${SERVER_BIN:-/tmp/tfbp-srv}"

command -v k6 >/dev/null 2>&1 || { echo "SKIP: k6 not installed"; exit 0; }
[ -f "$FIXTURE" ] || { echo "FAIL: fixture missing: $FIXTURE"; exit 1; }

# Build the server binary if missing.
if [ ! -f "$SERVER_BIN" ]; then
  echo "[export_contention-fixture] building backend -> $SERVER_BIN"
  ( cd backend && go build -o "$SERVER_BIN" ./cmd/tfbp-server )
fi

DUCKDB_PATH="$(pwd)/${FIXTURE}" "$SERVER_BIN" --port="${PORT}" >/tmp/export_contention_srv.log 2>&1 &
BG_PID=$!
trap 'kill "$BG_PID" 2>/dev/null || true' EXIT

echo "[export_contention-fixture] waiting for backend on port ${PORT} (pid=${BG_PID})"
for _ in $(seq 1 60); do
  curl -sf "${BASE_URL}/readyz" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -sf "${BASE_URL}/readyz" >/dev/null || { echo "FAIL: backend not ready"; exit 1; }
echo "[export_contention-fixture] backend ready"

# EXPECT_408=0: on the fixture exports complete in < 1 ms; B always 200.
# The 408 + p95-hold assertions are the operational gate (ARTIFACT_KIND=real).
export BASE_URL ARTIFACT_KIND=fixture
export EXPECT_408=0
export DURATION="${DURATION:-15s}"

echo "[export_contention-fixture] running k6 (DURATION=${DURATION} EXPECT_408=${EXPECT_408})"
k6 run --quiet --no-usage-report tests/loadtest/k6/scenarios/export_contention.js
RC=$?

echo "export_contention fixture mechanics: k6 rc=${RC}"
[ "$RC" -eq 0 ] || { echo "FAIL: k6 exited ${RC}"; exit 1; }
echo "PASS"
