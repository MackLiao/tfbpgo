# TFBPShiny Rewrite — Go Backend + React Frontend

**Status:** Design (proposed)
**Date:** 2026-05-12
**Author:** MackLiao (with Claude as drafting partner)

---

## 1. Problem

The current Python Shiny deployment of TFBPShiny fails under concurrent load.
Observed and inferred failure modes on the production `t3.small` (2 vCPU, 2 GB
RAM) instance:

1. **Out-of-memory kills.** Per-session reactive state plus the shared
   `VirtualDB` (DuckDB + HuggingFace cache) approaches the 2 GB RAM ceiling
   when more than one user is active.
2. **Event-loop saturation.** Shiny for Python runs a single asyncio event
   loop in a single process. Any CPU-bound reactive computation (`_topn_data`,
   Pearson/Spearman aggregates) blocks every concurrent session until it
   finishes.
3. **DuckDB contention.** All sessions share a single `vdb` instance and a
   single DuckDB connection. Concurrent queries serialize on that connection
   and can produce lock errors.

Recent in-tree optimizations (PR #266, PR #280, Apr 26 reactivity fix) cut
single-session DB time from 73.7s to 6.4s and the `_topn_data` rerun factor
from 2.40× to 1.00×. **These were per-session wins.** They do not address
the multi-user concurrency ceiling. With more than ~2 concurrent users on the
current stack, the app degrades from "slow" to "unresponsive" to "crashed."

**The bottleneck is framework/process model, not query SQL.** The current
SQL is already well-shaped: `topn_all_pairs_sql`, `corr_all_pairs_sql`,
and the dataset-matrix counts all use single `UNION ALL` round-trips
rather than per-pair loops. This rewrite does not chase query-level
optimization. It eliminates: (a) the single-process event loop that
serializes all users, (b) the single shared DuckDB connection, (c) the
absence of cross-session result reuse, (d) runtime data-init memory cost
from labretriever + HuggingFace cache living in the serving process.

The decision: rewrite the application stack to one that is concurrent by
construction, with a true cross-session result cache so that N users asking
the same question pay 1 query.

## 2. Goals

Goals are stated as measurable workload targets, not as raw user counts.
"≥N concurrent users" is meaningless without specifying the workload mix;
acceptance is defined against a documented load profile (see §11.3).

- **Warm-cache performance.** For the load profile defined in §11.3,
  p95 API latency < 200 ms and p99 < 500 ms on `t3.small`.
- **Cold-cache containment.** Cold-cache p95 for expensive endpoints
  (`/api/comparison/topn`, `/api/binding`, `/api/perturbation`) is
  measured and bounded explicitly, not lumped with warm-cache numbers.
- **Request coalescing.** N concurrent identical cold requests result in
  exactly 1 DuckDB query, not N (singleflight; see §8.1).
- **Bounded memory.** RSS stays below 1.5 GB on `t3.small` (75% of 2 GB)
  under the load profile. Zero OOM kills.
- **Cross-session result reuse.** Identical query parameters from different
  users return cached results in <10 ms.
- **Reach feature parity** with the current Shiny app: Home, Select Datasets,
  Binding, Perturbation, Comparison.
- **Preserve scientific correctness.** All plots and tables must produce
  numerically identical results to the current app for the same inputs
  (within defined floating-point tolerances).
- **Deep-linkable URLs.** Every view should be reachable by URL alone (the
  current app cannot do this).

## 3. Non-goals

- **No new analyses.** Parity first; new features come after cutover.
- **No authentication.** The app remains publicly accessible, matching today.
- **No multi-tenant data isolation.** All users see the same datasets.
- **No real-time data updates from HuggingFace.** Data refresh is an
  offline/CI concern.
- **No multi-instance horizontal scaling on day one.** Design must not
  preclude it, but one Go process on one box must hit the concurrency target.

## 4. High-level architecture

```
┌────────────────────────────────────────────────────────────────┐
│  CI step (Python, runs on schedule or manually)                │
│   • Uses existing labretriever + brentlab_yeast_collection.yaml│
│   • Materializes a single immutable file: tfbp.duckdb          │
│   • Publishes artifact to S3 (or bakes into Docker image)      │
└────────────────────────────┬───────────────────────────────────┘
                             │ (artifact)
                             ▼
┌────────────────────────────────────────────────────────────────┐
│  Go backend (single binary, in Docker)                         │
│   • chi router + middleware (logging, gzip, cors, timeout)     │
│   • duckdb-go/v2 read-only pool (MaxOpenConns=2 initial)       │
│   • DuckDB: threads=1, memory_limit + spill (see §6.3)         │
│   • ristretto + singleflight (cache stampede protection)       │
│   • Stateless: no per-session storage                          │
│   • Endpoints return JSON only; paths versioned by artifact    │
└────────────────────────────┬───────────────────────────────────┘
                             │ HTTPS JSON
                             ▼
┌────────────────────────────────────────────────────────────────┐
│  React SPA (built with Vite, served as static files)           │
│   • All UI state in URL + Zustand store                        │
│   • Plotly.js for all charts                                   │
│   • Suspense + loading skeletons per panel                     │
│   • Served by the same Go binary as static assets              │
└────────────────────────────────────────────────────────────────┘
```

All services sit behind the existing Traefik reverse proxy on the same EC2
instance. No new infrastructure is required for day-one deployment.

## 5. Data pipeline (offline prep)

The biggest architectural simplification in the rewrite: **data preparation
moves out of the runtime application entirely.**

### 5.1 Why externalize

Today, `app.py` starts a background thread that calls `initialize_data()`,
which uses labretriever to download datasets from HuggingFace, populate
DuckDB, and register derived tables (`hackett_analysis_set`,
`dto_expanded`). This work happens on every app boot, contributes to the
2 GB memory pressure, requires the `hf_cache` Docker volume, and depends on
the `HF_TOKEN` env var being present at runtime.

The data is **read-only** during a deployment lifetime. There is no reason
for the runtime process to know how to download it.

### 5.2 New flow

A standalone Python script — `data_prep/build_duckdb.py` — does what
`utils/vdb_init.py` does today, but writes the final DuckDB state to a file:

1. Open a fresh DuckDB connection backed by `tfbp.duckdb` (the file is the
   target from the start, so all work persists in it).
2. Read `brentlab_yeast_collection.yaml`.
3. Use labretriever to download datasets from HuggingFace (with `HF_TOKEN`
   from the CI environment) and load them into the DuckDB file.
4. Materialize the **VirtualDB-shape compatibility layer** as real tables
   inside the file (not views), so the Go service does no derivation at
   runtime. See §5.5 for the full table list.
5. Materialize the **manifest tables** that the Go service uses for
   identifier whitelisting, version checks, and filter-level caching.
   See §5.5.
6. `CHECKPOINT` and close the connection. `tfbp.duckdb` is now a single
   self-contained file.
7. Upload `tfbp.duckdb` to S3 with a versioned key (e.g.,
   `s3://tfbp-data/2026-05-12.duckdb`) and update a `latest` pointer.

### 5.3 Runtime consumption

The Go backend, on startup:

1. Downloads `tfbp.duckdb` from S3 (or reads it from a bind-mounted path if
   baked into the image).
2. Opens it read-only via `duckdb-go/v2`.
3. Initializes the connection pool.
4. Starts serving HTTP.

Cold start should be under 10 seconds. The Go process holds no HF
credentials and cannot reach HuggingFace; this is a security and
operational simplification.

### 5.4 Refresh cadence

For the initial cutover the data is essentially static — refreshed manually
when collection contents change. A future enhancement is to wire the
data-prep script to a scheduled GitHub Actions job and have the Go service
detect new artifact versions, but this is **out of scope** for the rewrite
itself.

### 5.5 Tables inside the artifact

**Compatibility layer (preserves VirtualDB shape — the Go backend ports
today's SQL against these unchanged):**

| Table | Purpose |
|-------|---------|
| `{db_name}` (e.g., `callingcards`, `harbison`, `hackett`) | Raw per-dataset tables, one per `db_name` in the YAML config |
| `{db_name}_meta` | Per-dataset metadata (sample_id mapping, condition filters, etc.) |
| `dto_expanded` | DTO empirical p-values (currently a derived table) |
| `hackett_analysis_set` | Hackett-specific filtered sample set |
| `regulator_display_names` | Regulator locus_tag → display name mapping |

**Manifest / cache helper tables (new, cheap and broadly useful):**

| Table | Purpose |
|-------|---------|
| `artifact_manifest` | Single row with columns: `artifact_version` (string), `schema_version` (int — bumped when §5.5 tables/columns change), `built_at` (timestamp), `source_yaml_sha256`, `duckdb_version` (built-with), `parity_tests_passed` (bool). Used by the Go service for fail-fast startup (§9.5) and cache-key invalidation. |
| `dataset_manifest` | One row per dataset: `db_name`, `data_type` (binding/perturbation), assay, display name, source repo. Used to whitelist identifiers in dynamic SQL. |
| `field_manifest` | One row per (`db_name`, `field`): legal field names per dataset for filters and sorts. Used to whitelist identifiers. |
| `filter_level_cache` | Precomputed distinct-value sets for low-cardinality filter fields (e.g., carbon source, temperature). Avoids runtime `SELECT DISTINCT` for sidebar filter dropdowns. |

**Explicitly deferred:** canonical binding/perturbation projections and
precomputed aggregate tables. See Appendix D ADR.

## 6. Backend (Go)

### 6.1 Stack

| Concern | Choice | Rationale |
|---------|--------|-----------|
| HTTP router | `go-chi/chi` v5 | Idiomatic, stdlib-shaped, minimal |
| DuckDB driver | `github.com/duckdb/duckdb-go/v2` | Official DuckDB-org-maintained Go driver. `marcboeker/go-duckdb` (the predecessor) was archived in Oct 2025 and DuckDB forked it under their org. |
| `database/sql` ergonomics | `jmoiron/sqlx` | `StructScan`, named params, slice scanning — kills boilerplate without codegen. Works on any `database/sql` driver. |
| Dynamic SQL builder | `Masterminds/squirrel` | For queries where WHERE/ORDER clauses are user-driven (today's `_build_filter_where`) |
| Request coalescing | `golang.org/x/sync/singleflight` | Per-key cache-miss deduplication — N concurrent identical misses fire 1 DB query, not N |
| Cache | `dgraph-io/ristretto` | High-throughput in-process LRU with admission policy. Note: ristretto does **not** coalesce concurrent misses; singleflight handles that. |
| Logging | `log/slog` (stdlib) | Structured logs, no extra dep |
| Config | `caarlos0/env` + flags | 12-factor env vars |
| Metrics | `prometheus/client_golang` | Counters + histograms scraped at `/metrics` |
| Testing | stdlib `testing` + `testify/require` | Idiomatic |

**On ORMs and SQL codegen:** heavy ORMs (GORM, ent, bun) are rejected
because the workload is analytical and read-only — migrations, entity
lifecycle, and relations are unused costs that fight DuckDB-specific SQL.

A **codegen middle ground (sqlc) was considered and rejected** for a
specific reason: `sqlc` does not support DuckDB. Its query parsers target
PostgreSQL/MySQL/SQLite engines. The closest practical alternative is
`sqlx`, which is not a codegen tool but a thin layer over `database/sql`
that handles struct scanning, named parameters, and slice destinations.
SQL still lives in `.sql` files loaded at startup; the Go-side glue is
hand-written, kept small by `sqlx`, and tested directly against the
fixture DuckDB file (see §10.2).

For the small set of queries with user-driven dynamic WHERE clauses,
`Squirrel` builds the SQL string and `sqlx` executes it. All identifiers
in dynamic SQL are whitelisted against `dataset_manifest` /
`field_manifest` before being interpolated — see §6.4.

### 6.2 Project layout

Repo layout (top-level — three peer directories, not a Go monorepo):

```
tfbpshiny/                              # ← repo root
├── backend/                            # Go service
│   ├── cmd/
│   │   └── tfbp-server/main.go         # entrypoint
│   ├── internal/
│   │   ├── config/                     # env + flag parsing
│   │   ├── db/                         # DuckDB pool, query runner
│   │   ├── cache/                      # ristretto + singleflight wrapper
│   │   ├── api/                        # HTTP handlers
│   │   │   ├── datasets.go
│   │   │   ├── binding.go
│   │   │   ├── perturbation.go
│   │   │   └── comparison.go
│   │   ├── queries/                    # .sql files + Go loaders
│   │   │   ├── comparison/topn.sql
│   │   │   └── ...
│   │   └── domain/                     # request/response types
│   ├── static/                         # built React SPA (embedded at build time)
│   └── go.mod
├── frontend/                           # React SPA (Vite)
│   ├── src/
│   ├── package.json
│   └── vite.config.ts
├── data_prep/                          # Python — at repo root, not under backend/
│   ├── build_duckdb.py                 # produces tfbp.duckdb from HF + YAML
│   ├── build_fixture.py                # produces tests/fixtures/tfbp_test.duckdb
│   ├── pyproject.toml                  # poetry env, separate from any runtime
│   └── brentlab_yeast_collection.yaml  # source of truth for datasets (moved from tfbpshiny/)
├── tests/
│   ├── fixtures/tfbp_test.duckdb       # committed (binary, small)
│   ├── parity/                         # Python vs Go output diffs
│   └── loadtest/k6/profile.js          # cutover load profile
├── docs/
└── docker-compose.yml
```

Rationale: `data_prep` is Python and shares nothing with the Go service
except the schema contract in `tfbp.duckdb`. Putting it under
`backend/` would imply a coupling that doesn't exist. Repo-root
placement also matches the local-dev commands in §10.

### 6.3 Connection pool

The `database/sql` driver supports standard pooling. Open the file in
read-only mode with explicit resource limits. **Initial values are
conservative — DuckDB's intra-query parallelism interacts with pool size
and host CPU count in non-obvious ways, so the right tuning comes from
load-testing, not formulas.**

Initial configuration (start here, then benchmark). **Memory in DuckDB
is not perfectly bounded by `memory_limit`** — that setting governs the
buffer manager only; operator-local memory (large hashes, sorts,
aggregations) can transiently exceed it. Defense-in-depth therefore
layers four bounds: the DuckDB buffer limit, explicit spill to disk, a
modest in-process Go cache, and a Docker memory limit that kills the
container before the kernel OOM-killer makes the decision.

| Setting | Initial value | Notes |
|---------|---------------|-------|
| DuckDB `access_mode` | `read_only` | Multiple readers on the immutable file with no lock contention. |
| DuckDB `threads` | `1` | Each query runs single-threaded, leaving inter-query parallelism to the pool. Higher values starve concurrent queries on a 2-vCPU box. |
| DuckDB `memory_limit` | `800MB` (≈40% of 2GB) | Buffer-manager soft cap. **Some operations may exceed this.** Spill is mandatory (next two rows). |
| DuckDB `temp_directory` | `/tmp/duckdb` (bind-mounted tmpfs or ephemeral disk) | Spill target for operators that exceed memory budget. |
| DuckDB `max_temp_directory_size` | `2GB` | Hard cap on spill — query fails loudly if it blows past this, rather than filling the disk silently. |
| DuckDB `preserve_insertion_order` | `false` | Allows DuckDB to free more aggressively during aggregations. Result order is undefined for un-`ORDER BY`'d queries — we enforce `ORDER BY` on all queries where order matters. |
| Go cache budget (ristretto) | `128MB` (`CACHE_SIZE_BYTES=134217728`) | Lowered from initial 256MB to leave headroom on `t3.small`. Tune up if hit rate is poor and RSS has slack. |
| `MaxOpenConns` | `2` | Two simultaneous DB queries on `t3.small`. With `threads=1` per query, this saturates the 2 vCPUs without oversubscription. |
| `MaxIdleConns` | `2` | Match `MaxOpenConns`; the artifact is immutable so connection turnover is unwanted. |
| `ConnMaxLifetime` | `0` | Never recycle. File is immutable. |
| Query timeout | `context.WithTimeout(30s)` | Per-request, enforced at handler level. |
| Docker `mem_limit` | `1.6g` | Kernel-enforced cap on the container. If anything goes wrong upstream of the soft caps, the container dies cleanly with an OOM kill that surfaces in metrics, instead of the kernel killing a random process on the host. |
| Docker `memswap_limit` | `1.6g` (= `mem_limit`) | Disable swap; we want fast failure, not thrashing. |

**Total budget reconciliation** on a 2 GB `t3.small` (assuming ~200 MB
OS + ~50 MB Docker daemon + ~100 MB Go runtime):

- Available to container: ~1.6 GB
- DuckDB buffer: 800 MB (soft)
- Go heap + cache: ~256 MB (cache 128 MB + heap ~128 MB)
- DuckDB transient overruns: budget ~400 MB headroom before Docker kills
- Spill to disk catches anything past that

The 1.5 GB RSS gate in §11.3.3 is comfortable inside this budget. If
load tests show RSS climbing toward 1.5 GB consistently, lower DuckDB
`memory_limit` to 600 MB before raising Docker `mem_limit`.

Tuning is data-driven (see §6.7 metrics). After load tests:
- If `MaxOpenConns=2` is saturated and queries are CPU-bound on one core,
  consider `threads=2, MaxOpenConns=1` (intra-query parallelism instead
  of inter-query).
- If queries are I/O-bound (file reads), raise `MaxOpenConns` to 3–4 and
  re-measure.

Read-only mode is the single largest correctness win over the current
architecture (no lock contention on shared writes); the pool sizing is
the largest *throughput* lever and must be benchmarked.

### 6.4 Request lifecycle

For each request:

1. Parse and validate query parameters into a typed `Request` struct.
   Reject unknown fields explicitly.
2. **Whitelist all identifier-shaped inputs** (dataset names, field
   names, sort columns) against `dataset_manifest` / `field_manifest`
   loaded at startup. SQL builders **cannot parameterize identifiers**;
   anything that becomes part of the SQL string itself must pass
   whitelist check first or the request is rejected with 400.
3. Compute a canonical cache key from the struct (sorted, normalized,
   includes `artifact_manifest.version`).
4. Check ristretto. On hit, return the cached JSON bytes directly.
5. On miss, enter `singleflight.Group.Do(cacheKey, fn)`. The first
   caller for `cacheKey` runs `fn`; concurrent callers for the same
   `cacheKey` wait for and share the same result. This is the only
   reason "N concurrent identical cold misses → 1 DB query" is true.
6. Inside `fn`: acquire a connection from the pool (respecting query
   timeout), execute the SQL, scan results via `sqlx.StructScan` into a
   `Response` struct, marshal to JSON, **call `cache.Set(...)` with the
   response size as cost**, check the bool return (false →
   `cache_admission_rejected_total++`), **call `cache.Wait()` so the
   write is visible to the next request before returning**, return.

See §8.1 for the subtleties around ristretto's admission policy and
buffered writes — these two extra lines (Set-return check + Wait)
are load-bearing.

Cache values are pre-serialized JSON bytes. This avoids re-marshalling on
hits and bounds memory cost precisely.

Cache keys are scoped to artifact version (step 3): when a new artifact
is published and the service is restarted, the new version becomes part
of every key and the old cache is effectively invalidated without
explicit flushing.

### 6.5 Endpoint surface (draft)

Endpoints divide into **versioned** (data — path includes the artifact
version so client-side and proxy caches can apply `immutable` headers)
and **unversioned** (operational + version discovery).

Let `v = artifact_manifest.artifact_version` (e.g., `2026-05-12`). The
frontend reads `/api/version` once at app load and substitutes `v` into
every subsequent URL.

**Versioned data endpoints** — `Cache-Control: public, max-age=31536000, immutable`:

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/v/{v}/datasets` | List binding + perturbation datasets with metadata tags |
| GET | `/api/v/{v}/binding?regulator=...&datasets=...` | Binding view data |
| GET | `/api/v/{v}/perturbation?regulator=...&datasets=...` | Perturbation view data |
| GET | `/api/v/{v}/comparison/topn?binding=...&perturbation=...&filters=...` | Top-N responsive ratio matrix |
| GET | `/api/v/{v}/comparison/dto` | DTO empirical p-values |
| GET | `/api/v/{v}/regulators?search=...` | Regulator autocomplete |

**Unversioned operational endpoints** — `Cache-Control: no-store`, ETag where relevant:

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/version` | Returns `{artifactVersion, schemaVersion, builtAt, duckdbVersion}` from `artifact_manifest`. Frontend bootstrap reads this once. |
| GET | `/healthz` | Liveness |
| GET | `/readyz` | Readiness (verifies DuckDB pool + cache) |
| GET | `/metrics` | Prometheus scrape endpoint |

If a request arrives at a versioned path with `v` ≠ current artifact
version, the backend returns 410 Gone with a `Location:` header
pointing the client at `/api/version` to re-bootstrap.

OpenAPI spec is generated from Go structs (via `swaggo/swag` or hand-written).
**The API is locked only after backend parity verification (see §11).**

### 6.6 Concurrency model

One goroutine per HTTP request (Go's default `net/http` model). Cache
hits never touch the pool. Cache misses pass through `singleflight` so
N concurrent identical misses produce 1 DB query, not N. Goroutines that
need a DB connection acquire one from the pool (size 2 initially) and
block if all are in use; the per-request `context.Context` carries the
30s timeout so a stuck connection cannot wedge the system.

Worst case under load: 1000 concurrent users on different uncached
queries queue against the pool (with the initial pool size of 2, that
means at most 2 in flight at any time); 1000 concurrent users on the
*same* uncached query produce exactly 1 DB call (singleflight) and 999
share its result. The realistic load profile is much closer to the
second case — everyone clicks the same popular regulators.

### 6.7 Observability

Metrics are first-class, not deferred. The current Shiny app has no
production observability; the rewrite must not repeat that mistake.

Exposed at `/metrics` (Prometheus text format):

| Metric | Type | Labels |
|--------|------|--------|
| `http_request_duration_seconds` | histogram | `route`, `status` |
| `http_request_bytes` / `http_response_bytes` | histogram | `route` |
| `db_query_duration_seconds` | histogram | `query_name` |
| `db_pool_wait_duration_seconds` | histogram | — |
| `db_pool_open_connections` / `db_pool_in_use` | gauge | — |
| `cache_hits_total` / `cache_misses_total` | counter | `endpoint` |
| `singleflight_shared_calls_total` | counter | `endpoint` (number of waiters that got coalesced) |
| `cache_evictions_total` | counter | — |
| `process_resident_memory_bytes` | gauge | — (stdlib `process_collector`) |
| `go_memstats_*` | gauge | (stdlib `go_collector`) |
| `artifact_version_info` | gauge (constant 1) | `version`, `built_at`, `duckdb_version` |

Structured `slog` logs are emitted at INFO for every request with
`route`, `status`, `latency_ms`, `cache_hit`, `db_ms`, `bytes`,
`artifact_version`. Logs are JSON, captured by Docker, scrapable by the
existing CloudWatch agent.

A separate `tests/loadtest/` directory contains `k6` scripts that drive
the load profile defined in §11.3, used both pre-cutover for acceptance
and post-cutover for regression.

## 7. Frontend (React)

### 7.1 Stack

| Concern | Choice | Rationale |
|---------|--------|-----------|
| Build | Vite | Fast, idiomatic, well-documented |
| Framework | React 18 | User preference |
| Routing | React Router v6 | URL is source of truth for view state |
| Data fetching | TanStack Query | Cache, retries, suspense, dedupe |
| State (client) | Zustand | Lightweight, less ceremony than Redux |
| Plotting | Plotly.js (custom bundle, lazy-loaded) | Only credible option for scientific scatter/heatmap. See §7.5 for bundle strategy. |
| Styling | Tailwind CSS | Matches simplicity goals |
| Component library | shadcn/ui (Radix primitives) | Accessible, headless, no theme lock-in |

### 7.2 URL is the state model

The current Shiny app holds all UI selections in per-session reactive
values. In the new app, selections live in the URL query string:

```
/comparison?binding=cc.2026,harbison&perturbation=hackett&top_n=25&effect=0.5
```

Benefits:

- Bookmarkable / shareable views (currently impossible).
- Zero server-side session state — every request carries everything it
  needs.
- Cache key derivation is trivial (it *is* the URL).
- Browser back/forward "just works."

The Zustand store mirrors the URL for ergonomic component access but the
URL remains canonical.

**Compact encoding for large filter sets.** Some Shiny views allow
filtering by "common regulators between dataset A and dataset B" — which
naively serializes as hundreds of locus tags in the URL and blows past
browser URL length limits (~2000 chars in practice). The new app uses
compact expressions resolved server-side:

- `common=binding.callingcards:binding.harbison` — common regulators between two binding datasets
- `intersect=A,B,C` — N-way intersection
- `regulators=YBR289W,YML007W,...` — only when the user has explicitly chosen specific tags (≤30)

The backend resolves the expression once and includes it in the cache
key. Two users with the same logical filter share a cache hit even if
the underlying regulator list is large.

### 7.3 Module boundaries

Each current Shiny module maps to a React route:

| Shiny module | React route |
|--------------|-------------|
| home | `/` |
| select_datasets | `/select` |
| binding | `/binding` |
| perturbation | `/perturbation` |
| comparison | `/comparison` |

Each route is a top-level component composing smaller panels. Panels fetch
their own data via TanStack Query, so each panel has independent loading,
error, and refetch behavior.

### 7.4 Loading and error UX

- **Skeleton states** while data is in flight (Plotly's empty plot looks
  ugly; skeletons are nicer).
- **Per-panel error boundaries** so one failed query doesn't blank the
  whole page.
- **Stale-while-revalidate** via TanStack Query — when the user navigates
  back to a previously visited URL, the old data renders immediately while
  the cache is revalidated.

### 7.5 Plotly bundle strategy

The default `plotly.js` bundle is ~3 MB minified, which is unacceptable
for a dashboard that mostly renders scatter + heatmap + bar charts. The
correct approach is a **true custom bundle** built from Plotly's
`core` + selected traces, not the `-strict` variant (which is the
no-eval security build, *not* a trace selector).

Approach:

1. Import `plotly.js/lib/core` — base library with no traces registered.
2. Register only the traces actually used during Phase 2 (final list
   confirmed by auditing every Plotly call site in the current Shiny
   app):
   ```js
   import Plotly from "plotly.js/lib/core";
   import scatter from "plotly.js/lib/scatter";
   import scattergl from "plotly.js/lib/scattergl";  // for large point clouds
   import heatmap from "plotly.js/lib/heatmap";
   import bar from "plotly.js/lib/bar";
   import histogram2d from "plotly.js/lib/histogram2d";

   Plotly.register([scatter, scattergl, heatmap, bar, histogram2d]);
   ```
3. Build the React wrapper via `react-plotly.js/factory`:
   ```js
   import createPlotlyComponent from "react-plotly.js/factory";
   const Plot = createPlotlyComponent(Plotly);
   ```
4. Lazy-load the module that exports `Plot` via `React.lazy()` so the
   initial route bundle does not include it. Suspense boundary shows a
   skeleton while the chunk loads on first use.
5. Final list of registered traces is audited and locked at the end of
   Phase 2; adding a new trace later is a deliberate bundle-size
   review, not an automatic import.

Bundle target: < 500 KB gzipped for the Plotly chunk. Verify with
`vite build --analyze` (or `rollup-plugin-visualizer`) and check in the
bundle report alongside the load-test summary at cutover.

### 7.6 HTTP caching headers

The browser does its own caching when given the right headers. Strategy:

- **Versioned API paths.** Every API request goes through
  `/api/v/{artifactVersion}/...`. The artifact version comes from
  `artifact_manifest` at backend startup and is exposed via
  `/api/version`. The frontend reads it once at app load and includes
  it in every URL.
- **`Cache-Control: public, max-age=31536000, immutable`** on responses
  from versioned paths. The URL itself carries the version; cached
  responses can never go stale because a new artifact means a new URL.
- **`ETag`** as a secondary signal for `/api/version` and other
  unversioned endpoints.
- **No `Cache-Control: max-age=86400`** on unversioned paths. That
  pattern silently breaks the moment data refreshes.

TanStack Query's in-memory cache is a third layer on top, deduping
within a single tab.

## 8. Caching strategy

Three coordinated layers ship on day one. Redis is deferred.

### 8.1 Backend cache + request coalescing (ships day one)

The backend cache is a **stack**, not a single thing:

1. **Ristretto** (in-process LRU with admission policy) — stores
   pre-serialized JSON response bytes.
2. **`singleflight.Group`** — guards every cache fill. Concurrent
   misses for the same key collapse to one DB call.
3. **Version-scoped keys** — every cache key has
   `artifact_manifest.version` baked in.

Properties:

- Key: `{artifactVersion}|{method}|{path}|{canonical-sorted-query}`.
- Value: pre-serialized JSON response bytes (so cache hits do no
  re-marshalling).
- Cost: payload byte size (used by ristretto's budget enforcement).
- Budget: 128 MB initial (configurable via `CACHE_SIZE_BYTES`); see
  §6.3 for the budget reconciliation.
- TTL: none. The version in the key handles invalidation: a new
  artifact = new version = new keys = old entries age out naturally.

**Subtleties of ristretto we must handle correctly:**

Ristretto's `Set()` is *asynchronous and may reject*. Two things follow:

1. **`Set()` returns a bool indicating admission, not commit.** TinyLFU
   admission can reject items it judges unlikely to be requested again
   (especially large items on a cold cache). The handler MUST check
   the return value and increment `cache_admission_rejected_total` on
   `false`. Repeated rejections of large popular responses indicate
   the budget is too small or `MaxCost` needs tuning.
2. **`Set()` is buffered — `Get()` immediately after `Set()` may miss.**
   This matters inside `singleflight.Do`: the caller that ran `fn`
   stores into cache and returns, but the *next* request right
   afterward may still miss until ristretto's buffer drains. To make
   the post-fill visibility deterministic, the handler calls
   `cache.Wait()` after `Set()` before returning. This adds a few
   microseconds and prevents a thundering herd from re-running
   singleflight on every popular cold key until the buffer flushes.
3. **Oversize responses bypass admission.** Responses larger than ~5%
   of the cache budget are unlikely to be admitted under default
   policy. The handler measures response size; if it exceeds
   `OversizeThreshold = cache_budget / 20`, it logs a structured warn
   `{event:"oversize_response", endpoint, bytes}` and increments
   `cache_oversize_responses_total`. These are signals to either
   raise the budget or split the endpoint.

Metrics surface every failure mode:

| Metric | What it means |
|--------|---------------|
| `cache_hits_total` / `cache_misses_total` | Steady-state |
| `singleflight_shared_calls_total` | Number of concurrent waiters coalesced into one DB call — proves stampede protection is firing |
| `cache_admission_rejected_total` | Ristretto refused to store the response — budget too small or item unlucky in TinyLFU |
| `cache_oversize_responses_total` | Response too large for the budget; admission almost certainly rejected |
| `cache_evictions_total` | LRU pushing things out under pressure |

**Why this stack and not just ristretto:** ristretto's admission policy
prevents *cache pollution* but does nothing about *concurrent identical
misses*. Without singleflight, 100 users hitting a popular cold
regulator each execute the DB query before the first populates the
cache. Conversely, without admission/oversize handling, the cache can
silently fail to admit hot responses and turn every popular request
into a singleflight gate — much slower than the cache hit path.

### 8.2 Browser cache (ships day one)

Defined in §7.6. Summary:

- API requests use `/api/v/{artifactVersion}/...` paths.
- Responses on versioned paths: `Cache-Control: public, max-age=31536000, immutable`.
- ETag fallback for unversioned endpoints (`/api/version`).
- TanStack Query in-memory cache as a third layer per tab.

### 8.3 Redis (deferred)

Only needed if/when we run more than one Go instance, so cache hits are
shared across replicas. The `internal/cache` interface in §6.2 is
designed to accept either backend; we do not implement the Redis adapter
until horizontal scaling is on the roadmap. Singleflight remains
in-process even with Redis (it coordinates per-instance miss handling).

## 9. Deployment

Same shape as today: Docker Compose behind Traefik on the existing EC2
instance.

### 9.1 New service definition

The Shiny service is replaced (not augmented) by a Go service:

```yaml
services:
  tfbp:
    image: ghcr.io/brentlab/tfbpshiny-go:${TAG}
    environment:
      - DUCKDB_PATH=/data/tfbp.duckdb
      - CACHE_SIZE_BYTES=268435456
      - LOG_LEVEL=info
    volumes:
      - tfbp_data:/data:ro
    labels:
      - traefik.http.routers.tfbp.rule=Host(`tfbindingandperturbation.com`)
      - traefik.http.routers.tfbp.tls.certresolver=letsencrypt
```

The `tfbp_data` volume is populated by an init container (or one-shot
container) that downloads the latest DuckDB artifact from S3.

### 9.2 Removed

- `hf_cache` volume
- `HF_TOKEN` env var
- `python-dotenv` plumbing

These all leave the runtime. They live in CI for the data-prep job.

### 9.3 Static assets

The React SPA build output (`dist/`) is embedded in the Go binary via
`embed.FS` and served from `/` by the same `chi` router. Single artifact,
single port, single TLS cert.

### 9.4 Health checks (multi-level)

Health endpoints distinguish *liveness* from *readiness* and report
*why* on failure. Both endpoints return JSON.

| Endpoint | Returns 200 when | Used by |
|----------|------------------|---------|
| `/healthz` | Process is running and the HTTP server is accepting | Docker / orchestrator liveness probe |
| `/readyz` | `/healthz` + DuckDB file open + `artifact_manifest` readable + canary query (e.g., `SELECT 1 FROM artifact_manifest LIMIT 1`) succeeds | Traefik / load balancer readiness probe |
| `/api/version` | Returns `{version, builtAt, duckdbVersion}` from `artifact_manifest` | Frontend at startup; humans for debugging |

`/readyz` returning 503 with `{ready: false, reason: "..."}` lets
Traefik take the instance out of rotation immediately on artifact
corruption, schema mismatch, or DuckDB open failure.

### 9.5 Startup contract (fail-fast)

The Go service performs these checks before opening its HTTP listener.
Any failure exits with a non-zero status and a single structured log
line — the container is not allowed to enter a "running but broken"
state.

The checks separate **must-match** invariants (artifact contract) from
**should-record** facts (build provenance). Exact patch-level DuckDB
version matching is *not* a gate — that would block safe upgrades
between forward-compatible DuckDB releases. Storage-format
compatibility and schema-version contract are the actual gates.

1. `tfbp.duckdb` exists and is readable; SHA256 matches the manifest
   provided by the artifact store (if download was used).
2. DuckDB opens in read-only mode.
3. `artifact_manifest` table exists and has exactly one row.
4. **Storage format compatibility check.** DuckDB returns
   `current_setting('storage_compatibility_version')` (or the
   appropriate API call); the runtime DuckDB must be able to read this
   storage version. The open itself fails if it can't, but we
   explicitly log the storage version on success for auditability.
5. **Artifact schema version contract.**
   `artifact_manifest.schema_version` is an integer maintained by us
   (separate from DuckDB version). The Go binary embeds the minimum
   and maximum compatible schema versions it understands; startup
   fails if the artifact is outside that range. This is the actual
   compatibility gate — bump the schema version when we change the
   set of tables in §5.5 or the meaning of their columns.
6. **DuckDB version log (record, do not gate).** Read
   `artifact_manifest.duckdb_version` (the version used to build the
   artifact) and the runtime version; log both. Do not exit on
   mismatch — let storage compatibility and parity tests be the gates.
7. All tables listed in §5.5 (compatibility + manifest) exist.
8. Canary query (one representative `SELECT` per major endpoint family)
   succeeds — this is the runtime-side parity smoke test.
9. **Parity test marker (optional).** If
   `artifact_manifest.parity_tests_passed` is `false` or NULL, log a
   WARN but do not exit. Production deploys gate this in CI; the
   runtime treats it as informational.
10. The startup line is logged at INFO:
    `{"event":"startup_ok","artifact_version":"2026-05-12","schema_version":3,"artifact_duckdb_version":"1.x.y","runtime_duckdb_version":"1.x.z","storage_version":"v1.2"}`.

Only after step 10 does the HTTP listener bind.

## 10. Local development

Docker is **not** required to develop on this stack. It enters the picture
only at Phase 3 (deployment). The local loop is faster than the current
Shiny app because there is no reactive replay, no per-session restart, and
no Docker rebuild on every change.

### 10.1 Two-terminal dev loop

```bash
# Terminal 1 — Go backend (rebuilds and restarts on save with `air` or just rerun)
cd backend
go run ./cmd/tfbp-server --duckdb=./tfbp.duckdb --port=8080

# Terminal 2 — React frontend (Vite dev server, proxies /api → :8080)
cd frontend
npm run dev   # serves on :5173 by default
```

Vite's `server.proxy` config routes `/api/*` to `http://localhost:8080` so
the frontend sees a unified origin in dev exactly as it will in prod.

### 10.2 Three ways to get a `.duckdb` file locally

Pick the one that matches what you're doing:

| Use case | Command | Time | Notes |
|----------|---------|------|-------|
| **Real data for local dev** | `make data-pull` | ~30s | Downloads the latest `tfbp.duckdb` artifact from S3. Requires AWS read access. |
| **First-time bootstrap, no S3** | `make data-build` | 5–10 min first time | Runs `poetry run python data_prep/build_duckdb.py`. Requires `HF_TOKEN` in `.env`. HF cache makes subsequent builds fast. |
| **Tests (unit + integration)** | (none — file is committed) | instant | `tests/fixtures/tfbp_test.duckdb` — small synthetic DuckDB with 3 regulators × 2 datasets, built by `data_prep/build_fixture.py` and checked into the repo. |

The fixture file is the load-bearing one. Tests must not pull from S3 or
rebuild from HuggingFace; they must run in milliseconds against the
committed fixture. The fixture is regenerated and re-committed when the
upstream schema changes — a deliberate manual step, not on every CI run.

### 10.3 What you do not run locally

- **Docker / Docker Compose** — only needed to test the production image
  before deploying. Day-to-day dev never touches it.
- **Traefik** — production-only.
- **S3** — only the data-pull path touches it, and even that is optional
  if you build locally.

### 10.4 SQL organization (no codegen)

There is no codegen step in this stack — sqlc does not support DuckDB
(see §6.1 rationale). SQL lives in `.sql` files under
`backend/internal/queries/{module}/*.sql`, loaded into string constants
at startup via `embed.FS`. Each query has a thin hand-written Go
function next to it that takes a typed `Request` struct and returns a
typed `Response` struct, using `sqlx.StructScan` to populate result
slices. These wrapper functions are tested directly against
`tests/fixtures/tfbp_test.duckdb`.

## 11. Migration & cutover

### 11.1 Cutover style: big-bang

The current app is small enough (~4k LOC of server code, 4 active modules)
that maintaining two parallel stacks is not worth the integration tax.
**The new stack ships when it reaches parity; the old Shiny app moves to
`legacy.tfbindingandperturbation.com` for a 30-day grace period and is then
retired.**

### 11.2 Implementation order: sequential, backend first

The highest-risk part of the rewrite is **query parity** — does Go +
`duckdb-go/v2` produce numerically identical results to the current
labretriever + Python DuckDB code for the same inputs? If the frontend
session builds against a paper API spec while the backend session is still
porting queries, query-parity bugs will be discovered at the worst possible
time (integration).

**Phases:**

1. **Phase 0 — Data prep + version contract.** Stand up
   `data_prep/build_duckdb.py` to produce a `tfbp.duckdb` file
   equivalent to what the current `initialize_data()` leaves in memory
   at runtime. Verify by point-checking known queries against the
   current app's results. **Also write `data_prep/build_fixture.py`**
   to emit `tests/fixtures/tfbp_test.duckdb` — a small synthetic file
   used by all downstream tests. **Record DuckDB build version + storage
   version + schema_version into `artifact_manifest`** so the runtime's
   startup contract (§9.5) can enforce compatibility without
   over-constraining patch-level upgrades. Phase 1 depends on the
   fixture file existing.

2. **Phase 1 — Backend.** Build the Go service with all endpoints. Include
   a minimal **reference HTML view** (Go stdlib `html/template`, no design
   work) that renders raw plot data and tables for visual side-by-side
   comparison with the current Shiny app. Iterate until every regulator,
   every panel, every filter combination matches numerically. **The API
   contract is frozen at the end of this phase.**

3. **Phase 2 — Frontend.** Build the React SPA against the now-running
   backend with its frozen OpenAPI spec. Plotly.js renders all charts.
   Each route reaches parity with the corresponding Shiny module.

4. **Phase 3 — Deployment + cutover.** Update Docker Compose, swap
   Traefik routing, move old Shiny to `legacy.` subdomain.

Phases 1 and 2 *can* be parallelized after Phase 1 reaches a stable API
contract, but the recommendation is sequential because the developer
count is one.

### 11.3 Acceptance criteria for cutover

The cutover gate is **structured around a documented load profile**, not
a vague "feels fast" check. All criteria must be measured and reported.

#### 11.3.1 Numerical parity

- A curated regression set of 20–50 "golden URLs" covers all 4 module
  routes and exercises each major filter combination.
- For each golden URL, the JSON response from the Go backend matches the
  output of the equivalent labretriever/Shiny query within defined
  floating-point tolerances (relative ≤ 1e-9 for most fields; tighter
  for integer counts; documented per field).
- Parity comparison is a checked-in test (`tests/parity/`) that runs the
  current Python query and the new Go endpoint against the same fixture
  and diffs the results. Test fails on any field outside tolerance.

#### 11.3.2 Load profile

The acceptance load test models realistic dashboard usage:

| Parameter | Value |
|-----------|-------|
| Duration | 10 minutes |
| Virtual users (peak) | 50 |
| Ramp | 0 → 50 over 1 min, hold 8 min, ramp down |
| Think time per action | 2–8s uniform |
| Action mix | 60% popular-regulator (cache-friendly), 30% varied-regulator, 10% deep-filter combinations |
| Cache state at start | One pre-warmed run for "warm" criteria; cold-restart run for "cold" criteria |

Scripts live at `tests/loadtest/k6/profile.js`.

#### 11.3.3 Performance gates

Gates are split into two runs of the load profile (§11.3.2). The
**warm run** starts after a pre-warming pass; the **cold-burst run**
uses a separate dedicated script.

**Warm-run gates** (cache populated by a pre-warm pass before measurement):

| Gate | Threshold |
|------|-----------|
| Warm-cache p95 latency | < 200 ms |
| Warm-cache p99 latency | < 500 ms |
| 5xx rate | 0 |
| 4xx rate (user errors excluded) | 0 |
| OOM kills during run | 0 |
| Peak RSS | < 1.5 GB |
| `db_pool_wait_duration_seconds` p95 | < 100 ms |
| `cache_hit_ratio` for the popular-regulator subset | > 0.85 |
| `cache_admission_rejected_total` for hot keys | 0 (after warmup) |

**Cold-burst gate** (separate test in `tests/loadtest/k6/cold_burst.js`):
- 100 virtual users fire the **same uncached URL** within a 500 ms window.
- Verify: `singleflight_shared_calls_total` reports ≥ 99 shared calls
  for that key (one ran the DB query, the rest waited).
- Verify: `db_query_duration_seconds` shows exactly 1 query for that key.
- This is the only gate that directly proves coalescing works. It is
  pointless to expect it in the warm run, where the cache is already
  populated and no misses occur.

**Cold-cache containment** (separate run, restart between iterations):
- Cold-cache p95 for `/api/comparison/topn` measured and reported.
  Not gated until baseline is established post-cutover. The number is
  recorded in the load-test summary committed alongside the cutover.

#### 11.3.4 Functional / UX

- Deep-link sanity: every URL in the regression set survives a hard
  reload, browser back/forward, and being shared between users.
- All Shiny modules visible at parity in the React app: Home, Select
  Datasets, Binding, Perturbation, Comparison.
- Plotly bundle gzip size < 500 KB.

#### 11.3.5 Observability

- `/metrics` exposes all metrics listed in §6.7.
- `/api/version` returns artifact metadata.
- Structured logs visible in CloudWatch with `artifact_version` on
  every request line.
- A load-test summary report is committed alongside the cutover
  commit, including cache hit rate, singleflight share count,
  pool wait distribution, and peak RSS.

## 12. Risks & open questions

### 12.1 Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| `duckdb-go/v2` produces numerically different results than Python DuckDB for some CTE/aggregate | Medium | High | Storage-format and schema-version compatibility enforced at startup (§9.5); golden parity tests (§11.3.1) compare every endpoint against reference; pre-API-freeze reference HTML view |
| `dto_expanded` / `hackett_analysis_set` derivation can't be reproduced offline | Low | High | Same Python code path as `utils/vdb_init.py` — just runs at build time instead of boot time |
| Pool sizing wrong on first deploy → starvation or oversubscription | Medium | Medium | Conservative initial values (§6.3); load-test gates (§11.3.3) catch this before cutover; metrics surface it post-cutover |
| Singleflight bypassed by subtle cache-key differences | Low | High | Canonicalize cache keys explicitly (sort + normalize); `singleflight_shared_calls_total` metric proves coalescing is firing in load tests |
| CGO complicates Docker builds | Medium | Medium | `duckdb-go/v2` ships prebuilt static bindings (`duckdb-go-bindings`); multi-stage Dockerfile; CGO-enabled builder image |
| Identifier whitelist gaps allow SQL injection via dynamic SQL | Low | Critical | All dynamic SQL builds against `dataset_manifest` / `field_manifest`; identifiers not in manifest → 400; security test suite enumerates manifest and asserts every legal value is accepted, every illegal value is rejected |
| Plotly chunk lazy-load adds first-plot latency | Medium | Low | Chunk preloaded on route entry via React Router loader; budget < 500 KB gzipped |
| Artifact corruption / partial S3 download | Low | High | Startup fail-fast (§9.5); SHA256 verification at download time |

### 12.2 Open questions (deferred to writing-plans, not blocking)

- **Artifact storage:** S3 bucket vs. baked-in image vs. GitHub Release
  artifact. Lean toward S3 + versioned key for cheap rebuilds.
- **Authentication for `legacy.` subdomain:** Should the legacy Shiny be
  IP-restricted to internal users during the grace period?
- **Error tracking:** Sentry on the React side — probably yes, but
  free-tier limits and DSN management need confirmation.
- **k6 vs. Locust vs. Vegeta for load tests:** All viable. k6 is the
  current default in §6.7 but the plan can substitute.

## 13. Out of scope (explicit)

- Authentication / user accounts.
- Per-user saved selections.
- Real-time data refresh from HuggingFace.
- Mobile-specific layouts (responsive, but not phone-first).
- Multi-instance Redis-backed caching.
- Any new scientific analysis not present in the current Shiny app.

---

## Appendix A — Why not the alternatives we considered

- **Option A (Rust + SPA):** Maximum ceiling but slowest to parity; for
  this workload the Go vs. Rust performance delta is small (DuckDB
  dominates), while the developer-velocity delta is large.
- **Option C (FastAPI + SPA):** Cheapest path to "stop crashing" but does
  not satisfy the user's stated goal of leaving the Python/Shiny stack.

## Appendix B — Files that go away

- `tfbpshiny/` (entire package)
- `tfbpshiny/utils/vdb_init.py` (logic moves to `data_prep/`)
- All `*/page_test.py` files (replaced by React component tests)
- `hf_cache` Docker volume

## Appendix C — Files that get rewritten in another language

- `tfbpshiny/modules/*/queries.py` → `backend/internal/queries/*/*.sql` +
  Go loader code (the SQL is the source of truth; both languages just
  parameterize and execute it)
- `tfbpshiny/modules/*/ui.py` and `server/*.py` → React route components
- `tfbpshiny/components.py` + `app.css` → shadcn/ui components + Tailwind

## Appendix D — ADR: Immutable runtime artifact, preserve VirtualDB shape, defer canonical serving schema

**Status:** Accepted

**Context.** A "rewrite" could reasonably mean two very different
scopes: (1) keep today's logical data shape and change only how it is
served, or (2) redesign the data model into a normalized fact schema
optimized for the new serving stack. (2) is tempting because the
current per-dataset schemas (callingcards, harbison, hackett, etc.)
differ in subtle ways and a unified shape would simplify some SQL.

**Decision.** Adopt scope (1) for the initial rewrite.

The runtime artifact `tfbp.duckdb` preserves today's VirtualDB-shaped
tables verbatim:

- `{db_name}` and `{db_name}_meta` per dataset
- `dto_expanded`
- `hackett_analysis_set`
- `regulator_display_names`

The Go backend ports today's SQL against this compatibility layer
without redesign. The only additions are cheap, broadly-useful
manifest tables (§5.5):

- `artifact_manifest`, `dataset_manifest`, `field_manifest`,
  `filter_level_cache`

Canonical binding/perturbation projections and precomputed aggregate
tables are **deferred until after parity is reached and profiling
shows a payoff**.

**Rationale.**

1. The bottleneck (§1) is framework/process model, not query SQL
   inefficiency. Schema reshaping does not address the bottleneck.
2. Per-dataset schemas differ enough that a canonical fact table
   would require non-trivial extract-transform logic in data-prep,
   adding risk and time to the critical path.
3. Runtime immutability (single read-only DuckDB file) gives most of
   the operational win — no connection contention, no init memory
   cost, fail-fast startup — without touching schemas.
4. After cutover, the canonical schema becomes an *optimization* we
   can evaluate against measured cache miss patterns, query
   distributions, and bottleneck reports. Doing it speculatively now
   risks optimizing the wrong shape.

**Consequences.**

- The Go SQL files closely mirror today's `queries.py` SQL strings.
  Parity verification (§11.3.1) is mostly mechanical.
- Future work item: once metrics show the most expensive query
  patterns, evaluate adding pre-aggregated tables targeted at those
  specific patterns. This is not a redesign — it is an additive
  optimization within the same artifact-build script.
- Future work item: if dataset count grows substantially, revisit
  the canonical-schema question. The decision applies to the
  current ~6-dataset world, not all possible futures.
