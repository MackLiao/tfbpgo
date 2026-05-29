# Load / Availability / Latency / Cache Test Program — Design

**Status:** Design (proposed)
**Date:** 2026-05-29
**Author:** MackLiao (with Claude as drafting partner)
**Related:** `docs/superpowers/specs/2026-05-12-go-react-rewrite-design.md` (§6.7 SLOs, §8.1 cache, §11.3 load profile), `deploy/README.md` (cutover gate), `tests/loadtest-summary.md` (cutover record template)

---

## 1. Problem

The rewrite exists for one reason: survive concurrent load on `t3.small` that the
single-asyncio-loop / single-shared-DuckDB-connection / per-session-reactive Python
Shiny app cannot. We need to *test* that claim across four dimensions the user named:
**availability, concurrency, request latency, and cache hit rate.**

The repo already ships load-test scaffolding (`tests/loadtest/k6/profile.js`,
`cold_burst.js`, a rich Prometheus surface, a cutover-gate checklist). The trouble is
that **all three existing gates can pass while hiding the exact failure mode the
rewrite is supposed to prevent.** Three structural reasons:

1. **Coordinated omission (closed-model load).** `profile.js` uses `ramping-vus` with
   2–8 s think time. 50 VUs ⇒ ~10 req/s. When the server slows, VUs simply wait longer
   and *offered load drops to match service rate* — so the reported `p95<200` can never
   stall and the true overload cliff is invisible. Every capacity/SLO/tail claim must
   come from an **open-model** (arrival-rate) executor instead.

2. **Emergent (not measured) cache hit rate.** 60% of `profile.js` traffic is
   5 regulators × 2 datasets ≈ 10 keys that always live in the 128 MiB ristretto cache,
   and the gate explicitly pre-warms. So `p95<200` measures **ristretto + gzip, not
   DuckDB**, and `cache_hit(popular)>0.85` is trivially satisfied. Hit rate must be a
   **controlled independent variable** (Zipfian over real manifest cardinality) with a
   **cold** variant, or the cutover SLO is self-congratulatory.

3. **Fixture-vs-real.** Nothing in the harness pins *which* `.duckdb` is loaded.
   `tests/fixtures/tfbp_test.duckdb` is tiny: it never spills, never produces a
   >6.4 MiB response, never approaches `memory_limit=800MB` or `mem_limit=1.6g`, and its
   query latency is microseconds. **All four goals require the real artifact on real
   `t3.small`-class hardware.** Fixture runs validate harness *mechanics* only.

And the most operationally dangerous moments are entirely **untested today**:

- **Post-deploy cold-start cliff** — version-scoped keys + no TTL mean a new artifact
  invalidates 100% of the cache *atomically*; the whole user base then misses through
  2 pool slots at once. The cutover gate's `hit>0.85` is a steady-state figure that is
  briefly 0 after every deploy.
- **t3.small burst-credit cliff** — the host is burstable; a 10-min run lives on
  accumulated CPU credits and looks fast, then sustained DuckDB+gzip load drains
  `CPUCreditBalance` and throttles to ~20% baseline around hour-2.
- **`/readyz` shares the 2-slot pool** — `health.go` runs `SELECT 1 FROM
  artifact_manifest` through the same pool with a 2 s timeout, so it 503-flaps under
  saturation though the process is healthy. Cosmetic today, but self-amplifying restarts
  the instant anyone wires it to a compose healthcheck or LB probe.

## 2. Goals

All four are stated as measurable outcomes, not raw user counts.

- **G1 — Validate cutover SLOs (honestly).** Establish the highest sustained
  **arrival rate** (req/s) at which `p95<200 ms ∧ p99<500 ms ∧ http_req_failed==0 ∧
  dropped_iterations==0` holds, reported for **both** a warm/pre-warmed posture and a
  **cold/full-cardinality** posture. The cold number is the defensible cutover figure.
- **G2 — Find the breaking point.** Determine the capacity ceiling on `t3.small` and
  **classify the degradation mode** (graceful queue-then-504 vs OOM-kill vs CPU-credit
  throttle vs spill-disk-full), with early-warning signal (`db_pool_wait` rate rising
  before failures) confirmed.
- **G3 — Prove it beats legacy.** Under one pinned, non-cherry-pickable methodology,
  show Go holds availability + latency at a concurrency where the Python Shiny app
  degrades. Deliverable is a documented protocol + a req/s-at-SLO crossover.
