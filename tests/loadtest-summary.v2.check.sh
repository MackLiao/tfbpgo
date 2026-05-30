#!/usr/bin/env bash
# tests/loadtest-summary.v2.check.sh
# Structural lint for the v2 cutover load-test summary. Asserts the §10 sections
# and every interface-contract metric/threshold the operator must record are
# present, and that it is still marked a TEMPLATE (numbers are filled
# operationally on EC2). Does NOT assert any measured value.
set -euo pipefail

F="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/loadtest-summary.md"
test -f "$F" || { echo "FAIL: $F missing" >&2; exit 1; }

req() { grep -qF -- "$1" "$F" || { echo "FAIL: summary missing required marker: $1" >&2; exit 1; }; }

# Identity
req "TEMPLATE"
req "v2"
req "ARTIFACT_KIND"
req "<FILL IN>"

# §10 section headers
req "## Warm-cache open-model SLO"
req "## Cold cutover number"
req "## Hit-rate vs p95 curve"
req "## Breaking point"
req "## Availability / error budget"
req "## Pool wait (counter-pair)"

# Scenario provenance
req "scenarios/arrival_slo.js"
req "scenarios/hitrate_curve.js"
req "scenarios/breakpoint.js"

# Interface-contract metric names the operator reads
req "http_req_failed"
req "http_req_duration"
req "dropped_iterations"
req "readyz_available"
req "db_pool_in_use"
req "db_pool_wait_duration_seconds_total"
req "db_pool_wait_count_total"
req "go_goroutines"
req "cache_hits_total"
req "cache_misses_total"
req "cache_load_seconds_total"
req "http_in_flight_requests"

# Degradation modes enumerated
req "queue-then-504"
req "credit-throttle"
req "spill"

# Calibration precondition is stated
req "k6 host CPU"
req "off-box"

echo "PASS: loadtest-summary.md is v2 and structurally complete"
