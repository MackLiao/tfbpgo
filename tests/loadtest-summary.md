# Cutover load-test summary — TEMPLATE

> **This is a TEMPLATE.** The cutover gate (warm + cold-burst k6 runs, peak-RSS
> measurement, parity diff, observability checklist) is an **operational step**
> performed by the operator on the production EC2 host. Docker and k6 are
> required and are **not** available in the development environment that
> generated this file. The committed copy is therefore unfilled; the operator
> replaces each `<FILL IN>` placeholder with the actual measurement and commits
> the updated copy alongside the cutover deploy.
>
> See `deploy/README.md` for how to run each gate and where its numbers come
> from. See `docs/superpowers/specs/2026-05-12-go-react-rewrite-design.md`
> §11.3 for the authoritative gate definitions.

---

## Environment

```
Cutover date (UTC):      <FILL IN — e.g. 2026-05-14>
Host:                    <FILL IN — e.g. ec2-XX-XX-XX-XX.compute-1.amazonaws.com (t3.small)>
Backend version:         <FILL IN — git SHA or tag, e.g. v1.0.0 / abc1234>
Image digest:            <FILL IN — e.g. ghcr.io/brentlab/tfbpshiny-go@sha256:...>
Artifact key:            <FILL IN — e.g. tfbp/2026-05-13/tfbp.duckdb>
Artifact sha256:         <FILL IN — 64-char hex from .env>
DuckDB version (binary): <FILL IN — go.mod duckdb-go/v2 release>
```

## Warm-cache profile (§11.3.2 / §11.3.3)

Run on the production host **after** pre-warming the popular regulator subset
(see `deploy/README.md` §"Cutover gate"). Numbers come from
`profile-result.csv` (k6 `--out csv=...`) and `ps -o rss=`.

| Metric                              | Gate         | Measured       | Pass? |
| ----------------------------------- | ------------ | -------------- | ----- |
| `http_req_duration` p95             | < 200 ms     | `<FILL IN>` ms | `<✓/✗>` |
| `http_req_duration` p99             | < 500 ms     | `<FILL IN>` ms | `<✓/✗>` |
| `http_req_failed` rate (5xx + net)  | == 0         | `<FILL IN>`    | `<✓/✗>` |
| Peak RSS                            | < 1.5 GB     | `<FILL IN>` MB | `<✓/✗>` |
| `cache_hit_ratio` (popular segment) | > 0.85       | `<FILL IN>`    | `<✓/✗>` |
| `db_pool_wait_duration_seconds` p95 | < 100 ms     | `<FILL IN>` ms | `<✓/✗>` |
| OOM kills (`dmesg`)                 | == 0         | `<FILL IN>`    | `<✓/✗>` |

How to derive each:
- p95/p99/failed rate → k6 summary at end of `profile.js` run.
- Peak RSS → `while sleep 1; do ps -o rss= -p $(pidof tfbp-server); done` during the run; record max.
- `cache_hit_ratio` (popular) → from `cache_hits_total{segment="popular"} / (cache_hits_total + cache_misses_total)` over the run window via Prometheus / `/metrics` deltas; can also be eyeballed from the k6-emitted `popular_cache_hit` rate if the backend exposes `X-Cache`.
- `db_pool_wait_duration_seconds` p95 → `/metrics` histogram quantile over the run window.
- OOM kills → `dmesg -T | grep -i 'killed process' | grep tfbp-server` after the run.

## Cold-burst (singleflight coalescing, §11.3.3)

Run **immediately after a backend restart** (cache cleared) using `cold_burst.js`.
The teardown block prints the relevant `/metrics` deltas; the operator records
the before/after diffs here.