- **G4 — Ongoing coverage + CI.** Exercise the full endpoint surface (not just
  `/binding` + `/comparison/topn`), add soak/endurance for leaks + burst cliff, and a
  lightweight per-PR regression guard so performance can't silently rot.

## 3. Non-goals / scope

- **No new science, no query changes.** This is a *measurement* effort. The only
  production-code changes are the three small instrumentation additions in §7.
- **No absolute-ms assertions on the fixture.** CI gates on *behavior* and *relative*
  regression only. Authoritative ms numbers come from EC2 + real artifact exclusively.
- **No multi-instance / autoscaling tests.** Production is a single `t3.small` per
  spec §3; horizontal scaling is out of scope.
- **Head-to-head (G3) is a fast-follow, not a cutover blocker.** Cutover is gated on
  Phase B (§11).

## 4. Background — existing infrastructure we keep and build on

**k6 scripts (`tests/loadtest/k6/`, run via `make loadtest-profile` /
`make loadtest-cold-burst`):**

- `profile.js` — `ramping-vus` 0→50/1m, hold 8m, 50→0/1m. Mix 60% popular `/binding`,
  30% varied `/binding`, 10% `/comparison/topn`. Think 2–8 s. Tracks `popular_latency_ms`
  Trend + `popular_cache_hit` Rate (via `X-Cache`). Thresholds `http_req_failed==0`,
  `p95<200`, `p99<500`. **→ demoted to "warm smoke."**
- `cold_burst.js` — `per-vu-iterations`, 100 VUs × 1 iter, ≤5 s, one cold `/binding`
  URL. `setup()` asserts `cache_hits_total==0` (fresh restart). `teardown()` prints
  `/metrics` deltas. Gates `singleflight_shared_calls_total≥99`,
  `db_query_duration_seconds_count{endpoint=binding/data}==1`, `cache_misses_total==1`,
  `cache_hits_total==0`. **→ kept as the single-key coalescing gate.**
- `thresholds.js`, `lib/random_query.js` — kept; extended.

**Prometheus surface (`/metrics`):** `http_request_duration_seconds{route,status}`
(default buckets), `http_request_bytes`/`http_response_bytes{route}`,
`db_query_duration_seconds{query_name}`, `db_pool_wait_duration_seconds` (histogram of
per-5s-tick **means** — quantiles understate; prefer the counters),
`db_pool_wait_duration_seconds_total` + `db_pool_wait_count_total` (counters),
`db_pool_open_connections` / `db_pool_in_use` (gauges, 5s sample),
`cache_hits_total{endpoint}` / `cache_misses_total{endpoint}` /
`singleflight_shared_calls_total{endpoint}`, `cache_admission_rejected_total` /
`cache_oversize_responses_total` / `cache_evictions_total` (global), `artifact_version_info`,
plus `go_goroutines` / `process_*`. Hit rate = `hits/(hits+misses)`.

**Constraints (spec §6.3):** DuckDB read-only, `threads=1`, `memory_limit=800MB/conn`,
`MaxOpenConns=2`, spill to `tfbp_tmp` (EBS, ≤2 GB), 30 s query timeout; HTTP
`ReadTimeout 10s` / `WriteTimeout 6m` / router `Timeout 30s` (except `/export`);
`RequestGuard` 32 keys / 32 KiB per value; cache 128 MiB, version-scoped no-TTL keys,
key = `{artifactVersion}|{method}|{path}|{canonical-sorted-query}` (param/CSV/JSON-key
order all canonicalized); DoS caps `MaxFiltersBytes=16KiB`, `MaxSearchChars=64`,
`top_n∈[1,1000]`, datasets ≤ manifest size, explicit regulators ≤30; bogus id → 400,
stale version → 410 + `Location`; `/export` uncached, streamed, semaphore size 1;
container `mem_limit=1.6g` swap disabled (breach = immediate OOM-kill).

## 5. Key insights that shape the design

Two prerequisites gate everything downstream, so the harness is built around them:

- **A correct load model.** Open-model arrival-rate executor, generator **off-box**,
  `dropped_iterations==0` thresholded. Without this, every tail/capacity number is a
  coordinated-omission artifact.
- **A controlled cache posture.** Hit rate driven as an independent variable via a
  Zipfian sampler over the *real* manifest cardinality, varying **values not key order**
  (canonicalization collapses order). On this app, latency is almost entirely "hit rate
  funneled through a 2-slot, `threads=1` pool," so an uncontrolled hit rate makes the
  SLO number meaningless.

