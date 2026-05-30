#!/usr/bin/env bash
# tests/loadtest/k6/scenarios/arrival_slo.local.sh
#
# Local fixture-mechanics test for scenarios/arrival_slo.js.
# Validates the scenario WIRES UP (open model executor builds, libs import,
# version resolves, handleSummary writes a stamped summary) — NOT the SLO itself.
# The authoritative SLO run is operational on EC2 (see the (operational) block
# in Step 3b). Requires: k6 on PATH and a fixture-backed backend on BASE_URL.
#
# NOTE: --summary-export writes k6's built-in metric JSON, which does NOT include
# custom Rate metrics or handleSummary keys in k6 v2. The authoritative stamped
# JSON is written by handleSummary to arrival_slo.summary.json in the CWD.
# This script checks that file.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE_URL="${BASE_URL:-http://127.0.0.1:8080}"

# arrival_slo.summary.json is written to CWD by handleSummary.
OUTDIR="$(mktemp -d)"
OUT="${OUTDIR}/arrival_slo.summary.json"

echo "[local] probing backend at ${BASE_URL}/api/version"
curl -fsS "${BASE_URL}/api/version" >/dev/null || {
  echo "FAIL: no backend at ${BASE_URL}. Start one: (cd backend && go run ./cmd/tfbp-server --duckdb=../tests/fixtures/tfbp_test.duckdb --port=8080)" >&2
  exit 1
}

# Tiny step rates + short holds so the whole thing runs in well under a minute.
# WARM unset (cold mechanics path); ARTIFACT_KIND defaults to fixture, which
# MUST emit the fixture warning to stderr.
STDERR="$(mktemp)"
# Run from OUTDIR so handleSummary writes arrival_slo.summary.json there.
( cd "${OUTDIR}" && k6 run \
  -e BASE_URL="${BASE_URL}" \
  -e ARTIFACT_KIND=fixture \
  -e RATES="2,4" \
  -e STEP_HOLD="3s" \
  -e RAMP="2s" \
  -e PREALLOC_VUS="10" \
  -e MAX_VUS="40" \
  -e READYZ_RATE="1" \
  "${HERE}/arrival_slo.js" ) 2>"${STDERR}"

echo "[local] asserting fixture warning was emitted to stderr"
grep -q "ARTIFACT_KIND=fixture" "${STDERR}" || {
  echo "FAIL: expected fixture warning on stderr" >&2; cat "${STDERR}" >&2; exit 1; }

echo "[local] asserting summary written + stamped with version + artifactKind"
test -s "${OUT}" || { echo "FAIL: summary not written to ${OUT}" >&2; exit 1; }
grep -q '"artifactVersion"' "${OUT}" || { echo "FAIL: summary missing artifactVersion stamp" >&2; exit 1; }
grep -q '"artifactKind"' "${OUT}"    || { echo "FAIL: summary missing artifactKind stamp" >&2; exit 1; }
grep -q '"readyz_available"' "${OUT}" || { echo "FAIL: summary missing readyz_available probe metric" >&2; exit 1; }

echo "PASS: arrival_slo.js wired up; summary stamped at ${OUT}"