| Metric                                                    | Gate     | Δ during burst | Pass? |
| --------------------------------------------------------- | -------- | -------------- | ----- |
| `singleflight_shared_calls_total`                         | ≥ 99     | `<FILL IN>`    | `<✓/✗>` |
| `db_query_duration_seconds_count{endpoint="binding/data"}`| == 1     | `<FILL IN>`    | `<✓/✗>` |
| `cache_misses_total` Δ for the burst URL                  | == 1     | `<FILL IN>`    | `<✓/✗>` |
| `cache_hits_total` Δ for the burst URL                    | == 0     | `<FILL IN>`    | `<✓/✗>` |
| `http_req_failed` rate                                    | == 0     | `<FILL IN>`    | `<✓/✗>` |

`cache_hits_total` must NOT increase during the burst: the 99 singleflight
waiters receive the in-flight result directly from `singleflight.Do`, and
the loader populates the cache exactly once at the very end of its single
SQL round-trip — none of the 100 in-burst requests go through the
ristretto-hit path. Requests issued *after* the burst settles would be
hits, but those are out of scope for this gate.

## Parity (§11.3.1)

After Task 2's fixture widening, all 11 golden URLs must match their committed
snapshots byte-for-byte.

```
make parity
```

| Endpoint count | Pass? |
| -------------- | ----- |
| 11 / 11        | ✓     |

(If anything regresses, `make parity` exits non-zero and prints the diffing URL.)

## Bundle size (spec §7.5)

Measured from `frontend/dist/assets/plotly-*.js` after `pnpm build`:

| Chunk                  | Target              | Measured       | Notes |
| ---------------------- | ------------------- | -------------- | ----- |
| Plotly chunk (gzip)    | < 512 000 bytes     | 512 649 bytes  | +649 B / +0.13% over target. Accepted at cutover unless first-paint regresses measurably in DevTools side-by-side during the warm-cache k6 run. |
| Plotly chunk (raw)     | informational       | 1 488 717 bytes | |
| Initial entry (gzip)   | informational       | `<FILL IN>` KB | Measure via `du -hb frontend/dist/assets/index-*.js` (gzipped Vite output). |

Decision at cutover (delete whichever doesn't apply):
- [ ] **ACCEPT** the 0.13 % overage — load test shows no measurable first-paint regression.
- [ ] **DROP** a trace (`scattergl` or `heatmap` — pick least-used) and rebuild.

## Observability checklist

Verify each on the running container during the cutover window:

- [ ] `/healthz` returns 200.
- [ ] `/readyz` returns 200 and reports artifact metadata.
- [ ] `/api/version` returns `{ artifactVersion, schemaVersion, ... }`.
- [ ] `/metrics` exposes every counter / histogram in spec §6.7
  (`http_requests_total`, `http_request_duration_seconds`, `cache_hits_total`,
  `cache_misses_total`, `cache_admission_rejected_total`,
  `cache_oversize_responses_total`, `singleflight_shared_calls_total`,
  `db_query_duration_seconds`, `db_pool_wait_duration_seconds`,
  `db_pool_open_connections`, `db_pool_in_use_connections`).
- [ ] Structured logs (`docker compose logs tfbp`) include `artifact_version`,
  `route`, `status`, `duration_ms` on every request line.
- [ ] Stale `/api/v/{v}/...` request with a non-current `{v}` returns **410**
  with `Location: /api/version` header.
- [ ] `legacy.tfbindingandperturbation.com` resolves and returns the Shiny app;
  `tfbindingandperturbation.com` returns the Go SPA (see Task 13 in the Phase 3 plan).

---

## How to fill this in

1. Provision artifact + image per `deploy/README.md` §"Routine deploy".
2. Pre-warm + run `tests/loadtest/k6/profile.js` → fill the warm-cache table.
3. `docker compose restart tfbp`, then run `tests/loadtest/k6/cold_burst.js` →
   fill the cold-burst table.
4. `make parity` against the running backend → confirm 11/11.
5. Tick the observability boxes.
6. `git add tests/loadtest-summary.md && git commit -m "docs(cutover): record
   load-test summary for <date>"` and push, then proceed with DNS cutover.