With those two in place, one scenario file parameterizes into SLO / capacity / soak /
head-to-head / CI. The full pitfall list (the traps that produce false confidence) is
catalogued in §12.

## 6. Architecture — one parameterized harness

Every scenario is a *configuration* of two executors over shared libraries — not a
bespoke script.

```
tests/loadtest/k6/
  lib/
    config.js      # NEW  BASE_URL, resolveVersion() in setup(); env knobs:
                   #      TARGET_RATE, DURATION, HIT_RATE, KEYSPACE_MODE, ZIPF_EXP, ARTIFACT_KIND
    keyspace.js    # NEW  regulators pulled from REAL manifest (GET /datasets/{db}/regulators);
                   #      real dataset combos + valid filters; Zipfian sampler (tunable exponent);
                   #      varies VALUES not just ORDER; order-only variant kept as a canonicalization test
    mix.js         # NEW  weighted per-endpoint session model + valid URL/filter/effect/pvalue/method/col builders
    metrics.js     # NEW  scrape+parse /metrics; delta helpers (hits/misses/singleflight/db_query_count/
                   #      pool-wait counter-pair); reusable setup()/teardown()
    thresholds.js  # KEEP + extend: dropped_iterations==0, availability rate>0.995
    random_query.js# KEEP back-compat for demoted profile.js
  scenarios/       # NEW  arrival_slo.js, hitrate_curve.js, breakpoint.js, cold_fanout.js,
                   #      cold_start_cliff.js, soak.js, coverage.js, smoke.js,
                   #      export_contention.js, error_abuse.js, oversize.js
  chaos/           # NEW  host-side: docker kill/stop, temp-dir fill, OOM induce, /readyz poll,
                   #      CPUCreditBalance + RSS + goroutine + temp-bytes sampler
  headtohead/      # NEW  Shiny WebSocket/action adapter + pinned-methodology doc
  profile.js       # KEEP demoted to "warm smoke"
  cold_burst.js    # KEEP single-key singleflight gate
  README.md        # KEEP + run matrix
```

**Two executors are the backbone:**

- **`ramping-arrival-rate`** (open model) — fixed req/s, `preAllocatedVUs≈200`,
  `maxVUs≈500`, `dropped_iterations==0` threshold. Powers G1 SLO ladder, G2 breakpoint,
  G4 soak. **This is the single most important change.**
- **`per-vu-iterations`** — N VUs fire once each, for thundering-herd (cold-fanout, and
  the retained `cold_burst.js`).

**Decision (confirmed):** keep `profile.js` and `cold_burst.js` rather than fold/delete
them — they become a fast warm smoke + the single-key coalescing gate.

## 7. Backend instrumentation — three cheap additions, done first

Small Go changes that make the knee and the cliff directly *readable* instead of inferred.
These ship in **Phase A** before any EC2 run so every later measurement is sharper.

1. **`http_in_flight_requests` Gauge** — `Inc` at start of `RequestLogger`, `Dec` in a
   `defer` that survives `Recoverer` (no leak on panic). Unit-test the Inc/Dec balance.
   *No concurrency metric exists today;* this de-risks interpreting saturation more than
   anything else.
2. **Per-route DB-time attribution** — add a `route` label to `db_query_duration_seconds`
   *or* a per-route `db_time_seconds_total` counter in the `GetOrLoad` wrapper, so the
   "DuckDB vs gzip+marshal+scheduling" split is computable from metrics on a 2-vCPU box.
3. **`cache_admission_rejected_total` / `cache_oversize_responses_total` →
   `CounterVec[endpoint]`** (the `endpoint` label already exists at the `GetOrLoad` call
   site) so a hot-but-oversize response that silently never caches is attributable.

*Optional, low-risk:* a ristretto budget-utilization gauge (`CostAdded`/`CostEvicted`),
and tighter latency-histogram bucket edges at `.15/.2/.3/.5` so server-side quantiles are
usable as a cross-check near the 200/500 ms gate.

**Decision (confirmed):** these production-code touches are in scope. They are additive,
behind the existing metrics registry, and unit-tested.

## 8. Environment, data, and measurement validity

