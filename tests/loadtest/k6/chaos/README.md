# tests/loadtest/k6/chaos/

**Operational host scripts** — requires Docker + EC2 + (for some) AWS credentials.

`sampler.sh` (with `SAMPLE_LOCAL=1`) and `chaos_lint.sh` run locally without Docker.

---

## Scripts

### `docker_kill.sh` — SIGKILL the container, measure recovery time
Simulates an ungraceful crash or OOM-kill. Sends `SIGKILL` to the tfbp container
and polls `/readyz` until `restart: unless-stopped` brings it back.

**Pairs with:** `cold_start_cliff.js` (run concurrently to capture client-visible
connection-reset impact of the kill).

**Pass:** `/readyz` green within `READY_TIMEOUT` s; startup log re-emits `startup_ok`.

| Env var | Default | Purpose |
|---|---|---|
| `CONTAINER` | `tfbp` | Docker service / container name |
| `BASE_URL` | `http://127.0.0.1:8080` | Server base URL for `/readyz` |
| `READY_TIMEOUT` | `120` | Max seconds to wait for recovery |

---

### `docker_stop.sh` — SIGTERM, graceful drain + restart
Sends `SIGTERM` via `docker compose stop -t DRAIN_TIMEOUT`. The Go server drains
in-flight requests; with a co-running k6 scenario `http_req_failed` should stay 0
across the drain window (contrast with SIGKILL which severs connections).

**Pairs with:** `soak.js` or `arrival_slo.js` (run concurrently).

**Pass:** `/readyz` green within `READY_TIMEOUT` s; in-flight requests complete cleanly.

| Env var | Default | Purpose |
|---|---|---|
| `CONTAINER` | `tfbp` | Docker service name |
| `BASE_URL` | `http://127.0.0.1:8080` | Server base URL |
| `DRAIN_TIMEOUT` | `30` | Seconds for `docker stop -t` |
| `READY_TIMEOUT` | `120` | Max seconds to wait for recovery |

---

### `temp_fill.sh` — fill `tfbp_tmp` toward `max_temp_directory_size` = 2 GB
Writes a ballast file into the DuckDB spill volume from a helper Alpine container,
drives a spill-heavy query, and asserts the error path is loud + bounded (HTTP 5xx,
not a hang, not an OOM kill). Then removes the ballast and confirms the query
recovers to HTTP 200.

**Pass:** spill-heavy query returns 5xx (bounded body); `dmesg` shows no kernel OOM
kill; after ballast removal the same query returns 200.

| Env var | Default | Purpose |
|---|---|---|
| `VOLUME` | `tfbp_tmp` | Named volume for DuckDB spill |
| `FILL_MB` | `1900` | Ballast size in MB (just under 2 GB cap) |
| `BASE_URL` | `http://127.0.0.1:8080` | Server base URL |
| `VERSION` | auto-detected | Artifact version string |

---

### `oom_induce.sh` — push container toward `mem_limit` = 1.6 g
Fires `CONCURRENCY` concurrent memory-heavy requests with distinct query params
(bypassing singleflight coalescing) to push RSS toward the 1.6 GB container limit.
Verifies the intended failure mode: Docker OOM-kills the container
(`State.OOMKilled=true`) and `restart: unless-stopped` restores it automatically.
The host kernel OOM-killer must NOT fire (`memswap_limit=mem_limit` disables swap
so the cgroup is hit first).

**Ideal outcome:** spill + pool cap keep RSS under 1.5 GB and no OOM occurs at all.
Both ideal and a clean Docker OOM are a PASS.

**Pairs with:** `sampler.sh` (monitor RSS column over the run).

| Env var | Default | Purpose |
|---|---|---|
| `CONTAINER` | `tfbp` | Docker service / container name |
| `BASE_URL` | `http://127.0.0.1:8080` | Server base URL |
| `VERSION` | auto-detected | Artifact version string |
| `CONCURRENCY` | `16` | Number of concurrent heavy requests |
| `READY_TIMEOUT` | `120` | Max seconds to wait for recovery |

---

### `sampler.sh` — fixed-cadence metrics + RSS + CPU-credit CSV  _(backs Tasks 19, 21, 22, 23)_
Appends one CSV row per `SAMPLE_INTERVAL` seconds with:
- `/metrics` scrape values: `cache_hits_total`, `cache_misses_total`,
  `db_query_duration_seconds_count`, `db_pool_in_use`, `db_pool_open_connections`,
  `db_pool_wait_duration_seconds_total`, `db_pool_wait_count_total`,
  `cache_evictions_total`, `http_in_flight_requests`,
  `process_resident_memory_bytes`, `go_goroutines`.
