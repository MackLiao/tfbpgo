# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

This is the **Go + React rewrite** of [tfbpshiny](https://github.com/BrentLab/tfbpshiny), a dashboard for transcription factor binding and perturbation data from the Brent Lab yeast collection. The original Python Shiny app fails under concurrent load on its `t3.small` deployment (single-process asyncio event loop, single shared DuckDB connection, per-session reactive state). This rewrite replaces the framework/process model — not the SQL or the science.

**Status as of 2026-05-12:** Phases 0, 1, and 2 merged to main. Phase 0 (`data_prep/`, Python, `schema_version=2`) ships the runtime artifact + test fixture (49 unit tests). Phase 1 (`backend/`, Go) ships the full API surface (42 unit tests + parity scaffolding). Phase 2 ships the React SPA (`frontend/`, Vite + React 18 + TanStack Query + Zustand + Plotly custom bundle), the OpenAPI doc generated from handler annotations, the new `GET /api/v/{v}/regulators/resolve` endpoint for compact filter expressions, the embedded `backend/static/dist/` bundle served by the Go binary, `Cache-Control: public, max-age=31536000, immutable` headers on `/api/v/*` responses, and the parity snapshot scaffold under `tests/parity/`. The `/_ref/*` HTML parity view has been deleted now that the SPA reaches parity. All API endpoints remain in place: `/healthz`, `/readyz`, `/metrics`, `/api/version`, `/api/v/{v}/{datasets,regulators,regulators/resolve,binding,perturbation,comparison/topn,comparison/dto}`. DuckDB pool opens read-only with §6.3 settings; cache is ristretto+singleflight+`Wait()` per §8.1 with `OnEvict` wired; identifier whitelisting backed by `dataset_manifest`/`field_manifest` with defense-in-depth regex re-verification at startup; DoS caps on `?filters=`, `?top_n=`, dataset CSV lists, `?search=`. **API contract is extended (regulators/resolve added) and frozen — no further breaking changes without a version bump.** **Next: Phase 3 (Docker + Traefik + S3 artifact upload + k6 load tests + cutover).** The spec at `docs/superpowers/specs/2026-05-12-go-react-rewrite-design.md` remains the source of truth. Per-phase plans live under `docs/superpowers/plans/`.

## Phase 2 documented overages / follow-ups

These are intentionally deferred rather than blocking — revisit during Phase 3.

- **Plotly bundle ~512.7 KB gzip** (`assets/plotly-*.js` measured at 512,649 bytes gzip; raw 1,488,717 bytes) — ~649 bytes over the spec §7.5 500 KB (512,000 byte) target. Revisit at Phase 3 cutover load test, or by dropping/replacing a Plotly trace type to shave the overage.
- **5 of 11 parity golden URLs return 500** due to fixture column gaps: `callingcards` lacks `poisson_pval` / `sample_id`; `hackett` lacks `log2_shrunken_timecourses`; `dto_expanded` lacks `perturbation_id_source`. Address by widening `tests/fixtures/tfbp_test.duckdb` via `data_prep/build_fixture.py` before Phase 3 cutover.
- **`db_pool_wait_duration_seconds`** is registered but not observed (carry-over from Phase 1).
- **`make backend-build` always runs frontend-build first** (~3s tax even when only Go changed). A separate `backend-build-only` target could be added.
- **Hard-coded measurement column maps** in `backend/internal/api/{binding,perturbation,comparison_topn}.go` still need to move to `dataset_manifest` (requires `schema_version` bump to 3).

## The `reference/` symlink

`reference/` is a symlink to `../tfbpshiny` — the running Python Shiny codebase being rewritten. It is gitignored. Use it as the **parity reference**:

- SQL behavior to match: `reference/tfbpshiny/modules/*/queries.py`
- Data initialization being externalized: `reference/tfbpshiny/utils/vdb_init.py`
- Modules to port (Home, Select Datasets, Binding, Perturbation, Comparison): `reference/tfbpshiny/modules/`
- Dataset config (will move into `data_prep/`): `reference/tfbpshiny/brentlab_yeast_collection.yaml`

When in doubt about what a feature should do, run the reference app or read its source — do not guess.

## Layout (`backend/` and `frontend/` not yet created)

Three peer top-level directories, **not** a Go monorepo:

```
backend/    # Go service (chi, duckdb-go/v2, sqlx, ristretto, singleflight)
frontend/   # React SPA (Vite, React 18, TanStack Query, Zustand, Plotly.js custom bundle)
data_prep/  # Python — produces tfbp.duckdb artifact from HF + YAML, plus test fixture
tests/      # parity/, loadtest/k6/, fixtures/tfbp_test.duckdb
```

`data_prep/` is Python and lives at the repo root, not under `backend/`, because it shares nothing with the Go service except the schema contract in `tfbp.duckdb`.

## Architecture in one paragraph

Data preparation moves out of the runtime entirely. A scheduled Python job (`data_prep/build_duckdb.py`) downloads from HuggingFace and writes a single immutable `tfbp.duckdb` file containing both the VirtualDB-shape compatibility tables (`{db_name}`, `{db_name}_meta`, `dto_expanded`, `hackett_analysis_set`, `regulator_display_names`) and new manifest tables (`artifact_manifest`, `dataset_manifest`, `field_manifest`, `filter_level_cache`). The Go service opens that file read-only, serves JSON via `chi`, coalesces concurrent identical cache misses with `singleflight` (so N concurrent identical cold misses produce 1 DB query), caches pre-serialized JSON bytes in `ristretto` with `artifact_manifest.version` baked into every key, and embeds the React SPA via `embed.FS`. URL is the canonical state model on the frontend (every view deep-linkable).

## Phase order — sequential, backend first

The highest-risk part is **query parity** between Go + duckdb-go/v2 and the current Python DuckDB. Do not start the React frontend in parallel with backend query work.

1. **Phase 0** — `data_prep/build_duckdb.py` produces a `tfbp.duckdb` matching what `initialize_data()` leaves in memory today; `data_prep/build_fixture.py` emits `tests/fixtures/tfbp_test.duckdb`. Phase 1 depends on the fixture existing.
2. **Phase 1** — Go service with all endpoints. **API contract is frozen at the end of this phase** (extended once in Phase 2 to add `/regulators/resolve`).
3. **Phase 2** — React SPA built against the frozen OpenAPI spec.
4. **Phase 3** — Docker Compose + Traefik cutover; old Shiny moves to `legacy.tfbindingandperturbation.com` for 30 days.

## Hard constraints (from §6.3 of the spec — do not relax without re-benchmarking)

DuckDB is opened **read-only** with `threads=1` and `memory_limit=800MB`; `MaxOpenConns=2` on a `t3.small`. Spill is mandatory (`temp_directory`, `max_temp_directory_size=2GB`). Docker `mem_limit=1.6g` with swap disabled. Cache budget 128 MB initial. These are conservative starting values — actual tuning comes from load tests in `tests/loadtest/k6/`, not from formulas.

## SQL injection: identifier whitelisting is mandatory

`database/sql` cannot parameterize identifiers (table/column names). The current Python app builds dynamic WHERE clauses from user-driven dataset and field selections. In the Go port, **every identifier-shaped input must be whitelisted against `dataset_manifest` / `field_manifest` loaded at startup** before being interpolated into SQL. Anything not in the manifest → 400. The security test suite must enumerate the manifest and assert every legal value is accepted, every illegal value is rejected.

## Ristretto subtleties (load-bearing — see §8.1)

Ristretto's `Set()` is asynchronous and may reject. Handlers must:
1. Check the bool return of `Set()` and increment `cache_admission_rejected_total` on `false`.
2. Call `cache.Wait()` after `Set()` so the next request sees the write (otherwise singleflight re-fires on every popular cold key until the buffer drains).
3. Track oversize responses (> `cache_budget / 20`) with a structured warn log and `cache_oversize_responses_total` counter.

Skipping (1) or (2) silently breaks coalescing under realistic load.

## Cache key shape

`{artifactVersion}|{method}|{path}|{canonical-sorted-query}`. Cache values are pre-serialized JSON bytes. There is no TTL — version-scoped keys mean a new artifact = new keys = old entries age out.

## Startup contract (fail-fast — §9.5)

The Go binary must exit non-zero before binding the HTTP listener if: artifact file missing or SHA mismatch; DuckDB cannot open read-only; `artifact_manifest` missing or empty; `schema_version` outside the binary's compatible range; any §5.5 table missing; canary `SELECT` fails. **Do not gate on patch-level DuckDB version mismatch** — log it instead. Storage compatibility and `schema_version` are the actual gates.

## Local dev (when code exists)

Two terminals, no Docker:

```bash
# Terminal 1
cd backend && go run ./cmd/tfbp-server --duckdb=./tfbp.duckdb --port=8080

# Terminal 2
cd frontend && npm run dev   # Vite proxies /api → :8080
```

Three ways to get a `.duckdb` locally:
- `make data-pull` — pulls latest `tfbp.duckdb` from S3. **Not implemented in Phase 0** (see follow-up plan after Phase 1).
- `make data-build` — runs the labretriever pipeline (5–10 min first time, needs `HF_TOKEN` and `poetry install -E full` in `data_prep/`). See `data_prep/README.md`.
- `make data-fixture` — rebuilds `tests/fixtures/tfbp_test.duckdb` from `data_prep/build_fixture.py` (instant, no HF; needs `poetry install` in `data_prep/` once). Tests run against this.

Tests must never hit S3 or HuggingFace — always run against the committed fixture.

## What is explicitly out of scope

Authentication, per-user state, real-time HF refresh, multi-instance Redis caching, mobile-first layouts, any new scientific analysis. Parity first, then optimization. See spec §3 and §13.

## When working on this repo

- Read the spec section before changing anything related to it. Section numbers above point at the relevant area.
- Do not introduce a canonical/normalized fact schema — Appendix D ADR explicitly defers it. Preserve VirtualDB shape.
- Do not pull in an ORM (GORM/ent/bun) or sqlc. Workload is read-only analytical and sqlc does not support DuckDB. Stack is `sqlx` + `Squirrel` for dynamic clauses + hand-written SQL in `.sql` files loaded via `embed.FS`.
- Do not re-introduce per-session state on the backend. URL + Zustand on the frontend; stateless on the backend.
- Numerical parity with the Python app is non-negotiable. Add to `tests/parity/` when porting any query.