| Tier | What runs | What it produces |
|------|-----------|------------------|
| **Local + fixture** (CI, harness dev) | smoke, coverage mechanics, small-K cold-fanout, metric-delta arithmetic, negative cases | harness correctness, X-Cache flips, **relative** regression — *never absolute ms* |
| **EC2 t3.small + REAL artifact, k6 OFF-box** | every authoritative scenario | the cutover SLO, capacity ceiling, soak, head-to-head |

**Hard rules baked into the harness:**

- **k6 runs on a separate box.** Co-location steals the 2 vCPU + burst credits and
  misattributes k6 saturation as server latency.
- **Calibration gate before any authoritative run** — k6 host CPU < ~70% and
  `dropped_iterations==0`; cross-check k6 p95 against the server histogram; document the
  closed-vs-open p99 delta (the coordinated-omission error). (Menu item: *measurement-
  validity calibration run*.)
- **Real artifact is mandatory for perf numbers.** Every scenario logs the loaded
  `artifactVersion` (from `/api/version`) into its summary; a summary stamped with the
  fixture version is rejected as non-authoritative.
- **`resolveVersion()` in `setup()`** for every scenario (never hard-code a version, or
  an artifact bump silently yields 410s / 0% hit rate / a bogus "regression").
- **Pool-wait reporting standardized** on `rate(db_pool_wait_duration_seconds_total) /
  rate(db_pool_wait_count_total)`; the histogram quantiles are deprecated in summaries.

## 9. The test scenarios

Each row is a scenario file (or host-side script) with its measurement target and
explicit pass/fail. Grouped by goal; priority is must/should/could.

### 9.1 G1 — Validate cutover SLOs

- **`arrival_slo.js` — open-model SLO (warm + cold)** *(must)*. `ramping-arrival-rate`,
  step rate (e.g. 5→40→80 req/s, hold 3–5 m each), reuse the 60/30/10 mix. Run **warm**
  (pre-warmed hot set) and **cold** (fresh restart, no pre-warm). **Pass:** `p95<200 ∧
  p99<500 ∧ http_req_failed==0 ∧ dropped_iterations==0` at target rate; the honest
  cutover number is the highest req/s where all hold on the **cold** variant.
- **Realistic full-endpoint mix (`lib/mix.js`)** *(must)*. ~50% cheap cached (datasets,
  fields, regulators, comparison/dto, sample-conditions), ~35% expensive cached (binding,
  perturbation, binding/corr, selection/matrix, comparison/topn), ~10% medium
  (regulators/resolve, scatter); export tested separately. **Pass:** warm gates hold
  under the realistic mix; per-endpoint `p95` tagged; measured per-endpoint hit rate
  matches the intended distribution.
- **`hitrate_curve.js` — hit-rate-controlled latency curve (`lib/keyspace.js`)** *(must)*.
  Zipfian over real cardinality, sweep target hit rates ≈0.5/0.7/0.85/0.95. **Pass:**
  achieved per-endpoint hit rate within ±3% of intended; at the 0.85 operating point
  `p95<200 ∧ p99<500 ∧ failed==0`. **Deliverable:** the p95-vs-hit-rate curve (predicts
  post-deploy behavior).
- **Availability SLO + `/readyz`-under-load probe** *(must)*. Add a low-rate tagged
  `GET /readyz` + `/healthz` arm running concurrently with the ramp; custom
  `Rate('readyz_available')`. **Pass:** `http_req_failed≤0.5% ∧ readyz_available≥0.99 ∧
  warm p95/p99 hold ∧ 0 OOM`. **Headline finding to document:** the `/readyz` 503-flap
  under saturation, plus the warning *not* to wire `/readyz` to a healthcheck/LB probe.
- **Measurement-validity calibration run** *(should)*. Procedure layered over the
  open-model scenario (see §8).

### 9.2 G2 — Find the breaking point

- **`breakpoint.js` — capacity ramp to failure + degradation-mode classification**
  *(must)*. `ramping-arrival-rate` pushed past the knee (e.g. to 150–300 req/s) with a
  low-reuse keyspace (mostly misses) hitting expensive endpoints (`/comparison/topn` near
  `top_n=1000`, `/selection/matrix`, `/binding/corr`). **Pass/record:** the knee (max
  req/s at SLO) and the cliff (first sustained 5xx / OOM); confirm failure is **graceful
  queue-then-504** (Recoverer catches panics) not 500/crash/silent-hang-past-30s; confirm
  `db_pool_wait_count` rate rises *before* failures.
