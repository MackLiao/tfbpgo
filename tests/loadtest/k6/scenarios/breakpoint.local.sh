#!/usr/bin/env bash
# tests/loadtest/k6/scenarios/breakpoint.local.sh
#
# Local fixture-mechanics test for scenarios/breakpoint.js. Drives a tiny ramp
# (nowhere near the real t3.small knee) purely to prove the scenario builds,
# the teardown scrapes /metrics deltas (db_pool_in_use peak, pool-wait
# counter-pair, go_goroutines, cache_misses) and emits a stamped summary with
# knee/cliff/mode fields. The AUTHORITATIVE run is operational (Step 3b).
#
# NOTE: handleSummary writes breakpoint.summary.json to CWD; this script
# runs k6 from a temp dir and checks that file.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE_URL="${BASE_URL:-http://127.0.0.1:8080}"

OUTDIR="$(mktemp -d)"
OUT="${OUTDIR}/breakpoint.summary.json"

curl -fsS "${BASE_URL}/api/version" >/dev/null || {
  echo "FAIL: no backend at ${BASE_URL}" >&2; exit 1; }

STDERR="$(mktemp)"
( cd "${OUTDIR}" && k6 run \
  -e BASE_URL="${BASE_URL}" \
  -e ARTIFACT_KIND=fixture \
  -e KEYSPACE_MODE=uniform \
  -e RATES="2,4,6" \
  -e STEP_HOLD="4s" \
  -e RAMP="2s" \
  -e PREALLOC_VUS="10" \
  -e MAX_VUS="50" \
  "${HERE}/breakpoint.js" ) 2>"${STDERR}"

test -s "${OUT}" || { echo "FAIL: summary not written" >&2; exit 1; }
grep -q '"artifactVersion"' "${OUT}" || { echo "FAIL: missing artifactVersion stamp" >&2; exit 1; }
grep -q '"artifactKind"' "${OUT}"    || { echo "FAIL: missing artifactKind stamp" >&2; exit 1; }
grep -q '"degradationMode"' "${OUT}" || { echo "FAIL: missing degradationMode classification" >&2; exit 1; }
grep -q '"dbPoolInUsePeak"' "${OUT}" || { echo "FAIL: missing db_pool_in_use peak" >&2; exit 1; }
grep -q '"poolWaitMeanMs"' "${OUT}"  || { echo "FAIL: missing pool-wait counter-pair mean" >&2; exit 1; }

echo "PASS: breakpoint.js wired up; teardown deltas + mode emitted at ${OUT}"
