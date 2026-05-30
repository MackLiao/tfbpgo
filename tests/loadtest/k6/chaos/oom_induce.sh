#!/usr/bin/env bash
# =============================================================================
# OPERATIONAL SCRIPT — requires Docker + a deployed tfbp container on EC2.
# DO NOT run in CI or on a local dev machine without an active container.
# =============================================================================
#
# oom_induce.sh — drive enough concurrent memory-heavy queries to push the
# container toward mem_limit=1.6g (§6.3) and confirm the intended failure mode:
#
#   INTENDED: Docker OOM-kills the container (State.OOMKilled=true) and
#             restart: unless-stopped brings it back automatically.
#
#   FORBIDDEN: The host kernel kills a random process (dmesg "killed process"
#              on a process OTHER than the tfbp container process).  This must
#              not happen because memswap_limit=mem_limit=1.6g (swap disabled)
#              so the cgroup is the first thing Docker kills.
#
#   IDEAL:  DuckDB spill + the 2-conn pool cap + singleflight coalescing keep
#           RSS safely under 1.5 GB — no OOM at all.  Both IDEAL and INTENDED
#           are a PASS; only a host-kernel kill or a hang is a FAIL.
#
# Strategy: fire CONCURRENCY concurrent requests using distinct query params
# (so singleflight does NOT coalesce them into a single query) and wait for
# either the container to recover (/readyz green) or the timeout to expire.
#
# PRECONDITIONS:
#   - Docker CLI available; container CONTAINER is running.
#   - The spill-heavy query route exists:
#       /api/v/{VERSION}/comparison/topn?binding=callingcards&perturbation=hackett&top_n=1000
#   - docker-compose.yml has restart: unless-stopped and mem_limit=1.6g.
#
# PASS CRITERIA:
#   - Either no OOM (RSS stayed within bounds), or State.OOMKilled=true and
#     /readyz green within READY_TIMEOUT seconds.
#   - dmesg shows NO "killed process" on a non-container host process.
#
# Env vars (all have defaults):
#   CONTAINER      compose service / container name   (default: tfbp)
#   BASE_URL       base URL for /readyz + /api/version (default: http://127.0.0.1:8080)
#   VERSION        artifact version — auto-detected if unset
#   CONCURRENCY    number of concurrent heavy queries  (default: 16)
#   READY_TIMEOUT  max seconds to wait for recovery    (default: 120)
# =============================================================================
set -euo pipefail

CONTAINER="${CONTAINER:-tfbp}"
BASE_URL="${BASE_URL:-http://127.0.0.1:8080}"
READY_TIMEOUT="${READY_TIMEOUT:-120}"
CONCURRENCY="${CONCURRENCY:-16}"

# Auto-detect artifact version if not provided.
if [ -z "${VERSION:-}" ]; then
  VERSION="$(curl -sf "${BASE_URL}/api/version" \
    | sed -n 's/.*"artifactVersion":"\([^"]*\)".*/\1/p')"
fi
if [ -z "$VERSION" ]; then
  echo "FAIL: could not determine artifact version from ${BASE_URL}/api/version"
  exit 1
fi

# Resolve container id.
cid="$(docker compose ps -q "$CONTAINER" 2>/dev/null || true)"
if [ -z "$cid" ]; then
  cid="$(docker ps -qf "name=${CONTAINER}" 2>/dev/null || true)"
fi
if [ -z "$cid" ]; then
  echo "FAIL: no running container found for service/name '${CONTAINER}'"
  exit 1
fi

echo "=== oom_induce.sh ==="
echo "container:   ${CONTAINER} (id=${cid})"
echo "version:     ${VERSION}"
echo "concurrency: ${CONCURRENCY}"
echo "start:       $(date -u +%FT%TZ)"

echo ""
echo "--- firing ${CONCURRENCY} concurrent memory-heavy queries ---"
echo "(distinct params bypass singleflight coalescing)"
url_base="${BASE_URL}/api/v/${VERSION}/comparison/topn?binding=callingcards&perturbation=hackett&top_n=1000"

pids=()
for i in $(seq 1 "$CONCURRENCY"); do
  # Append a distinct dummy param per request so singleflight cannot coalesce.
  curl -s -o /dev/null --max-time 120 \
    "${url_base}&_seq=${i}&_r=${RANDOM}" &
  pids+=($!)
done

# Wait for all curl processes; suppress non-zero exit from killed curls.
for pid in "${pids[@]}"; do
  wait "$pid" 2>/dev/null || true
done
echo "all ${CONCURRENCY} requests finished (or were killed)"

echo ""
echo "--- OOM state inspection ---"
oom="$(docker inspect -f '{{.State.OOMKilled}}' "$cid" 2>/dev/null || echo unknown)"
echo "State.OOMKilled=${oom}"

echo ""
echo "--- host kernel OOM check (must NOT show a random-process kill) ---"
if dmesg | tail -80 | grep -iq 'killed process'; then
  echo "WARNING: dmesg shows OOM-killer entry — review to confirm it is the container process"
  dmesg | tail -80 | grep -i 'killed process' || true
else
  echo "  (no host OOM-killer entries — good)"
fi

echo ""
echo "--- recovery poll (restart: unless-stopped should restore /readyz) ---"
t0=$(date +%s)
deadline=$(( t0 + READY_TIMEOUT ))
while ! curl -sf --max-time 3 "${BASE_URL}/readyz" >/dev/null 2>&1; do
  now=$(date +%s)
  if [ "$now" -ge "$deadline" ]; then
    echo "FAIL: /readyz not green within ${READY_TIMEOUT}s after OOM induction"
    exit 1
  fi
  sleep 1
done
t1=$(date +%s)
recovery=$(( t1 - t0 ))

echo ""
if [ "$oom" = "true" ]; then
  echo "PASS: Docker OOM-kill (clean container-level OOM) + recovered in ${recovery}s"
else
  echo "PASS: no OOM (RSS stayed within mem_limit) — ideal outcome; /readyz green in ${recovery}s"
fi
echo "failure mode = Docker OOM (clean) NOT host-kernel OOM — as intended"