- **`cold_fanout.js` — distinct-cold-key pool-saturation burst** *(must)*.
  `per-vu-iterations`, ~50–200 VUs each requesting `key[vu % K]` over K distinct cold
  keys, fresh restart. **Pass:** `sum(db_query_duration_seconds_count) deltas == K` (not
  N callers); `singleflight_shared_calls_total == N-K`; `cache_misses_total == K`;
  graceful queueing, bounded latency, zero 5xx, no `/readyz` 503. **Document** the
  concurrent-distinct-key count where mean pool-wait > ~50 ms. (Small K=4 version → CI.)
- **Memory-pressure + spill chaos** *(must, real artifact only)*. Concurrent worst-case
  requests (export `datasets=all` no filters + `/comparison/topn top_n=1000` loose
  thresholds) to push both 800 MB conns toward spill; separately pre-fill `tfbp_tmp`
  toward 2 GB; induce an OOM. **Pass:** peak RSS < 1.5 GB; spill keeps queries completing
  (slow but 200); temp-full surfaces as a clean 500 + structured log not a crash; induced
  OOM auto-restarts to `/readyz 200` in < 30 s **without** re-running the profile-gated
  init container (artifact persists in `tfbp_data`); corrupted artifact fails-fast
  non-zero.
- **`cold_start_cliff.js` — post-deploy cold-start cliff** *(must)*. Drive steady
  Zipfian traffic at the validated SLO rate to warm; restart/swap artifact mid-run;
  continue the *same* traffic and measure recovery (two k6 phases bracket the restart).
  **Pass:** no `http_req_failed` / no `/readyz` 503 during the cliff; recovery to
  `hit>0.85` within an operator-acceptable window (e.g. < 60 s) at steady arrival rate.
  If recovery never completes (arrival rate > cold-miss service rate through 2 slots),
  *that is the deploy-time capacity ceiling.*
- **`oversize.js` — ristretto oversize / admission / eviction probe** *(should)*. Phase 1
  repeatedly request the same large key (`/selection/matrix`, wide `/binding`,
  `/comparison/topn top_n≈1000`) watching `X-Cache` + admission counter; phase 2 walk
  30–50 distinct large keys to force eviction. **Pass/record:** large key HITs on 2nd
  request *or* `cache_admission_rejected_total` increments (→ raise budget / shed largest
  endpoints from cache); `evictions>0` in phase 2; **largest observed response size** as
  a `BudgetBytes` sizing input.
- **GOMAXPROCS vs `threads=1` / gzip-CPU contention experiment** *(could)*. Run the
  breakpoint ramp twice (default vs pinned GOMAXPROCS / container CPU limits; optionally
  Accept-Encoding on/off). **Outcome:** identify DuckDB-bound vs Go-CPU-bound; if gzip is
  the culprit, `Compress(5)`→lower is a concrete cutover lever.

### 9.3 G3 — Prove it beats legacy

- **Head-to-head vs legacy Python Shiny (pinned methodology)** *(should)*. Pin the
  protocol **first** (same `t3.small` class, same real data, same arrival-rate mix mapped
  to equivalent user actions, same warm/cold, same duration). Run the same ladder against
  `tfbindingandperturbation.com` (Go) and `legacy.tfbindingandperturbation.com` (Shiny)
  through Traefik. Build a per-target adapter mapping Go REST endpoints to Shiny
  WebSocket/reactive actions (the hard part). **Deliverable:** a documented protocol table
  + req/s-at-SLO for each, with the WebSocket-vs-REST asymmetry caveated. **Pass:** at the
  concurrency where Shiny's success-rate/p99 degrades, Go still meets the availability SLO
  + warm latency.

### 9.4 G4 — Ongoing coverage + CI

- **`coverage.js` — all-endpoint sweep + per-route DB attribution** *(should)*. Iterate
  every cached+medium route once cold then once warm (assert `X-Cache` MISS→HIT;
  `no-store` on `/export,/healthz,/readyz,/metrics,/api/version`); run each expensive
  endpoint single-VU serial to align the two histograms; validate 410 on stale version,
  400 on bogus identifier. **Pass:** every endpoint 200 with correct `X-Cache` +
  `Cache-Control`; cold→warm flips; 410/400 negatives correct; per-route latency table +
  route-vs-DB gap recorded.
