#!/usr/bin/env bash
# =============================================================================
# OPERATIONAL on EC2 (full mode); LOCAL in SAMPLE_LOCAL=1 mode.
#
# sampler.sh — fixed-cadence metrics CSV sampler.  One CSV row per tick with:
#   - Selected /metrics values (cache hits/misses, DB query count, pool stats,
#     cache evictions, in-flight requests, RSS, goroutines).
#   - docker stats RSS for the container          (SKIPPED in SAMPLE_LOCAL=1)
#   - aws cloudwatch CPUCreditBalance (t3.small)   (SKIPPED in SAMPLE_LOCAL=1)
#
# LOCAL MODE (SAMPLE_LOCAL=1):
#   Skips docker stats and CloudWatch.  Only scrapes /metrics via curl.
#   This mode is used by soak.fixture.sh, export_contention.fixture.sh, and
#   chaos_lint.sh to co-run the sampler without Docker or AWS credentials.
#   Interface contract (what the fixture harnesses check):
#     - CSV has a header line starting with "ts,"
#     - CSV has at least SAMPLE_ITERATIONS data rows (wc -l >= SAMPLE_ITERATIONS+1)
#     - SAMPLE_OUT is the output file path (default: sampler.csv)
#     - SAMPLE_INTERVAL controls sleep between ticks (default: 15s; set to 1 for fixtures)
#     - SAMPLE_ITERATIONS > 0 stops after that many ticks (default: 0 = run forever)
#     - BASE_URL is the server base URL
#
# FULL MODE (EC2):
#   Also captures docker stats container RSS and, if INSTANCE_ID is set,
#   CloudWatch CPUCreditBalance for the t3.small instance.
#   Pairs with: soak.js, export_contention.js, oom_induce.sh, temp_fill.sh.
#   Backs Tasks 19, 21, 22, 23.
#
# PRECONDITIONS (full mode only):
#   - Docker CLI available; container CONTAINER is running.
#   - AWS CLI authenticated with CloudWatch:GetMetricStatistics permission.
#   - EC2 instance id set in INSTANCE_ID env var.
#
# CSV columns:
#   ts, cache_hits, cache_misses, db_query_count, pool_in_use, pool_open,
#   pool_wait_secs_total, pool_wait_count, evictions, in_flight,
#   rss_bytes, goroutines, docker_rss_mb, cpu_credit_balance
#
# Env vars (all have defaults):
#   BASE_URL          server base URL                  (default: http://127.0.0.1:8080)
#   CONTAINER         docker stats target              (default: tfbp)
#   SAMPLE_OUT        output CSV path                  (default: sampler.csv)
#   SAMPLE_INTERVAL   seconds between ticks            (default: 15)
#   SAMPLE_ITERATIONS >0 = stop after N ticks; 0 = run forever (default: 0)
#   SAMPLE_LOCAL      1 = skip docker stats + cloudwatch (default: unset)
#   INSTANCE_ID       EC2 instance id for CloudWatch   (optional)
#   AWS_REGION        AWS region for CloudWatch         (default: us-east-2)
# =============================================================================
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:8080}"
CONTAINER="${CONTAINER:-tfbp}"
SAMPLE_OUT="${SAMPLE_OUT:-sampler.csv}"
SAMPLE_INTERVAL="${SAMPLE_INTERVAL:-15}"
SAMPLE_ITERATIONS="${SAMPLE_ITERATIONS:-0}"
AWS_REGION="${AWS_REGION:-us-east-2}"

# ---------------------------------------------------------------------------
# mget: extract the sum of all Prometheus metric lines matching a name prefix.
# Usage: mget "$metrics_text" "metric_name_prefix"
# Returns 0 if the metric is absent.
# ---------------------------------------------------------------------------
mget() {
  local body="$1"
  local name="$2"
  printf '%s\n' "$body" | awk -v n="$name" '
    /^#/ { next }
    $1 ~ ("^" n "([{: ]|$)") { v=$NF+0; s+=v }
    END { printf "%.6g", s+0 }
  '
}

# ---------------------------------------------------------------------------
# Write CSV header.
# ---------------------------------------------------------------------------
printf 'ts,cache_hits,cache_misses,db_query_count,pool_in_use,pool_open,pool_wait_secs_total,pool_wait_count,evictions,in_flight,rss_bytes,goroutines,docker_rss_mb,cpu_credit_balance\n' \
  > "$SAMPLE_OUT"

# ---------------------------------------------------------------------------
# Sampling loop.
# ---------------------------------------------------------------------------
tick=0
while :; do
  ts="$(date -u +%FT%TZ)"

  # Scrape /metrics; tolerate transient failures (backend may be restarting).
  m="$(curl -sf --max-time 5 "${BASE_URL}/metrics" 2>/dev/null || true)"

  hits=$(mget "$m" "cache_hits_total")
  misses=$(mget "$m" "cache_misses_total")
  dbq=$(mget "$m" "db_query_duration_seconds_count")
  inuse=$(mget "$m" "db_pool_in_use")
  open=$(mget "$m" "db_pool_open_connections")
  waitsecs=$(mget "$m" "db_pool_wait_duration_seconds_total")
  waitcnt=$(mget "$m" "db_pool_wait_count_total")
  evict=$(mget "$m" "cache_evictions_total")
  inflight=$(mget "$m" "http_in_flight_requests")
  rss=$(mget "$m" "process_resident_memory_bytes")
  goro=$(mget "$m" "go_goroutines")

  docker_rss="n/a"
  credit="n/a"

  if [ "${SAMPLE_LOCAL:-}" != "1" ]; then
    # docker stats: parse "123.4MiB / 1.6GiB" -> take the first field value.
    docker_rss="$(docker stats --no-stream --format '{{.MemUsage}}' \
      "$CONTAINER" 2>/dev/null | awk '{print $1}' || true)"
    if [ -z "$docker_rss" ]; then
      docker_rss="n/a"
    fi

    if [ -n "${INSTANCE_ID:-}" ]; then
      # Portable date subtraction: try GNU -d, fall back to BSD -v.
      start_time="$(date -u -d '-5 min' +%FT%TZ 2>/dev/null \
                    || date -u -v-5M +%FT%TZ 2>/dev/null \
                    || echo '')"
      if [ -n "$start_time" ]; then
        credit="$(aws cloudwatch get-metric-statistics \
          --region "$AWS_REGION" \
          --namespace AWS/EC2 \
          --metric-name CPUCreditBalance \
          --dimensions Name=InstanceId,Value="$INSTANCE_ID" \
          --start-time "$start_time" \
          --end-time "$(date -u +%FT%TZ)" \
          --period 60 \
          --statistics Average \
          --query 'Datapoints[-1].Average' \
          --output text 2>/dev/null || true)"
        if [ -z "$credit" ] || [ "$credit" = "None" ]; then
          credit="n/a"
        fi
      fi
    fi
  fi

  printf '%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s\n' \
    "$ts" "$hits" "$misses" "$dbq" \
    "$inuse" "$open" "$waitsecs" "$waitcnt" \
    "$evict" "$inflight" "$rss" "$goro" \
    "$docker_rss" "$credit" \
    >> "$SAMPLE_OUT"

  tick=$(( tick + 1 ))
  if [ "$SAMPLE_ITERATIONS" -gt 0 ] && [ "$tick" -ge "$SAMPLE_ITERATIONS" ]; then
    break
  fi

  sleep "$SAMPLE_INTERVAL"
done
