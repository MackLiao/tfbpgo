#!/usr/bin/env bash
# tests/loadtest/k6/scenarios/oversize.fixture.sh
#
# Fixture-mechanics check for the oversize/admission-rejection/eviction-pressure
# scenario.
#
# Validates that:
#   1. oversize.js parses, runs both phases (repeat_large + walk_distinct), and
#      k6 exits 0.
#   2. The metrics-parse helpers can read cache_admission_rejected_total,
#      cache_oversize_responses_total, cache_evictions_total, and
#      http_response_bytes_bucket without error.
#   3. All HTTP responses are 200 (http_req_failed rate==0 threshold).
#
# FIXTURE REALITY: The committed test fixture produces responses of a few KB.
# The per-item oversize threshold on the real artifact is budget/20 ≈ 6.4 MB
# (128 MB cache). On the fixture neither oversize nor evictions can fire.
# This script does NOT assert oversize > 0 or evictions > 0 — those checks are
# real-artifact-only. The mechanics run verifies the scenario RUNS clean.
#
# Authoritative EC2 run (Step 4b of task_20.md):
#   cd /opt/tfbp
#   export BASE_URL=https://tfbindingandperturbation.com ARTIFACT_KIND=real
#   export PHASE1_ITERS=300 PHASE2_KEYS=50
#   k6 run --out csv=oversize.csv tests/loadtest/k6/scenarios/oversize.js
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
cd "$REPO_ROOT"

FIXTURE="tests/fixtures/tfbp_test.duckdb"
PORT="${PORT:-18120}"
BASE_URL="http://127.0.0.1:${PORT}"
SERVER_BIN="${SERVER_BIN:-/tmp/tfbp-srv}"

command -v k6 >/dev/null 2>&1 || { echo "SKIP: k6 not installed"; exit 0; }
[ -f "$FIXTURE" ] || { echo "FAIL: fixture missing: $FIXTURE"; exit 1; }

# Build the server binary if missing.
if [ ! -f "$SERVER_BIN" ]; then
  echo "[oversize-fixture] building backend -> $SERVER_BIN"
  ( cd backend && go build -o "$SERVER_BIN" ./cmd/tfbp-server )
fi

DUCKDB_PATH="$(pwd)/${FIXTURE}" "$SERVER_BIN" --port="${PORT}" >/tmp/oversize_srv.log 2>&1 &
BG_PID=$!
trap 'kill "$BG_PID" 2>/dev/null || true' EXIT

echo "[oversize-fixture] waiting for backend on port ${PORT} (pid=${BG_PID})"
for _ in $(seq 1 60); do
  curl -sf "${BASE_URL}/readyz" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -sf "${BASE_URL}/readyz" >/dev/null || { echo "FAIL: backend not ready"; exit 1; }
echo "[oversize-fixture] backend ready"

export BASE_URL ARTIFACT_KIND=fixture
# Short iterations so the fixture mechanics run completes in ~15s.
export PHASE1_ITERS="${PHASE1_ITERS:-20}"
export PHASE2_KEYS="${PHASE2_KEYS:-12}"

echo "[oversize-fixture] running k6 (PHASE1_ITERS=${PHASE1_ITERS} PHASE2_KEYS=${PHASE2_KEYS})"
k6 run --quiet --no-usage-report tests/loadtest/k6/scenarios/oversize.js
RC=$?

echo "oversize fixture mechanics: k6 rc=${RC}"
[ "$RC" -eq 0 ] || { echo "FAIL: k6 exited ${RC}"; exit 1; }
echo "PASS"
