#!/usr/bin/env bash
# tests/loadtest/k6/scenarios/hitrate_curve.local.sh
#
# Local fixture-mechanics test for scenarios/hitrate_curve.js.
# Runs ONE short constant-arrival-rate point (single ZIPF_EXP) and asserts the
# scenario builds, resolves the version, drives a zipf keyspace, scrapes
# /metrics before+after, and emits the achieved-hit-rate + p95 row into a
# stamped summary. The AUTHORITATIVE multi-point sweep is operational (Step 3b).
#
# NOTE: handleSummary writes hitrate_curve.summary.json to CWD; this script
# runs k6 from a temp dir and checks that file. HITRATE_TOLERANCE=1.0 is
# passed so the ±3% convergence assertion does not fail on the tiny fixture
# keyspace (convergence is only meaningful with the real artifact).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE_URL="${BASE_URL:-http://127.0.0.1:8080}"

OUTDIR="$(mktemp -d)"
OUT="${OUTDIR}/hitrate_curve.summary.json"

curl -fsS "${BASE_URL}/api/version" >/dev/null || {
  echo "FAIL: no backend at ${BASE_URL}" >&2; exit 1; }

STDERR="$(mktemp)"
( cd "${OUTDIR}" && k6 run \
  -e BASE_URL="${BASE_URL}" \
  -e ARTIFACT_KIND=fixture \
  -e KEYSPACE_MODE=zipf \
  -e ZIPF_EXP=1.0 \
  -e HIT_RATE=0.8 \
  -e TARGET_RATE=5 \
  -e DURATION=10s \
  -e HITRATE_TOLERANCE=1.0 \
  "${HERE}/hitrate_curve.js" ) 2>"${STDERR}"

grep -q "ARTIFACT_KIND=fixture\|fixture" "${STDERR}" || {
  echo "FAIL: expected fixture warning on stderr" >&2; cat "${STDERR}" >&2; exit 1; }

test -s "${OUT}" || { echo "FAIL: summary not written" >&2; exit 1; }
grep -q '"artifactVersion"' "${OUT}" || { echo "FAIL: missing artifactVersion stamp" >&2; exit 1; }
grep -q '"zipfExp"' "${OUT}"        || { echo "FAIL: missing zipfExp stamp" >&2; exit 1; }
grep -q '"achievedHitRate"' "${OUT}" || { echo "FAIL: missing achievedHitRate row" >&2; exit 1; }
grep -q '"p95Ms"' "${OUT}"          || { echo "FAIL: missing p95-vs-hit-rate row" >&2; exit 1; }

echo "PASS: hitrate_curve.js wired up; row emitted at ${OUT}"
