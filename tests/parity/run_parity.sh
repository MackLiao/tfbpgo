#!/usr/bin/env bash
#
# Snapshot-based parity check: hits a list of golden URLs against a running
# backend, writes <hash>.expected on first run (or when PARITY_RECORD=1),
# diffs <hash>.actual vs <hash>.expected on subsequent runs.
#
# Per spec §11.3.1 this is the foundation of the cutover gate.
#
# Env:
#   PARITY_BASE_URL  default http://localhost:8080
#   PARITY_RECORD    set to 1 to (re)record snapshots
#
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
SNAP="$ROOT/tests/parity/snapshots"
mkdir -p "$SNAP"
BASE="${PARITY_BASE_URL:-http://localhost:8080}"
RECORD="${PARITY_RECORD:-0}"

# ---- read artifact version from /api/version (jq preferred, python3 fallback)
if command -v jq >/dev/null 2>&1; then
  V=$(curl -sf "$BASE/api/version" | jq -r .artifactVersion)
else
  V=$(curl -sf "$BASE/api/version" | python3 -c "import json,sys; print(json.load(sys.stdin)['artifactVersion'])")
fi
if [ -z "$V" ] || [ "$V" = "null" ]; then
  echo "FATAL: could not read artifactVersion from $BASE/api/version"
  exit 2
fi
echo "Artifact version: $V"

# ---- hash helper: shasum (macOS) or sha256sum (linux) or python3
hash_str() {
  if command -v shasum >/dev/null 2>&1; then
    printf '%s' "$1" | shasum -a 256 | awk '{print $1}' | cut -c1-16
  elif command -v sha256sum >/dev/null 2>&1; then
    printf '%s' "$1" | sha256sum | awk '{print $1}' | cut -c1-16
  else
    printf '%s' "$1" | python3 -c "import sys,hashlib; print(hashlib.sha256(sys.stdin.read().encode()).hexdigest())" | cut -c1-16
  fi
}

fail=0
total=0
recorded=0
while IFS= read -r url; do
  [ -z "$url" ] && continue
  case "$url" in \#*) continue ;; esac

  rendered=${url//\{V\}/$V}

  # Hash the version-free URL so re-running with a new artifact version
  # reuses the same snapshot filename (the artifact version is a route
  # parameter, not payload content the snapshot is gating on).
  name=$(hash_str "$url")
  actual="$SNAP/$name.actual"
  expected="$SNAP/$name.expected"

  total=$((total+1))
  http_code=$(curl -s -o "$actual" -w "%{http_code}" "$BASE$rendered" || true)
  if [ "$http_code" != "200" ]; then
    echo "FAIL ($http_code): $rendered"
    fail=$((fail+1))
    continue
  fi

  if [ "$RECORD" = "1" ] || [ ! -f "$expected" ]; then
    cp "$actual" "$expected"
    recorded=$((recorded+1))
    echo "recorded: $rendered -> $name"
  else
    if ! diff -q "$expected" "$actual" > /dev/null; then
      echo "DIFF: $rendered"
      diff -u "$expected" "$actual" | head -40
      fail=$((fail+1))
    fi
  fi
done < "$ROOT/tests/parity/golden_urls.txt"

echo "---"
echo "Total: $total, Recorded: $recorded, Failures: $fail"
exit $fail