- `docker stats` container RSS (full mode only).
- `aws cloudwatch get-metric-statistics` CPUCreditBalance (full mode, if `INSTANCE_ID` set).

**LOCAL MODE (`SAMPLE_LOCAL=1`):** skips Docker and CloudWatch; runs `SAMPLE_ITERATIONS`
ticks and exits. Used by `soak.fixture.sh`, `export_contention.fixture.sh`, and
`chaos_lint.sh` to co-run the sampler without EC2/AWS.

**Interface contract (what fixture harnesses check):**
- CSV header line starts with `ts,`
- `wc -l < "$SAMPLE_CSV" >= 2` (header + at least 1 data row)
- Controlled by: `SAMPLE_INTERVAL`, `SAMPLE_OUT`, `BASE_URL`, `SAMPLE_LOCAL`, `SAMPLE_ITERATIONS`

| Env var | Default | Purpose |
|---|---|---|
| `BASE_URL` | `http://127.0.0.1:8080` | Server base URL |
| `CONTAINER` | `tfbp` | docker stats target |
| `SAMPLE_OUT` | `sampler.csv` | Output CSV file path |
| `SAMPLE_INTERVAL` | `15` | Seconds between ticks |
| `SAMPLE_ITERATIONS` | `0` (forever) | Stop after N ticks if >0 |
| `SAMPLE_LOCAL` | unset | `1` = skip docker stats + cloudwatch |
| `INSTANCE_ID` | unset | EC2 instance id for CloudWatch |
| `AWS_REGION` | `us-east-2` | AWS region |

---

### `corrupt_artifact.sh` — verify fail-fast startup (§9.5) _(proves the startup contract)_
Snapshots the good artifact, zero-fills + truncates it to 4 KiB (invalid DuckDB
file), restarts the tfbp container, and asserts that the binary **exits non-zero
and never binds the HTTP listener** (§9.5: DuckDB open failure → `artifact_manifest`
canary failure → process exits with a single structured log line before binding the
port). Then restores the good artifact and confirms `/readyz` is green again.

**Local validation subset:** without Docker, run:
```bash
go build -o /tmp/tfbp-srv ./backend/cmd/tfbp-server
printf 'not a duckdb' > /tmp/corrupt.duckdb
DUCKDB_PATH=/tmp/corrupt.duckdb /tmp/tfbp-srv --port=8151
# Expected: exits non-zero immediately; /healthz is never reachable.
```

| Env var | Default | Purpose |
|---|---|---|
| `CONTAINER` | `tfbp` | Docker service / container name |
| `VOLUME` | `tfbp_data` | Named volume holding the artifact |
| `BASE_URL` | `http://127.0.0.1:8080` | Server base URL to probe `/healthz` |
| `BIND_WAIT` | `20` | Seconds to wait (listener must NOT bind) |

---

## `chaos_lint.sh` — local lint + sampler smoke (runs in CI / locally)

The only locally-runnable check. Does **not** execute any destructive action.

1. Asserts each script exists, is executable, and parses (`bash -n`).
2. Runs `shellcheck` on each if available.
3. Boots the fixture backend and runs `sampler.sh` in `SAMPLE_LOCAL=1` mode; asserts
   CSV has `ts,` header and ≥ 3 lines.

```bash
bash tests/loadtest/k6/chaos/chaos_lint.sh
```

---

## Operational runbook (EC2)

```bash
# Long soak + sampler:
SAMPLE_INTERVAL=15 SAMPLE_OUT=soak_sample.csv \
  BASE_URL=https://tfbindingandperturbation.com \
  CONTAINER=tfbp bash tests/loadtest/k6/chaos/sampler.sh &
SAMP=$!
# ... run k6 soak ...
kill "$SAMP"

# Kill/recovery test (pairs with cold_start_cliff.js):
bash tests/loadtest/k6/chaos/docker_kill.sh

# Graceful stop (pairs with a constant-rate scenario):
bash tests/loadtest/k6/chaos/docker_stop.sh

# Temp-fill (verify DuckDB spill error path):
bash tests/loadtest/k6/chaos/temp_fill.sh

# OOM induction (verify Docker-level OOM, not kernel OOM):
bash tests/loadtest/k6/chaos/oom_induce.sh

# Corrupt-artifact fail-fast (§9.5 startup contract):
bash tests/loadtest/k6/chaos/corrupt_artifact.sh
```
