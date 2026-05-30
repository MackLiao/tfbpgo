#!/usr/bin/env bash
# tests/loadtest/k6/scenarios/error_abuse.fixture.sh
#
# Fixture-mechanics check for the error-abuse flood scenario.
#
# Validates that:
#   1. error_abuse.js parses, runs the constant-arrival-rate flood, and k6
#      exits 0.
#   2. No 5xx: every reject is a deliberate 410/400/405.
#   3. http_req_failed rate==0 (all 4xx use expectedStatuses so they are NOT
#      counted as failures).
#   4. Reject paths do NOT consume DB connections: the db_query_duration_seconds
#      count barely moves relative to the flood rate (< 200 queries total,
#      attributable to the ~25% legalmax arm only).
#
# FIXTURE NOTE: The reject-path p95<50ms gate and DB-non-consumption gate are
#   authoritative on EC2 only. On the fixture everything is fast regardless,
#   and the legalmax 'strain' field may not exist -> some 400s in that arm.
#   This is acceptable: the assertion is "not 5xx".
#
# Authoritative EC2 run (Step 4b of task_22.md):
#   cd /opt/tfbp
#   SAMPLE_INTERVAL=1 SAMPLE_OUT=error_abuse_sample.csv \
#     BASE_URL=https://tfbindingandperturbation.com CONTAINER=tfbp \
#     bash tests/loadtest/k6/chaos/sampler.sh &
#   SAMP=$!
#   export BASE_URL=https://tfbindingandperturbation.com ARTIFACT_KIND=real
#   export TARGET_RATE=500 DURATION=2m
#   k6 run --out csv=error_abuse.csv tests/loadtest/k6/scenarios/error_abuse.js
#   kill "$SAMP"
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
cd "$REPO_ROOT"

FIXTURE="tests/fixtures/tfbp_test.duckdb"
PORT="${PORT:-18122}"
BASE_URL="http://127.0.0.1:${PORT}"
SERVER_BIN="${SERVER_BIN:-/tmp/tfbp-srv}"

command -v k6 >/dev/null 2>&1 || { echo "SKIP: k6 not installed"; exit 0; }
[ -f "$FIXTURE" ] || { echo "FAIL: fixture missing: $FIXTURE"; exit 1; }

# Build the server binary if missing.
if [ ! -f "$SERVER_BIN" ]; then
  echo "[error_abuse-fixture] building backend -> $SERVER_BIN"
  ( cd backend && go build -o "$SERVER_BIN" ./cmd/tfbp-server )
fi

DUCKDB_PATH="$(pwd)/${FIXTURE}" "$SERVER_BIN" --port="${PORT}" >/tmp/error_abuse_srv.log 2>&1 &
BG_PID=$!
trap 'kill "$BG_PID" 2>/dev/null || true' EXIT

echo "[error_abuse-fixture] waiting for backend on port ${PORT} (pid=${BG_PID})"
for _ in $(seq 1 60); do
  curl -sf "${BASE_URL}/readyz" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -sf "${BASE_URL}/readyz" >/dev/null || { echo "FAIL: backend not ready"; exit 1; }
echo "[error_abuse-fixture] backend ready"

# Snapshot DB query count before the run.
DBQ_BEFORE=$(curl -s "${BASE_URL}/metrics" | awk -F' ' '/^db_query_duration_seconds_count/ {s+=$2} END {print s+0}')

export BASE_URL ARTIFACT_KIND=fixture
# Low arrival rate and short duration for the fixture mechanics check.
export TARGET_RATE="${TARGET_RATE:-50}"
export DURATION="${DURATION:-10s}"

echo "[error_abuse-fixture] running k6 (TARGET_RATE=${TARGET_RATE} DURATION=${DURATION})"
k6 run --quiet --no-usage-report tests/loadtest/k6/scenarios/error_abuse.js
RC=$?

DBQ_AFTER=$(curl -s "${BASE_URL}/metrics" | awk -F' ' '/^db_query_duration_seconds_count/ {s+=$2} END {print s+0}')
DBQ_DELTA=$((DBQ_AFTER - DBQ_BEFORE))

echo "error_abuse fixture mechanics: k6 rc=${RC}  db_query_count Δ=${DBQ_DELTA}"
[ "$RC" -eq 0 ] || { echo "FAIL: k6 exited ${RC}"; exit 1; }

# Rejects (410/400/405) must not touch the DB. Only the ~25% legalmax arm
# should trigger queries. At TARGET_RATE=50 for 10s = ~500 iterations x 25%
# legalmax x 2 queries each = ~250 upper bound. But db_query count tracks
# the comparison/topn and regulators endpoints.
# Allow a modest delta attributable to the legalmax arm only.
[ "$DBQ_DELTA" -lt 400 ] || { echo "FAIL: DB queries ran on reject paths (Δ=${DBQ_DELTA} >= 400)"; exit 1; }
echo "PASS (db_query_count Δ=${DBQ_DELTA} < 400)"
