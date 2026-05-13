# Handoff — resume Phases 2 + 3

**Date:** 2026-05-12
**State of `main`:** Phases 0 + 1 merged. 49 Python unit tests + 42 Go unit tests passing. API contract frozen.

This document is the resume point for a fresh session that picks up Phase 2 (React) and Phase 3 (deploy).

## What's done

- **Phase 0 (`data_prep/`)** — Python build-time pipeline producing `tfbp.duckdb` with manifest tables (`schema_version=2`). See `data_prep/SCHEMA.md` for the contract. Plan at `docs/superpowers/plans/2026-05-12-phase-0-data-prep.md`.
- **Phase 1 (`backend/`)** — Go HTTP service (chi, duckdb-go/v2, sqlx, ristretto, singleflight). All endpoints implemented:
  - `GET /healthz`, `GET /readyz`, `GET /metrics`
  - `GET /api/version`
  - `GET /api/v/{v}/datasets`
  - `GET /api/v/{v}/regulators?search=&limit=`
  - `GET /api/v/{v}/binding?regulator=&datasets=&filters=`
  - `GET /api/v/{v}/perturbation?regulator=&datasets=&filters=`
  - `GET /api/v/{v}/comparison/topn?binding=&perturbation=&top_n=&effect=&pvalue=&filters=`
  - `GET /api/v/{v}/comparison/dto`
  - `GET /_ref/*` (gated by `ENABLE_REFERENCE_VIEWS=true`)
  - Plan at `docs/superpowers/plans/2026-05-12-phase-1-go-backend.md`.

## What remains

### Phase 2 — React SPA (largest remaining phase)

Per spec §7. Build a Vite + React 18 SPA that consumes the Phase 1 frozen API.

**Required reading before writing the Phase 2 plan:**
- Spec sections §7 (Frontend), §8.2 (Browser cache), §11.3.4 (Functional/UX gates)
- `data_prep/SCHEMA.md` — what the artifact actually contains
- `backend/internal/domain/*.go` — the JSON shapes the frontend consumes
- `backend/internal/api/*.go` — endpoint behaviors, error shapes, query params
- The reference Python Shiny modules (`reference/tfbpshiny/modules/*/ui.py` and `server/*.py`) — visual + interaction parity targets

**Scope:**
- Vite + React 18 + TypeScript
- React Router v6 (URL is canonical state per spec §7.2)
- TanStack Query (handles cache, retries, suspense)
- Zustand (client-side ergonomic mirror of URL state)
- Tailwind CSS + shadcn/ui (Radix primitives)
- Plotly.js custom bundle (~500 KB gzip target per spec §7.5) — `core` + only the traces actually used (scatter, scattergl, heatmap, bar, histogram2d), lazy-loaded via `React.lazy`
- Routes: `/` (Home), `/select` (Select Datasets), `/binding`, `/perturbation`, `/comparison`
- Compact filter encoding (`common=`, `intersect=`) per spec §7.2 — currently the Phase 1 backend does NOT implement these resolvers (architect review flagged this as a Phase 1 follow-up); plan must decide whether to implement them in Phase 2 frontend (calling backend resolver) or in Phase 1.5 backend first
- API client typed against the frozen contract — generate types from a hand-written `openapi.yaml` if it doesn't exist yet (Phase 1 architect review noted no OpenAPI was generated)
- Stale-while-revalidate behavior on route revisits per spec §7.4

**Phase 2 plan blockers / decisions to make:**
1. **OpenAPI artifact** — does Phase 2 require one? If yes, generate it at the start of Phase 2 (or as Phase 1.5).
2. **Compact filter expressions** (spec §7.2 `common=`, `intersect=`) — backend resolver doesn't exist yet. Decide: implement frontend-side enumeration with hard URL caps, or add backend resolver first.
3. **Bundle output dir** — `backend/static/embed.go` currently embeds `*.html`. Phase 2 will produce `dist/` with hashed assets. The embed directive needs to switch to `//go:embed all:dist` and Phase 2 builds output into `backend/static/dist/`.

### Phase 3 — Deployment

Per spec §9 + §11.3 (acceptance criteria).

- Multi-stage Dockerfile (CGO required for duckdb-go; produce a static-ish binary)
- `docker-compose.yml` updates for the `tfbp` service (replaces the existing Shiny `shinyapp`)
- Traefik labels for the new service + 410 routing if `v` is stale
- S3 artifact upload automation (Phase 0's `data-pull` Makefile target — currently a no-op)
- Acceptance load test scripts (`tests/loadtest/k6/profile.js` and `cold_burst.js` exist as skeletons; flesh them out per spec §11.3.2)
- Gate cutover: warm/cold load test results, parity tests passing, observability verified
- Move old Shiny to `legacy.tfbindingandperturbation.com` for the 30-day grace period

## How to resume

In a fresh session:

```
/goal Continue the codebase rewrite per docs/superpowers/HANDOFF-PHASE-2.md.
First write the Phase 2 plan via superpowers:writing-plans, then execute via
subagent-driven-development, then multi-review + fixes + merge. Then Phase 3
the same way. Ask if unclear.
```

The goal hook from the previous session was set on the broader 4-phase goal. If it's still active you may need to clear it first via `/goal clear` and re-set with the Phase 2/3-specific text above.

## Quick verification before starting Phase 2

```bash
cd /Volumes/Workspace/Projects/BrentLab/dbproject/tfbpshiny-go
git log --oneline -5                    # should show Phase 1 merge at top
cd data_prep && poetry run pytest -q    # 49 passed
cd ../backend && go test ./...          # all packages pass
```

## Open follow-up items (from Phase 1 multi-review, low priority)

These were intentionally deferred — fix during Phase 2/3 if convenient or queue for a Phase 1.5 cleanup PR:

- Hard-coded measurement column maps in `backend/internal/api/{binding,perturbation,comparison_topn}.go` should move to `dataset_manifest` (would require `SCHEMA_VERSION=3` bump in `data_prep/`).
- `db_pool_wait_duration_seconds` registered but not observed (sqlx doesn't expose pool-wait time directly).
- Reference HTML view at `/_ref/*` is justifiable for the parity-recording window; plan to delete when Phase 2 reaches parity.
- `cache.GetOrLoad` accepts but ignores its `context.Context`. Documented as a deliberate trade-off (singleflight loaders aren't cancelable).
- Inconsistent JSON encoding: `Encode` adds trailing `\n`, `Marshal+Write` does not. Phase 2 parity tests will care — pick one consistently.
