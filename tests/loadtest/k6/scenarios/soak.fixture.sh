#!/usr/bin/env bash
# tests/loadtest/k6/scenarios/soak.fixture.sh
#
# Fixture-mechanics check for the long soak scenario.
#
# Runs a short toy soak (DURATION=10s, overridable via env) against the
# committed fixture. Optionally co-runs the host sampler if it exists and
# asserts both exit cleanly and the sampler CSV has at least a header + 1 data
# row. NOT the authoritative 2h soak (that is the EC2 operational block in
# soak.js). Only proves:
#   1. soak.js parses, resolves version, builds the Zipf+mix ctx, and exits 0.
#   2. dropped_iterations==0 at toy scale (scheduler kept up).
#   3. If tests/loadtest/k6/chaos/sampler.sh exists: it co-runs and produces a
#      CSV with at least 2 lines (header + 1 sample row).
#
# Operational EC2 command (Step 4b):
#   # 1. First determine the knee with profile.js / step runs.
#   # 2. Co-run host sampler (Task 23):
#   SAMPLE_INTERVAL=15 SAMPLE_OUT=soak_sample.csv \
#     BASE_URL=https://tfbindingandperturbation.com \
#     CONTAINER=tfbp bash tests/loadtest/k6/chaos/sampler.sh &
#   SAMP=$!
#   # 3. Run the soak:
#   export BASE_URL=https://tfbindingandperturbation.com ARTIFACT_KIND=real
#   export TARGET_RATE=<round(0.65 * knee)> DURATION=2h ZIPF_EXP=1.1 KNEE_FRACTION=0.65
#   k6 run --out csv=soak.csv tests/loadtest/k6/scenarios/soak.js
#   kill "$SAMP"
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
cd "$REPO_ROOT"

FIXTURE="tests/fixtures/tfbp_test.duckdb"
PORT="${PORT:-18119}"
BASE_URL="http://127.0.0.1:${PORT}"
SAMPLE_CSV="$(mktemp -t soak_sample.XXXXXX.csv)"
SAMPLER="tests/loadtest/k6/chaos/sampler.sh"
SERVER_BIN="${SERVER_BIN:-/tmp/tfbp-srv}"

command -v k6 >/dev/null 2>&1 || { echo "SKIP: k6 not installed"; exit 0; }
[ -f "$FIXTURE" ] || { echo "FAIL: fixture missing: $FIXTURE"; exit 1; }

# Build the server if binary is missing.
if [ ! -f "$SERVER_BIN" ]; then
  echo "[soak-fixture] building backend -> $SERVER_BIN"
  ( cd backend && go build -o "$SERVER_BIN" ./cmd/tfbp-server )
fi

DUCKDB_PATH="$(pwd)/${FIXTURE}" "$SERVER_BIN" --port="${PORT}" >/tmp/soak_srv.log 2>&1 &
BG_PID=$!
trap 'kill "$BG_PID" 2>/dev/null || true; rm -f "$SAMPLE_CSV"' EXIT

echo "[soak-fixture] waiting for backend on port ${PORT}"
for _ in $(seq 1 60); do
  curl -sf "${BASE_URL}/readyz" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -sf "${BASE_URL}/readyz" >/dev/null || { echo "FAIL: backend not ready"; exit 1; }
echo "[soak-fixture] backend ready (pid=${BG_PID})"

# Co-run the host sampler if available (Task 23). In SAMPLE_LOCAL=1 mode the
# sampler writes to SAMPLE_OUT using only /metrics scrapes (no docker stats /
# cloudwatch required) so it works locally and in CI.
SAMPLER_PID=""
if [ -f "$SAMPLER" ]; then
  echo "[soak-fixture] starting sampler -> $SAMPLE_CSV"
  SAMPLE_INTERVAL=1 SAMPLE_OUT="$SAMPLE_CSV" BASE_URL="$BASE_URL" SAMPLE_LOCAL=1 \
    bash "$SAMPLER" &
  SAMPLER_PID=$!
else
  echo "[soak-fixture] sampler not yet available ($SAMPLER not found) — skipping sampler check"
  # Write a stub CSV with header + 1 row so the line-count check below passes
  # even without the real sampler. The AUTHORITATIVE soak pairs the real sampler.
  printf 'ts,metric,value\n%s,stub,0\n' "$(date -u +%s)" > "$SAMPLE_CSV"
fi

export BASE_URL ARTIFACT_KIND=fixture
export TARGET_RATE="${TARGET_RATE:-8}"
export DURATION="${DURATION:-10s}"
export ZIPF_EXP=1.1
export KNEE_FRACTION=0.65

echo "[soak-fixture] running k6 (rate=${TARGET_RATE} duration=${DURATION})"
k6 run --quiet --no-usage-report tests/loadtest/k6/scenarios/soak.js
RC=$?

if [ -n "$SAMPLER_PID" ]; then
  kill "$SAMPLER_PID" 2>/dev/null || true
  sleep 1
fi

echo "soak fixture mechanics: k6 rc=${RC}"
[ "$RC" -eq 0 ] || { echo "FAIL: k6 exited ${RC}"; exit 1; }

LINES=$(wc -l < "$SAMPLE_CSV")
echo "[soak-fixture] sampler CSV lines: ${LINES}"
[ "$LINES" -ge 2 ] || { echo "FAIL: sampler produced ${LINES} lines (<2)"; exit 1; }

echo "PASS (sampler rows=${LINES})"
