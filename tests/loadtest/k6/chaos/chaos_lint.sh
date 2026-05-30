#!/usr/bin/env bash
# chaos_lint.sh — local check for the chaos host scripts.
#
# Asserts each chaos script:
#   1. Exists.
#   2. Is executable.
#   3. Parses cleanly (bash -n).
#   4. Passes shellcheck (if installed).
#
# Then runs sampler.sh in SAMPLE_LOCAL=1 mode against a local fixture backend
# and asserts the CSV has a "ts," header and at least 2 lines (header + 1 row).
#
# The DESTRUCTIVE scripts (docker_kill/stop, temp_fill, oom_induce,
# corrupt_artifact) are NOT executed here — they are OPERATIONAL and require
# Docker/EC2.  Only syntax-checking is performed on them.
#
# Usage:
#   bash tests/loadtest/k6/chaos/chaos_lint.sh
#   PORT=18123 bash tests/loadtest/k6/chaos/chaos_lint.sh   # choose port
#
# SKIP conditions (no Docker/k6 dependency for the lint phase):
#   - If the fixture tfbp_test.duckdb is missing → FAIL (required for sampler smoke).
#   - If go build fails → FAIL.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
cd "$REPO_ROOT"

CHAOS="tests/loadtest/k6/chaos"
PORT="${PORT:-18123}"
BASE_URL="http://127.0.0.1:${PORT}"
FIXTURE="tests/fixtures/tfbp_test.duckdb"
SERVER_BIN="${SERVER_BIN:-/tmp/tfbp-srv}"

SCRIPTS=(docker_kill.sh docker_stop.sh temp_fill.sh oom_induce.sh sampler.sh corrupt_artifact.sh)

echo "=== chaos_lint.sh ==="
echo ""

# ---------------------------------------------------------------------------
# Phase 1: syntax + executable + shellcheck checks (no execution).
# ---------------------------------------------------------------------------
echo "--- phase 1: syntax, executable, shellcheck ---"
SC_AVAILABLE=0
if command -v shellcheck >/dev/null 2>&1; then
  SC_AVAILABLE=1
  echo "shellcheck: available ($(shellcheck --version | head -1))"
else
  echo "shellcheck: not installed — skipping shellcheck checks"
fi

for s in "${SCRIPTS[@]}"; do
  p="${CHAOS}/${s}"
  [ -f "$p" ]  || { echo "FAIL: missing ${p}"; exit 1; }
  [ -x "$p" ]  || { echo "FAIL: not executable ${p}"; exit 1; }
  bash -n "$p" || { echo "FAIL: syntax error in ${p}"; exit 1; }
  sc_result="n/a"
  if [ "$SC_AVAILABLE" -eq 1 ]; then
    if shellcheck -S warning "$p" 2>&1; then
      sc_result="ok"
    else
      sc_result="warnings (see above)"
    fi
  fi
  echo "ok: ${s}  (syntax=ok  executable=yes  shellcheck=${sc_result})"
done

# ---------------------------------------------------------------------------
# Phase 2: sampler.sh local-mode smoke test.
# ---------------------------------------------------------------------------
echo ""
echo "--- phase 2: sampler.sh SAMPLE_LOCAL=1 smoke test ---"

[ -f "$FIXTURE" ] || { echo "FAIL: fixture missing: $FIXTURE"; exit 1; }

# Build the server binary if it does not already exist.
if [ ! -f "$SERVER_BIN" ]; then
  echo "[chaos_lint] building backend -> ${SERVER_BIN}"
  ( cd backend && go build -o "$SERVER_BIN" ./cmd/tfbp-server )
fi

# Boot the fixture backend.
DUCKDB_PATH="$(pwd)/${FIXTURE}" "$SERVER_BIN" --port="${PORT}" >/tmp/chaos_lint_srv.log 2>&1 &
BG_PID=$!

CSV="$(mktemp -t chaos_sampler.XXXXXX.csv)"

cleanup() {
  kill "$BG_PID" 2>/dev/null || true
  rm -f "$CSV"
}
trap cleanup EXIT

# Wait for backend to be ready (up to 30 s).
for _ in $(seq 1 60); do
  curl -sf --max-time 2 "${BASE_URL}/readyz" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -sf --max-time 2 "${BASE_URL}/readyz" >/dev/null \
  || { echo "FAIL: fixture backend not ready on port ${PORT}"; exit 1; }
echo "[chaos_lint] fixture backend ready on port ${PORT} (pid=${BG_PID})"

# Run sampler for 2 ticks at 1-second cadence.
echo "[chaos_lint] running sampler (SAMPLE_LOCAL=1 SAMPLE_ITERATIONS=2 SAMPLE_INTERVAL=1)"
SAMPLE_LOCAL=1 SAMPLE_ITERATIONS=2 SAMPLE_INTERVAL=1 \
  SAMPLE_OUT="$CSV" BASE_URL="$BASE_URL" \
  bash "${CHAOS}/sampler.sh"

# Verify CSV header and row count.
head_line="$(head -1 "$CSV")"
total_lines="$(wc -l < "$CSV")"
echo "[chaos_lint] CSV header: ${head_line}"
echo "[chaos_lint] CSV total lines: ${total_lines}"

echo "$head_line" | grep -q '^ts,' \
  || { echo "FAIL: sampler CSV missing 'ts,' header (got: ${head_line})"; exit 1; }
[ "$total_lines" -ge 3 ] \
  || { echo "FAIL: sampler CSV has ${total_lines} lines (need >=3: header + 2 data rows)"; exit 1; }

echo ""
echo "PASS"