- **`smoke.js` — lightweight CI regression guard (fixture, relative baselines)**
  *(should)*. In GitHub Actions against `tests/fixtures/tfbp_test.duckdb`: ~20 req/s for
  30–60 s over the full endpoint set + negative checks (bogus regulator→400, stale
  version→410, >16 KiB filters→400/413, `top_n` clamp, >32 query keys→RequestGuard,
  non-GET→405). **Pass:** `failed==0` on happy path; every negative returns its expected
  status; `X-Cache` MISS-then-HIT; CI fails on **relative** p95 regression beyond
  threshold. **Explicitly does not assert absolute < 200 ms on the fixture.** Pair with a
  scheduled real-artifact EC2 run storing k6 JSON summaries for a trend chart. New target
  `make loadtest-smoke`.
- **`soak.js` — soak / endurance** *(should, real t3.small)*. `constant-arrival-rate` at
  ~60–70% of the measured SLO knee, realistic Zipfian mix, 2–4 h; sample `/metrics` every
  30–60 s + CloudWatch credits; optionally pin instance to `standard` (not `unlimited`)
  credit mode so the throttle is observable. **Pass:** RSS plateaus < 1.5 GB; goroutines
  bounded; hit rate stable; evictions steady-state; zero failed; no OOM. **A sharp latency
  step coinciding with `CPUCreditBalance→0` defines the *sustained* ceiling** (lower than
  the short-run ladder ceiling) and argues for `t3.small-unlimited` or larger at cutover.
- **Container-kill / restart-recovery resilience** *(should)*. Layer over `profile.js` at
  ~30 VUs: `docker kill` (SIGKILL) and separately `docker stop` (SIGTERM drain); repeat
  once with a deliberately corrupted `/data/tfbp.duckdb`. **Pass:** SIGTERM drains within
  `WriteTimeout`; SIGKILL recovery `/readyz 200` < 30 s on a healthy volume with **no**
  init run; corrupted artifact exits non-zero and does not bind the listener; k6 sees only
  connection errors during the gap.
- **`export_contention.js` — `/export` + semaphore=1 isolation** *(could)*. VU A fires a
  large `/export` (`datasets=all`, no filters), VU B a 2nd export (expect 408 at ~30 s),
  VUs C hammer cached/expensive JSON endpoints. **Pass:** at most 1 export in flight;
  co-running JSON `p95` unaffected; 2nd export 408s cleanly; exports never grab both pool
  slots; no OOM from streaming the tar.gz.
- **`error_abuse.js` — error-path + abusive-but-legal payload load** *(could)*. Open-model
  flood of stale-version (410+Location), bogus-identifier (400), non-GET (405), plus
  maximal-legal payloads (`top_n=1000` × all-datasets CSV × ~16 KiB filters × 64-char
  search) alongside a baseline of normal traffic. **Pass:** reject paths correct + cheap +
  **no pool consumption**; maximal-legal completes within 30 s without OOM and without
  pushing normal-traffic `p95` over SLO.

## 10. Reporting & CI

- Every scenario emits a k6 JSON summary via `--summary-export`, stamped with
  `artifactVersion` + host + git SHA.
- **`tests/loadtest-summary.md` v2** replaces the current template, with: open-model SLO
  table (**warm and cold**, honest cutover number), hit-rate-vs-p95 curve, breaking-point
  (knee + cliff + classified mode), availability/error-budget, soak trend (RSS /
  goroutines / `CPUCreditBalance`), head-to-head crossover. Pool-wait reported via the
  counter-pair ratio.
- **CI:** `make loadtest-smoke` + a GitHub Action against the fixture (behavior +
  relative regression). A separate scheduled workflow runs the real-artifact EC2 ladder
  and appends to a trend store.

## 11. Phasing — and what gates cutover

- **Phase A (local, ~3–4 d):** §7 instrumentation (+ unit-test the in-flight Inc/Dec
  balance under Recoverer); build `config.js` / `keyspace.js` / `mix.js` / `metrics.js`;
  the open-model executor; wire `smoke.js` + `coverage.js` + small-K `cold_fanout.js` into
  `make` targets and a GitHub Action against the fixture.
- **Phase B (EC2 t3.small, real artifact, k6 off-box, ~1–2 d):** calibration →
  warm+cold SLO ladder → hit-rate curve → breakpoint + classify → `/readyz`-under-load +
  export isolation + abusive-legal. **← cutover is gated here.** Fill
  `loadtest-summary.md`.
