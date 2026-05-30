#!/usr/bin/env bash
# =============================================================================
# OPERATIONAL SCRIPT — requires Docker + a deployed tfbp container on EC2.
# DO NOT run in CI or on a local dev machine without an active container.
#
# LOCAL VALIDATION SUBSET: the underlying fail-fast check
#   (build the binary, point it at a corrupt file, confirm non-zero exit + no
#   listener) CAN be run locally with:
#     go build -o /tmp/tfbp-srv ./backend/cmd/tfbp-server
#     printf 'not a duckdb' > /tmp/corrupt.duckdb
#     DUCKDB_PATH=/tmp/corrupt.duckdb /tmp/tfbp-srv --port=8151
#   Expected: exits non-zero immediately; /healthz is never reachable.
# =============================================================================
#
# corrupt_artifact.sh — corrupt the artifact in the tfbp_data named volume and
# verify the Go binary FAILS FAST (non-zero exit, listener NEVER binds) per
# §9.5, rather than entering a "running but broken" state.
#
# Strategy:
#   1. Snapshot the good artifact (tfbp.duckdb.good).
#   2. Zero-fill + truncate the artifact to 4 KiB (too small to be a valid
#      DuckDB file; breaks DuckDB read-only open AND the artifact_manifest
#      canary SELECT).
#   3. Restart the tfbp container.
#   4. Assert: listener NEVER binds within BIND_WAIT seconds AND container
#      exits non-zero.
#   5. Restore the good artifact and restart; assert /readyz green again.
#
# PRECONDITIONS:
#   - Docker CLI + docker compose plugin available.
#   - tfbp_data named volume is the artifact volume (mounted at /data in tfbp).
#   - Alpine image pullable (or cached).
#
# PASS CRITERIA (§9.5):
#   - Container exits non-zero (ExitCode != 0 and != "unknown").
#   - HTTP listener NEVER binds: /healthz stays unreachable for BIND_WAIT sec.
#   - Log shows a single fail-fast line (NOT startup_ok).
#   - Good artifact restores cleanly: /readyz green after restore+restart.
#
# Env vars (all have defaults):
#   CONTAINER   compose service / container name      (default: tfbp)
#   VOLUME      named volume holding the artifact     (default: tfbp_data)
#   BASE_URL    base URL to probe /healthz             (default: http://127.0.0.1:8080)
#   BIND_WAIT   seconds to wait (must NOT bind)        (default: 20)
# =============================================================================
set -euo pipefail

CONTAINER="${CONTAINER:-tfbp}"
VOLUME="${VOLUME:-tfbp_data}"
BASE_URL="${BASE_URL:-http://127.0.0.1:8080}"
BIND_WAIT="${BIND_WAIT:-20}"

echo "=== corrupt_artifact.sh ==="
echo "container: ${CONTAINER}  volume: ${VOLUME}"
echo "start:     $(date -u +%FT%TZ)"

# ---------------------------------------------------------------------------
# Step 1: snapshot the good artifact.
# ---------------------------------------------------------------------------
echo ""
echo "--- step 1: snapshotting good artifact ---"
docker run --rm -v "${VOLUME}:/data" alpine:3 \
  sh -c 'cp /data/tfbp.duckdb /data/tfbp.duckdb.good \
         && echo "good snapshot bytes: $(wc -c < /data/tfbp.duckdb.good)"'

# ---------------------------------------------------------------------------
# Step 2: corrupt the artifact (zero-fill first 4 KiB, then truncate to 4 KiB).
# ---------------------------------------------------------------------------
echo ""
echo "--- step 2: corrupting artifact (truncate to 4 KiB) ---"
docker run --rm -v "${VOLUME}:/data" alpine:3 \
  sh -c 'dd if=/dev/zero of=/data/tfbp.duckdb bs=1024 count=4 conv=notrunc 2>/dev/null; \
         truncate -s 4096 /data/tfbp.duckdb; \
         echo "corrupt bytes: $(wc -c < /data/tfbp.duckdb)"'

# ---------------------------------------------------------------------------
# Step 3: restart the container against the corrupt artifact.
# ---------------------------------------------------------------------------
echo ""
echo "--- step 3: restarting ${CONTAINER} against corrupt artifact ---"
if docker compose up -d "$CONTAINER" 2>/dev/null; then
  true
else
  docker compose restart "$CONTAINER" 2>/dev/null || true
fi
# Brief pause so the process has time to attempt startup and exit.
sleep 3

# ---------------------------------------------------------------------------
# Step 4: assert listener NEVER binds and container exits non-zero.
# ---------------------------------------------------------------------------
echo ""
echo "--- step 4: asserting listener does NOT bind within ${BIND_WAIT}s ---"
bound="no"
deadline=$(( $(date +%s) + BIND_WAIT ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  if curl -sf --max-time 2 "${BASE_URL}/healthz" >/dev/null 2>&1; then
    bound="yes"
    break
  fi
  sleep 1
done

cid="$(docker compose ps -aq "$CONTAINER" 2>/dev/null \
       || docker ps -aqf "name=${CONTAINER}" 2>/dev/null \
       || echo '')"
exitcode="unknown"
if [ -n "$cid" ]; then
  exitcode="$(docker inspect -f '{{.State.ExitCode}}' "$cid" 2>/dev/null || echo unknown)"
fi

echo "container ExitCode=${exitcode}  listener_bound=${bound}"
echo ""
echo "--- startup log (must show fail-fast line, NOT startup_ok) ---"
if [ -n "$cid" ]; then
  docker logs --tail=20 "$cid" 2>&1 || true
else
  echo "(container id not found — cannot retrieve logs)"
fi

# ---------------------------------------------------------------------------
# Step 5: restore the good artifact regardless of outcome.
# ---------------------------------------------------------------------------
echo ""
echo "--- step 5: restoring good artifact ---"
docker run --rm -v "${VOLUME}:/data" alpine:3 \
  sh -c 'mv /data/tfbp.duckdb.good /data/tfbp.duckdb \
         && echo "restored bytes: $(wc -c < /data/tfbp.duckdb)"'

docker compose up -d "$CONTAINER"

echo "polling /readyz for restoration..."
restore_deadline=$(( $(date +%s) + 120 ))
while ! curl -sf --max-time 3 "${BASE_URL}/readyz" >/dev/null 2>&1; do
  if [ "$(date +%s)" -ge "$restore_deadline" ]; then
    echo "FAIL: /readyz not green within 120s after artifact restore"
    exit 1
  fi
  sleep 1
done
echo "restored: /readyz green again"

# ---------------------------------------------------------------------------
# Verdict.
# ---------------------------------------------------------------------------
echo ""
if [ "$bound" = "yes" ]; then
  echo "FAIL: HTTP listener bound against a corrupt artifact (must fail-fast per §9.5)"
  exit 1
fi
if [ "$exitcode" = "0" ] || [ "$exitcode" = "unknown" ]; then
  echo "FAIL: container did not exit non-zero on corrupt artifact (ExitCode=${exitcode})"
  exit 1
fi
echo "PASS: corrupt artifact -> non-zero exit (ExitCode=${exitcode}), listener never bound, restored cleanly"
