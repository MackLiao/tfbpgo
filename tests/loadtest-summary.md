# Cutover load-test summary — TEMPLATE (v2)

> **This is a TEMPLATE.** The cutover gate is an **operational step** run by the
> operator against the production EC2 `t3.small` with the **real** artifact and
> **k6 OFF-box** (the load generator must not steal the backend's 2 vCPUs).
> Every `<FILL IN>` is replaced with a measured value and committed alongside
> the cutover deploy. Mechanics of each scenario are validated locally on the
> fixture (the `*.local.sh` harnesses); the numbers below are NOT valid unless
> produced with `ARTIFACT_KIND=real`.
>
> Scenarios: `tests/loadtest/k6/scenarios/arrival_slo.js`,
> `hitrate_curve.js`, `breakpoint.js`. Shared libs under
> `tests/loadtest/k6/lib/`. Gate definitions: spec
> `docs/superpowers/specs/2026-05-12-go-react-rewrite-design.md` §11.3 and the
> loadtest-program design §10.

---

## Environment

```
Cutover date (UTC):      <FILL IN — e.g. 2026-05-30>
Backend host:            <FILL IN — t3.small, e.g. ec2-XX.compute-1.amazonaws.com>
k6 host (OFF-box):       <FILL IN — laptop/bastion; MUST be a different machine>
BASE_URL:                <FILL IN — e.g. https://tfbindingandperturbation.com>
ARTIFACT_KIND:           real          (MUST be 'real' — 'fixture' runs are mechanics-only)
artifactVersion:         <FILL IN — from /api/version, stamped in every summary JSON>
Backend version:         <FILL IN — git SHA / image digest>
Artifact sha256:         <FILL IN>
DuckDB version (binary): <FILL IN>
```

### Calibration precondition (the run is INVALID if either fails)

| Check | Requirement | Observed | OK? |
| ----- | ----------- | -------- | --- |
| k6 host CPU during run | < 70% (`mpstat 5` on the **off-box** k6 host) | `<FILL IN>` % | `<✓/✗>` |
| `dropped_iterations` (every scenario summary) | == 0 | `<FILL IN>` | `<✓/✗>` |

If either fails, the offered arrival rate is a lie: recalibrate (raise
`MAX_VUS`/`PREALLOC_VUS`, or shard k6 across two off-box generators) and rerun.
No numbers below are valid until both are green.

---

## Warm-cache open-model SLO

Scenario: `scenarios/arrival_slo.js` with `WARM=1` after a popular-keyspace
pre-warm. Open model (`ramping-arrival-rate`), step rate 5 → 40 → 80 req/s held
4m each. Read the thresholds block of the k6 summary / `arrival_slo.warm.json`.

| Metric (read from summary) | Gate | Measured | Pass? |
| -------------------------- | ---- | -------- | ----- |
| `http_req_failed` rate | == 0 | `<FILL IN>` | `<✓/✗>` |
| `http_req_duration{arm:mix}` p95 | < 200 ms | `<FILL IN>` ms | `<✓/✗>` |
| `http_req_duration{arm:mix}` p99 | < 500 ms | `<FILL IN>` ms | `<✓/✗>` |
| `dropped_iterations` | == 0 | `<FILL IN>` | `<✓/✗>` |
| `cache_hits_total / (hits+misses)` for `binding/data` | > 0.85 | `<FILL IN>` | `<✓/✗>` |
| `db_pool_wait_duration_seconds_total` / `db_pool_wait_count_total` mean (see Pool wait below) | < 100 ms | `<FILL IN>` ms | `<✓/✗>` |
| Peak RSS (`process_resident_memory_bytes`, sampled) | < 1.5 GB | `<FILL IN>` MB | `<✓/✗>` |
| OOM kills (`dmesg`) | == 0 | `<FILL IN>` | `<✓/✗>` |

> **SLO verdict (transcribe the scenario's `=== SLO VERDICT ===` block):** `<FILL IN>`

Off-box invocation actually run:
```
<FILL IN — paste the exact k6 command, including -e ARTIFACT_KIND=real -e WARM=1>
```

## Cold cutover number (honest)

Scenario: `scenarios/arrival_slo.js` **without** `WARM`, run **immediately after
`docker compose restart tfbp`** (ristretto empty). NOT gated — this is the
honest cold p95 the first users see before the cache fills. Recorded per spec
§11.3.3 "cold-cache containment".

| Metric | Value | Notes |
| ------ | ----- | ----- |
| `http_req_duration{arm:mix}` p95 (cold) | `<FILL IN>` ms | honest cold cutover p95 |
| `http_req_duration{arm:mix}` p99 (cold) | `<FILL IN>` ms | |
| Cold p95 for `comparison/topn` specifically | `<FILL IN>` ms | most expensive endpoint |
| `singleflight_shared_calls_total{endpoint:"comparison/topn"}` Δ | `<FILL IN>` | coalescing firing on cold popular keys |
| `dropped_iterations` | `<FILL IN>` (must be 0) | else number invalid |

## Hit-rate vs p95 curve

Scenario: `scenarios/hitrate_curve.js`, `KEYSPACE_MODE=zipf`, swept across
`ZIPF_EXP` (one run per point, backend restarted between points). Each row from
`hitrate_exp_<EXP>.json`. A row is VALID only if `inBand:true`
(|achieved − target| ≤ 3%).

| ZIPF_EXP | target hit rate | achieved hit rate | in-band (±3%)? | aggregate p95 (ms) | `binding/data` per-endpoint hit rate |
| -------- | --------------- | ----------------- | -------------- | ------------------ | ------------------------------------ |
| 0.6 | `<FILL IN>` | `<FILL IN>` | `<✓/✗>` | `<FILL IN>` | `<FILL IN>` |
| 0.9 | `<FILL IN>` | `<FILL IN>` | `<✓/✗>` | `<FILL IN>` | `<FILL IN>` |
| 1.2 | `<FILL IN>` | `<FILL IN>` | `<✓/✗>` | `<FILL IN>` | `<FILL IN>` |
| 1.5 | `<FILL IN>` | `<FILL IN>` | `<✓/✗>` | `<FILL IN>` | `<FILL IN>` |
| 2.0 | `<FILL IN>` | `<FILL IN>` | `<✓/✗>` | `<FILL IN>` | `<FILL IN>` |

**Operating-point assertion:** at the realistic skew (≈ `ZIPF_EXP 1.2`)
`perEndpointHitRate["binding/data"]` > 0.85 **and** aggregate p95 < 200 ms.
Result: `<FILL IN — PASS/FAIL>`.

`cache_load_seconds_total{endpoint}` (cold-path wall-seconds, splits route
latency from DB+marshal): `<FILL IN — top 3 endpoints by Δ over the run>`.

## Breaking point

Scenario: `scenarios/breakpoint.js`, `KEYSPACE_MODE=uniform` (mostly-miss),
expensive endpoints, pushed to ~300 req/s. True `db_pool_in_use` /
`go_goroutines` / RSS peaks come from the on-box `breakpoint-peaks.txt`
sampler, NOT the post-run scrape. From `breakpoint.json`.

| Field | Value | Source |
| ----- | ----- | ------ |
| Knee (last sane rate, p95 < 500 ms) | `<FILL IN>` req/s | `kneeReqS` |
| Cliff (first rate with failures) | `<FILL IN>` req/s | `cliffReqS` |
| Degradation mode | `<FILL IN — queue-then-504 \| OOM \| credit-throttle \| spill>` | `degradationMode` |
| Degradation reason | `<FILL IN>` | `degradationReason` |
| `db_pool_in_use` peak / `db_pool_open_connections` | `<FILL IN>` / `<FILL IN>` | sampler + scrape |
| `go_goroutines` peak | `<FILL IN>` | sampler |
| RSS peak | `<FILL IN>` MB | sampler |
| `cache_misses_total` Δ | `<FILL IN>` | scrape delta |
| `cache_evictions_total` Δ | `<FILL IN>` | scrape delta |
| `http_in_flight_requests` peak | `<FILL IN>` | sampler |

**Headroom assertion:** `kneeReqS` must sit comfortably above the warm SLO
offered rate (80 req/s). `kneeReqS <= 80` is a cutover blocker. Result:
`<FILL IN — PASS/FAIL>`.

Degradation-mode reference:
- **queue-then-504** — pool pegged at `db_pool_open_connections`, `db_pool_wait`
  mean climbs, 30s-ctx timeouts → 504s; goroutines pile up.
- **OOM** — RSS near `mem_limit` + sudden failure spike (container OOM-killed).
- **credit-throttle** — latency/failures rise with a **healthy** pool and flat
  RSS → t3.small CPU-credit exhaustion.
- **spill** — `db_query_duration` climbs with moderate pool wait + evictions →
  DuckDB spilling to `temp_directory` (check `max_temp_directory_size`).

## Availability / error budget

From `arrival_slo.js`'s `readyz_available` probe arm (low-rate `/readyz`+`/healthz`)
and `http_req_failed`.

| Metric | Gate | Measured | Pass? |
| ------ | ---- | -------- | ----- |
| `readyz_available` (Rate) | > 0.995 | `<FILL IN>` | `<✓/✗>` |
| `http_req_failed` rate (warm) | < 0.005 | `<FILL IN>` | `<✓/✗>` |
| Error budget consumed during run | informational | `<FILL IN>` | — |

## Pool wait (counter-pair)

`db_pool_wait_duration_seconds` is exported as a counter PAIR. Compute the mean
wait over the run window — do NOT read a single histogram quantile.

```
mean_wait_ms = 1000 * Δ(db_pool_wait_duration_seconds_total)
                    / Δ(db_pool_wait_count_total)
```

(This is exactly `metrics.js poolWaitMeanMs(before, after)`.)

| Window | `db_pool_wait_duration_seconds_total` Δ | `db_pool_wait_count_total` Δ | mean wait (ms) | Gate | Pass? |
| ------ | --------------------------------------- | ---------------------------- | -------------- | ---- | ----- |
| Warm SLO run | `<FILL IN>` | `<FILL IN>` | `<FILL IN>` | < 100 ms | `<✓/✗>` |
| Breaking-point run | `<FILL IN>` | `<FILL IN>` | `<FILL IN>` | informational | — |

---

## Observability checklist

Verify on the running container during the cutover window:

- [ ] `/healthz` 200, `/readyz` 200 with artifact metadata, `/api/version` returns `{artifactVersion, schemaVersion, ...}`.
- [ ] `/metrics` exposes every §6.7 metric **plus** the Phase-A additions:
  `http_in_flight_requests`, `cache_load_seconds_total{endpoint}`,
  `cache_admission_rejected_total{endpoint}`, `cache_oversize_responses_total{endpoint}`.
- [ ] Structured logs include `artifact_version`, `route`, `status`, `latency_ms` per request.
- [ ] Stale `/api/v/{v}/...` with non-current `{v}` returns 410 with `Location: /api/version`.
- [ ] `legacy.tfbindingandperturbation.com` serves Shiny; `tfbindingandperturbation.com` serves the Go SPA.

## How to fill this in

1. Provision real artifact + image per `deploy/README.md`. Confirm `ARTIFACT_KIND=real`.
2. From an **off-box** k6 host, confirm the calibration precondition (CPU < 70%, `dropped_iterations==0`).
3. Pre-warm, run `arrival_slo.js WARM=1` → Warm-cache SLO table + Availability + Pool wait (warm row).
4. `docker compose restart tfbp`, run `arrival_slo.js` (no WARM) → Cold cutover table.
5. Sweep `hitrate_curve.js` over `ZIPF_EXP` (restart between points) → Hit-rate curve.
6. Start the on-box peak sampler, run `breakpoint.js` off-box → Breaking-point table.
7. Tick the observability boxes.
8. `git add tests/loadtest-summary.md && git commit -m "docs(cutover): record v2 load-test summary for <date>"` then proceed with DNS cutover.

---

## Head-to-head vs legacy Python Shiny (G3)

> **Phase D — fast-follow, NOT a cutover blocker** (spec §3, §11).
> Protocol is pinned in `tests/loadtest/k6/headtohead/METHODOLOGY.md`.
> Run procedure: `tests/loadtest/k6/headtohead/RUNBOOK.md`.
> Drivers: `arrival_slo.js` (Go arm), `shiny_k6.js` (Shiny arm).
>
> **Frame-capture prerequisite:** before running the Shiny arm, capture the
> SockJS frames per `CAPTURE.md` and paste them into `frames.js`. With
> `frames.js __CAPTURED__ = false` the Shiny arm refuses to run.

### req/s-at-SLO crossover

The deliverable is the highest arrival rate (req/s) at which each arm still
meets the availability SLO (`shiny_action_ok` rate ≥ 0.995 / `http_req_failed`
rate == 0) AND the latency SLO (p95 < 200 ms, p99 < 500 ms), at both warm and
cold postures. See METHODOLOGY.md §7 for the full pass criterion.

| Target | Posture | Highest req/s at SLO | Degradation rate | Degradation mode |
| ------ | ------- | -------------------- | ---------------- | ---------------- |
| Go (tfbindingandperturbation.com) | warm | `<FILL IN>` req/s | `<FILL IN>` | `<FILL IN>` |
| Go (tfbindingandperturbation.com) | cold | `<FILL IN>` req/s | `<FILL IN>` | `<FILL IN>` |
| Shiny (legacy.tfbindingandperturbation.com) | warm | `<FILL IN>` req/s | `<FILL IN>` | `<FILL IN>` |
| Shiny (legacy.tfbindingandperturbation.com) | cold | `<FILL IN>` req/s | `<FILL IN>` | `<FILL IN>` |

### Shiny arm SLO metrics

Read from `shiny_adapter.summary.json` after the Shiny ladder run.

| Metric | Gate | Measured | Pass? |
| ------ | ---- | -------- | ----- |
| `shiny_action_ok` rate (warm) | ≥ 0.995 | `<FILL IN>` | `<✓/✗>` |
| `shiny_action_ms` p95 (warm) | < 200 ms | `<FILL IN>` ms | `<✓/✗>` |
| `shiny_action_ms` p99 (warm) | < 500 ms | `<FILL IN>` ms | `<✓/✗>` |
| `shiny_action_ok` rate (cold) | informational | `<FILL IN>` | — |
| `shiny_action_ms` p95 (cold) | informational | `<FILL IN>` ms | — |
| `shiny_reconnects_total` | informational | `<FILL IN>` | — |
| `dropped_iterations` (Shiny arm) | == 0 | `<FILL IN>` | `<✓/✗>` |

### G3 pass criterion

**PASS** if: Go meets the availability SLO (`http_req_failed` rate == 0,
`readyz_available` > 0.995, p99 < 500 ms) at the arrival rate where Shiny
first degrades below its SLO (`shiny_action_ok` rate < 0.995 OR
`shiny_action_ms` p99 > 500 ms).

**G3 result:** `<FILL IN — PASS / FAIL / BOTH DEGRADE AT SAME RATE>`

### Environment (matched per METHODOLOGY.md §2)

```
Run date (UTC):           <FILL IN>
Go host:                  <FILL IN — t3.small instance id>
Shiny host:               <FILL IN — t3.small instance id>
k6 host (off-box):        <FILL IN>
Artifact sha256:          <FILL IN — same file on both hosts>
Go binary SHA:            <FILL IN>
Shiny version (pip show): <FILL IN — e.g. shiny==1.4.0>
```