- **Phase C (long EC2 sessions):** memory/spill chaos + container-kill recovery + 2–4 h
  soak (samples `CPUCreditBalance`) + post-deploy cold-start cliff.
- **Phase D (fast-follow, not a blocker):** head-to-head vs Shiny — methodology pinned in
  writing *before* any run.

Keep the CI guard + the scheduled real-artifact run for ongoing G4 coverage after cutover.

## 12. Pitfalls catalogue (the traps this design defends against)

Ranked; each maps to a design decision above.

1. **Fixture-vs-real** — the dominant trap; nothing pins the loaded `.duckdb`. → §8
   real-artifact-mandatory + version-stamped summaries.
2. **Closed-model coordinated omission** — `profile.js` self-throttles. → §6 open-model
   executor + `dropped_iterations==0`.
3. **Emergent ~99% hit rate** — ~10 hot keys + pre-warm measure ristretto+gzip. → §9.1
   hit-rate-controlled curve + cold variant.
4. **`/readyz` shares the 2-slot pool** (`health.go`: `SELECT 1` via `s.Pool.DB`, 2 s
   ctx) — 503-flaps under saturation. → §9.1 readyz-under-load probe + the "don't wire it
   to a healthcheck" warning.
5. **t3.small burst-credit cliff** — invisible to any 10-min run. → §9.4 soak sampling
   `CPUCreditBalance`.
6. **Singleflight masks DB contention both ways** — one hot key = one query regardless of
   VUs; the real danger is N *distinct* cold keys. → §9.2 `cold_fanout.js` (varied keys).
7. **Post-deploy cold-start cliff** — version keys + no TTL invalidate 100% atomically. →
   §9.2 `cold_start_cliff.js`.
8. **`db_pool_wait_duration_seconds` is a distribution-of-5s-means**, and `db_pool_in_use`
   can read 0 during a sub-5s burst. → §8 standardize on the counter-pair ratio; never
   conclude "pool never saturated" from the gauge.
9. **Canonicalization collapses keys** (param/CSV/JSON-key order) — vary *values*, not
   order. → §6 `keyspace.js` varies values; order-only variant is a positive
   canonicalization test.
10. **`memswap=mem=1.6g`, swap disabled** — breach is immediate OOM-kill; the init
    container is profile-gated and does *not* run on a plain restart. → §9.2 chaos test
    verifies recovery without init + fail-fast on corrupted artifact.
11. **Route→DB-time attribution gap** — two differently-labelled histograms. → §7 per-route
    DB-time metric.
12. **Coarse histogram near the SLO** (edges at .1/.25 s) — server-side `p95` interpolated.
    → gate on k6's exact p95/p99; §7 optional tighter buckets for the cross-check.
13. **k6 co-location + dropped iterations** — generator becomes the bottleneck. → §8
    off-box + calibration.
14. **Coverage hole** — only `/binding` + `/comparison/topn` ever load-tested. → §9.4
    `coverage.js` + the full mix.
15. **Stale-version 410 + versioned keys** from a hard-coded version. → §8
    `resolveVersion()` in `setup()`.
16. **Head-to-head fairness** — Shiny is WebSocket, no REST; naive same-URL 404s and
    falsely "wins." → §9.3 pinned methodology + action adapter.
17. **Parity ≠ performance** — green parity/CI doesn't imply SLOs hold. → §3 non-goal +
    §8 real-artifact runs.

## 13. Instrumentation gaps deliberately deferred

The §7 additions are the must-haves. These are noted but out of initial scope: a derived
ristretto budget-utilization gauge (nice-to-have for `BudgetBytes` tuning) and any
in-app `CPUCreditBalance`/spill-bytes metric (covered instead by the host-side sampler in
`chaos/`, since these are platform signals, not app state).

## 14. Open questions

1. **Off-box generator host.** Where does k6 run for Phase B/C — a second EC2 in the same
   AZ (lowest network noise), or a laptop over the internet (adds WAN latency to every
   sample)? Recommendation: a small same-AZ EC2.
2. **Soak credit mode.** Run the soak on `standard` credit mode (throttle observable) vs
   `unlimited` (production-realistic but hides the cliff)? Recommendation: one run each —
   `standard` to *find* the cliff, `unlimited` to confirm the production posture.
3. **Head-to-head action mapping fidelity.** How faithfully must Shiny WebSocket actions
   mirror the Go REST mix for the comparison to be defensible? To be pinned in the Phase D
   methodology doc before any run.
```
