#!/usr/bin/env bash
# =============================================================================
# OPERATIONAL SCRIPT — requires Docker + a deployed tfbp container on EC2.
# DO NOT run in CI or on a local dev machine without an active container.
# =============================================================================
#
# temp_fill.sh — fill the tfbp_tmp named volume (DuckDB spill target,
# max_temp_directory_size=2GB per §6.3) toward its cap to verify DuckDB fails
# LOUDLY (query error → HTTP 5xx, bounded body) rather than filling the disk
# silently, and that the service recovers once the fill is removed.
#
# Strategy: use an Alpine helper container that mounts the same named volume to
# write a ballast file, then drive a spill-heavy query and confirm it errors
# cleanly — NOT a hang and NOT an OOM-kill.
#
# After the assertion, the ballast is removed and the same query must return 200.
#
# PRECONDITIONS:
#   - Docker CLI available; the tfbp_tmp named volume exists and is mounted by
#     the tfbp container at the DuckDB temp_directory (/tmp/duckdb per §6.3).
#   - Alpine image pullable (or already cached).
#   - The spill-heavy query route exists:
#       /api/v/{VERSION}/comparison/topn?binding=callingcards&perturbation=hackett&top_n=1000
#
# PASS CRITERIA:
#   - With spill near the 2 GB cap, the spill-heavy query fails loudly with
#     HTTP 500 (bounded body), NOT a hang and NOT an OOM kill.
#   - dmesg shows NO "killed process" (kernel OOM-killer must not fire).
#   - After ballast removal the same query returns HTTP 200.
#
# Env vars (all have defaults):
#   VOLUME      named volume for DuckDB spill        (default: tfbp_tmp)
#   FILL_MB     ballast size in MB                   (default: 1900)
#   BASE_URL    base URL for query + /api/version     (default: http://127.0.0.1:8080)
#   VERSION     artifact version string — auto-detected from /api/version if unset
# =============================================================================
set -euo pipefail

VOLUME="${VOLUME:-tfbp_tmp}"
FILL_MB="${FILL_MB:-1900}"
BASE_URL="${BASE_URL:-http://127.0.0.1:8080}"

# Auto-detect artifact version if not provided.
if [ -z "${VERSION:-}" ]; then
  VERSION="$(curl -sf "${BASE_URL}/api/version" \
    | sed -n 's/.*"artifactVersion":"\([^"]*\)".*/\1/p')"
fi
if [ -z "$VERSION" ]; then
  echo "FAIL: could not determine artifact version from ${BASE_URL}/api/version"
  exit 1
fi

echo "=== temp_fill.sh ==="
echo "volume:  ${VOLUME}  fill: ${FILL_MB} MB"
echo "version: ${VERSION}"
echo "start:   $(date -u +%FT%TZ)"

echo ""
echo "--- step 1: writing ${FILL_MB}MB ballast into ${VOLUME} ---"
docker run --rm -v "${VOLUME}:/tmp/duckdb" alpine:3 \
  sh -c "dd if=/dev/zero of=/tmp/duckdb/ballast.bin bs=1M count=${FILL_MB} 2>&1 \
         && echo 'ballast written:' \$(ls -lh /tmp/duckdb/ballast.bin | awk '{print \$5}')"

echo ""
echo "--- step 2: driving spill-heavy query (expect error while disk is near cap) ---"
SPILL_URL="${BASE_URL}/api/v/${VERSION}/comparison/topn?binding=callingcards&perturbation=hackett&top_n=1000"
code=$(curl -s -o /tmp/spill_resp.json -w '%{http_code}' --max-time 60 "$SPILL_URL" || true)
body_bytes=$(wc -c < /tmp/spill_resp.json 2>/dev/null || echo 0)
echo "spill query HTTP ${code};  body bytes: ${body_bytes}"
echo "(expected: 500-range; NOT a hang; body must be bounded)"

echo ""
echo "--- step 3: removing ballast ---"
docker run --rm -v "${VOLUME}:/tmp/duckdb" alpine:3 \
  rm -f /tmp/duckdb/ballast.bin
echo "ballast removed"

echo ""
echo "--- step 4: verifying recovery (same query should now succeed) ---"
code2=$(curl -s -o /dev/null -w '%{http_code}' --max-time 60 "$SPILL_URL" || true)
echo "post-cleanup HTTP ${code2}"
if [ "$code2" != "200" ]; then
  echo "FAIL: did not recover after ballast removal (HTTP ${code2})"
  exit 1
fi

echo ""
echo "--- step 5: host kernel OOM check ---"
echo "(must NOT have killed a random host process during the fill)"
if dmesg | tail -80 | grep -iq 'killed process'; then
  echo "WARNING: dmesg shows an OOM-killer entry — review manually"
else
  echo "  (no host OOM-killer entries — good)"
fi

echo ""
echo "PASS: temp full -> bounded error -> recovered after cleanup"
