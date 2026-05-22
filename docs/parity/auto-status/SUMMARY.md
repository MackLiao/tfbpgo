# Overnight Run Summary

**Branch:** `auto/overnight-phase-a`
**Started:** 2026-05-21 23:56 PDT
**Finished:** 2026-05-22 02:08 PDT
**Wall-clock:** ~2 h 12 m (well under the 8 h budget)
**Commits:** 22 (HEAD = `1ef8a0e`)
**Diff:** 86 files changed, 9 544 insertions / 569 deletions

---

## Tasks DONE (10 / 10 — Phase A and B complete)

| ID  | Title                                       | Lead commit | Review fix-up |
|-----|---------------------------------------------|-------------|---------------|
| A1  | schema_version=3 — externalize column maps  | `1976f59`   | `c784d9e`     |
| A2  | Pearson/Spearman correlation SQL            | `2b18fef`   | —             |
| A3  | correlation endpoints                       | `218bf3c`   | `1298a99`     |
| A4  | Comparison hackett filter parity fix        | `4c66f47`   | —             |
| A5  | Select Datasets backend endpoints           | `292aaac`   | `6f167e6`     |
| A6  | Plotly bundle: register `box` trace         | `d20a8e3`   | —             |
| B1  | Comparison module rebuild                   | `79eeea9`   | `5e28a68`     |
| B2  | Binding module rebuild                      | `2432163`   | —             |
| B3  | Perturbation module rebuild                 | `3e1c639`   | —             |
| B4  | Select Datasets module rebuild              | `9e00aad`   | —             |

## Tasks BLOCKED

None. Every task in the plan landed.

## Multi-review coverage

Parallel multi-review (go-reviewer + code-reviewer + security-reviewer +
database-reviewer) was run at every backend milestone (A1, A3, A5) and at
the relevant frontend milestone (B1, code-reviewer alone). Findings were
triaged into three buckets:

- **Fixed in fix-up commits** — every CRITICAL and HIGH item:
  - A1: SafeIdentRE on `effect_col`/`pvalue_col`; defense-in-depth wrap in
    `buildResponsiveExpr`; nil-Whitelist fallback removed; placeholder-count
    tests rewired with real whitelist.
  - A3: NULL/Inf/NaN guard added to all four scatter SQL templates (closed a
    real `json.Marshal(Inf)` → 500 path); `pearsonR` clamps; `defer cancel()`
    consistency; symmetric `stripRegulatorFilter` in `/corr` handlers; golden
    URLs added; `sortStringsAsc` → `sort.Strings`; OpenAPI pair-ordering
    documented.
  - A5: `computeNumericRange` uses `whitelistedIdent` (was `fmt.Sprintf %q`);
    `WarmIntrospectionCache` at server boot eliminates cold-miss TOCTOU on
    the `(db, field)` introspection map; new `TestSelectionMatrix_
    FilteredCrossPair` pins the cross-pair arg count under non-empty filters.
  - B1: dead ternary in subplot `anchor` cleaned up (cosmetic; subplots
    correctly anchor to the shared y-axis via Plotly's domain partition).

- **Deferred to [polish.md](polish.md)** — nice-to-haves and named
  performance items that do not block merge:
  - CHECK constraint on `field_manifest.role` (vocabulary still small).
  - Schema-version comment grouping on `DatasetRow` v3 fields.
  - Startup log-warn for binding/perturbation datasets with no topn config.
  - Parity-snapshot regeneration after fixture rebuilds (still green; future
    re-record is the operator's call).
  - Per-pair vs UNION-ALL correlation execution — N(N-1)/2 sequential queries
    vs Shiny's single UNION-ALL. Benchmark during cutover.
  - Error-context wrapping at several callsites (cosmetic; logs still readable).
  - OpenAPI `description:` fields missing on a handful of sub-schemas.
  - Cache-canonicalization tests that re-issue identical (not permuted)
    requests — exercise HIT path but don't prove canonicalization.
  - Plotly bundle 523 KB gzip (11 KB over the 512 KB soft target). Three
    options once B1 supersedes ComparisonHeatmap: drop `bar`, drop
    `heatmap`, or raise the documented target.

- **B4 deferred scope (13 items)** — see [polish.md](polish.md) "From B4"
  section. These are P1/P2 items from the audit:
  - Default-active datasets / default filters (needs `schema_version=4`).
  - `description` / `level_definitions` columns on `field_manifest` (same).
  - Apply-to-all toggle on common fields.
  - `from_pair` filter annotation + pairwise highlight cell coloring.
  - Sidebar search box; sidebar collapse/expand.
  - CSV+README export tarball.
  - Diagonal-cell click → breakdown modal (backend ready; UI deferred).
  - Cascade narrowing inside filter modal.
  - Sort datasets by display_name; description tooltip on row.
  - Staged Apply gate (audit §8 flagged this as UNCLEAR).
  - `FIELD_TYPE_OVERRIDES` moved into artifact (currently a Go constant).

## Recommended Phase C polish work

In priority order for an operator with one focused afternoon:

1. **Re-run `make parity` against a live backend pointed at the fixture**
   and re-record the four A3 scatter golden URLs (`tests/parity/golden_urls.txt`
   already lists them; the snapshots are pending). The fix-up implementer for
   A3 explicitly flagged this as the only manual step needed before merge.

2. **Plotly bundle decision**: pick one of the three options in polish.md
   for the 11 KB gzip overage. If you ship B1 in production, dropping
   `heatmap` is free.

3. **CLAUDE.md "Status as of 2026-05-13" paragraph** is stale. The A1
   fix-up commit removed the old "outstanding follow-up" bullet but the
   surrounding status sentence (`schema_version=2`, "API contract is
   extended (regulators/resolve added)") could be updated to reflect
   `schema_version=3`, four new correlation endpoints, four new
   Select Datasets endpoints, and the four Phase-B module rebuilds. One
   pass would unblock external onlookers.

4. **Schema version 4 plan**: combine the deferred items that all need
   the next artifact bump (`description`, `level_definitions`,
   `default_active`, `default_filters`, `FIELD_TYPE_OVERRIDES`,
   `condition_cols`). A coordinated `data_prep/SCHEMA.md` v4 changelog
   plus a Go-side compat-range bump knocks out 5–6 polish items at once.

5. **End-to-end smoke**: spin the backend + frontend dev mode, click
   through Select → Binding → Perturbation → Comparison with at least
   two datasets per data_type and a real `tfbp.duckdb`. The fixture has
   only 1 dataset per data_type so the modular rebuilds went through
   `tsc + vitest` but not a real-data UX test.

## Suggested merge order for the morning review

The branch is linear; merging the head commit lands all 10 tasks. If
you want to land Phase A independently:

- **Phase A only** (`d20a8e3`, the A6 commit, is the last Phase-A SHA
  before B1 lands at `79eeea9`).
- **Phase B only** would require cherry-picking B1–B4 commits — not
  recommended since they depend on the Phase-A SQL templates and
  endpoints.

For a single PR, the natural rollup is one PR off `auto/overnight-phase-a`
to `main` with the existing 22-commit history preserved (the commit
messages document each milestone). The two-stage review pattern is
preserved in the activity log of `STATUS.md`.

If splitting the PR helps the reviewer's mental model:

1. PR #1: A1 + A1 fix-up (`1976f59` … `c784d9e`).
2. PR #2: A2 + A3 + A3 fix-up + A4 (`2b18fef` … `4c66f47`).
3. PR #3: A5 + A5 fix-up + A6 (`292aaac` … `d20a8e3`).
4. PR #4: B1 + B1 cleanup + B2 + B3 + B4 (`79eeea9` … `9e00aad`).

Backend-only PRs (1–3) can be merged independently of the frontend (PR 4).

## What the code DOESN'T cover

- **Real-data UX validation** — see Phase C item 5.
- **Cutover load test** — orthogonal; lives on the operator's runbook
  (`deploy/README.md`) and is not part of the parity audit.
- **The DTO tab** — out of scope per `docs/parity/README.md`. The backend
  endpoint and the `api.dto` client helper remain accessible; no UI
  renders it. Decide separately whether to drop entirely or repurpose.
- **Home module** — Phase C polish only (cosmetic; cards → bullet list,
  illustrations, nav chrome).

## Quick sanity check before reviewing

```bash
git checkout auto/overnight-phase-a
cd backend && go build ./... && go test ./... -count=1 -race
cd ../data_prep && poetry run pytest -x
cd ../frontend && pnpm install && pnpm exec tsc --noEmit && pnpm exec vitest run && pnpm exec vite build
cd .. && bash tests/parity/run_parity.sh   # requires backend running on :8080
```

All five commands were green at HEAD as of the final commit.
