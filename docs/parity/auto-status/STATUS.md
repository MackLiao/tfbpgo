# Overnight Auto Status

**Branch:** `auto/overnight-phase-a`
**Started:** 2026-05-21 23:56 PDT
**Source of truth:** `docs/parity/`

This file is shared state between implementer and reviewer subagents.
Read before working, append a section before finishing.

---

## Task ledger

| ID  | Title                                      | Status      | Notes |
|-----|--------------------------------------------|-------------|-------|
| A1  | schema_version=3 — externalize column maps | DONE        | 1976f59 + c784d9e (review fixes); polish notes in [polish.md](polish.md) |
| A2  | Pearson/Spearman correlation SQL           | DONE        | depends on A1 |
| A3  | correlation endpoints                      | DONE        | 218bf3c + multi-review fixes; polish notes in [polish.md](polish.md) |
| A4  | Comparison hackett filter parity fix       | DONE        | independent |
| A5  | Select Datasets backend endpoints          | DONE        | depends on A1; polish notes in [polish.md](polish.md) |
| A6  | Plotly bundle: register box trace          | DONE        | bundle now 523 KB gzip (11 KB over the 512 KB soft target); see [polish.md](polish.md) |
| B1  | Comparison module rebuild                  | DONE        | 79eeea9; depends on A4+A6 |
| B2  | Binding module rebuild                     | DONE        | 2432163; depends on A2+A3+A6 |
| B3  | Perturbation module rebuild                | PENDING     | depends on A2+A3+A6 |
| B4  | Select Datasets module rebuild             | PENDING     | depends on A5 |

---

## Activity log

### 2026-05-21 23:56 PDT — controller init
- Created branch `auto/overnight-phase-a`.
- Initialized status + task ledger.
- About to dispatch implementer for **Task A1**.

### 2026-05-22 00:42 PDT — implementer A1
- Bumped SCHEMA_VERSION 2->3.
- New columns: dataset_manifest.{effect_col, pvalue_col}; field_manifest.role.
- Removed Go maps: bindingMeasurementColumn, pertMeasurementColumn.
- buildResponsiveExpr now consults manifest PValueCol (no more hard-coded switch).
  Made it nil-Whitelist-safe so existing placeholder-count unit tests with bare
  `&Server{}` keep working (they only exercise SQL rendering invariants).
- AssertHandlerMapsCoverManifest now checks DatasetRow.EffectCol != "" instead
  of the deleted Go maps; error messages mention "manifest effect_col".
- Regenerated tests/fixtures/tfbp_test.duckdb (now ships v3 schema with
  role=experimental_condition for callingcards.condition and hackett.time).
- bindingConfigs/pertConfigs intentionally left in Go (carry per-dataset
  business logic — HarbisonDedup, HackettTimeFilter, TargetBlackOK, RankAsc —
  not pure column maps; out of scope per task brief).
- Tests: data_prep pytest (55 passed) ✓, backend go test ./... ✓, parity ✓.
- Commit: 1976f59
- Files: 15 (incl. regenerated fixture binary).
- Status: DONE.

### 2026-05-22 00:20 PDT — implementer A1 multi-review fixes
- SECURITY: validated effect_col/pvalue_col via SafeIdentRE in NewWhitelist;
  wrapped in whitelistedIdent in buildResponsiveExpr (defense in depth).
- Removed nil-Whitelist fallback in buildResponsiveExpr; placeholder-count
  tests now use a real fixture Whitelist; added new test asserting two-term
  CASE for kemmeren and one-term CASE for hackett.
- CLAUDE.md stale follow-up removed; schema_version reference updated.
- Tests: backend go test ./... ✓, data_prep pytest ✓, parity ✓.
- Commit: 923b806
- Status: A1 multi-review fixes DONE.

### 2026-05-22 00:31 PDT — implementer A2
- New SQL templates: 8 files (binding+perturbation × pearson+spearman × corr_pair+regulator_scatter).
- Deleted placeholder files: binding/{corr_pair,regulator_scatter}.sql, perturbation/corr_pair.sql.
- Templates mirror Shiny's _corr_pair_sql_impl + regulator_scatter_sql exactly
  (INNER JOIN on (regulator, target); NULL/Inf/NaN exclusion; HAVING COUNT(*) >= 3
  floor on corr_pair only; spearman uses caller-supplied {{order_a_expr}} /
  {{order_b_expr}} so effect=ABS DESC vs pvalue=ASC is decided in Go).
- Numerical-parity tests against fixture (callingcards × hackett); spot-checked
  Pearson correlation = +1.0 for YBR289W cc_0_a × h_0 group (perfectly correlated
  linspace inputs) and Spearman = -1.0 for same group (cc all-positive ABS-DESC
  ranks 5..1 vs hackett all-negative ABS-DESC ranks 1..5).
- Also verified HAVING floor prunes groups with <3 paired rows, and that the
  pvalue ASC order branch parses + runs end-to-end.
- Tests: backend go test ./... ✓ (added 11 tests in
  backend/internal/queries/correlation_parity_test.go).
- Commit: 2b18fef
- Status: DONE.

### 2026-05-22 01:00 PDT — implementer A3
- Added handlers: BindingCorr, BindingScatter, PerturbationCorrelations,
  PerturbationScatter (routes /binding/corr, /binding/scatter,
  /perturbation/correlations, /perturbation/scatter under /api/v/{v}).
- Reused A2 SQL templates; per-pair execution via sorted(datasets) choose 2;
  regulator strip in scatter (mirrors Shiny workspace.py:536-540) AND the
  strip applied BEFORE the field-whitelist check so that callers can
  legitimately ship regulator_locus_tag in filters without 400ing on
  CheckField (regulator_locus_tag is a column, not a field_manifest entry).
- Server-side Pearson r in scatter responses (clamped to [-1,1], coerced
  to 0 on degenerate inputs to mirror Shiny NaN handling).
- pvalue→effect fallback when dataset.PValueCol == "" (matches Shiny
  get_measurement_column).
- Shared helpers in correlation.go: validateCorrMethod/Col,
  resolveMeasurementCol, isPValueCol/orderExpr, stripRegulatorFilter,
  renderCorrPairSQL/renderScatterSQL, pearsonR, sortedPairs.
- Domain types: CorrResponse, CorrPair, CorrPairPoint, ScatterResponse,
  ScatterPoint.
- OpenAPI doc: 4 new paths + 5 new schemas; frontend types regenerated;
  client.ts gains bindingCorr / bindingScatter / perturbationCorrelations /
  perturbationScatter typed helpers.
- UI consumers deferred to Phase B per task brief.
- Tests: backend go test ./... ✓ (added ~20 handler/unit tests across
  binding_corr_test.go + perturbation_corr_test.go); parity ✓;
  frontend tsc --noEmit ✓.
- Commit: 218bf3c
- Status: DONE.

### 2026-05-22 01:10 PDT — implementer A4
- Hackett-filter parity (docs/parity/comparison.md §7.2): skip filters[pDB]
  when pcfg.HackettTimeFilter, mirroring Shiny queries.py:432. Regression
  test TestComparisonTopN_HackettFilterParity added; constructs a hackett
  time-range filter alongside a callingcards target_locus_tag filter and
  asserts the hackett `"time"` clause is absent from the rendered SQL while
  the binding-side `"target_locus_tag"` clause still appears. Fails pre-fix.
- regulator_display_name added to TopN rows via LEFT JOIN against
  regulator_display_names in topn.sql; TopNRow.RegulatorDisplayName *string
  (nullable so locus tags missing from regulator_display_names produce
  JSON null). OpenAPI schema extended with type: [string, null]; frontend
  types regenerated (TopNRow.regulatorDisplayName: string | null).
- Re-recorded /comparison/topn parity snapshots
  (5f76e2fcca423df8.expected, 9cbf36b2908efdb5.expected) plus the stale
  /api/version snapshot (5694bd8f8cc07635.expected — schemaVersion bumped
  2->3 in A1 but never re-snapshotted; included here to keep `make parity`
  green). Out-of-scope unrecorded A3 scatter snapshots left untouched.
- Tests: backend go test ./... ✓, tests/parity Go harness ✓, snapshot
  parity (run_parity.sh diff) ✓, frontend tsc --noEmit ✓.
- Commit: 3a3e940
- Status: DONE.

### 2026-05-22 — controller A6 (Plotly box trace)
- Added `box` to `frontend/src/plots/plotly-bundle.ts` (single-line patch).
- Bundle measured at 523 KB gzipped (was 512 KB; the audit anticipated
  this trade-off — note logged in polish.md with options to recover the
  budget after B1 replaces ComparisonHeatmap).
- Tests: backend `go test ./...` ✓ (untouched); `vite build` ✓.
- Status: DONE — pending commit alongside A5.

### 2026-05-22 01:30 PDT — implementer A5
- Four endpoints + handlers + tests + OpenAPI + frontend client typed helpers.
  - GET /api/v/{v}/datasets/{db}/fields       — column-metadata
  - GET /api/v/{v}/datasets/{db}/regulators   — per-dataset regulator labels
  - GET /api/v/{v}/selection/matrix           — diagonal + pairwise overlap counts
  - GET /api/v/{v}/selection/breakdown        — multi-sample regulator breakdown
- Mirrors Shiny select_datasets/queries.py for breakdown / matrix shape
  (matrix_diagonal_query, matrix_cross_dataset_query, regulator_breakdown_query,
  regulator_display_labels_query).
- Field metadata combines DB introspection (information_schema.columns,
  data_type column — not the PRAGMA-style column_type) + filter_level_cache
  + FIELD_TYPE_OVERRIDES (one entry: hackett.time → categorical despite
  the underlying INTEGER column).
- Numeric min/max via aggregate query, cached per (db, field) for Server
  lifetime. introspection cache shared with the same lazy sync.Once init.
- Matrix SQL uses dataset_manifest.sample_id_field (gm_id for callingcards,
  sample_id for the rest) — the Shiny reference hard-codes `sample_id`
  because VirtualDB renames the column at load, but our artifact preserves
  raw names. Re-verified via SafeIdentRE through whitelistedIdent.
- Breakdown drops manifest fields absent from `{db}_meta` (e.g.
  callingcards_enrichment lives only on the data table); validates each
  remaining field through s.Whitelist.CheckField + whitelistedIdent before
  interpolation.
- Tests: backend `go test ./...` ✓ (15 new tests in select_datasets_test.go);
  Go parity harness `tests/parity` ✓; snapshot parity `run_parity.sh` ✓
  (15/15 URLs pass; 4 untouched A3-scatter recordings deferred per polish.md).
  Frontend `pnpm types:gen` + `pnpm exec tsc --noEmit` ✓.
- Commit: 292aaac
- Status: DONE.

### 2026-05-22 00:54 PDT — implementer A3 multi-review fixes
- CRITICAL: scatter SQL templates now filter NULL/Inf/NaN (matches
  corr_pair templates). Closes a json.Marshal 500 path on Inf measurements.
- pearsonR clamp + defer cancel() + symmetric stripRegulatorFilter in
  /corr handlers + golden URLs added + sortStringsAsc removed + OpenAPI
  pair ordering documented.
- Remaining items (perf, error context, doc-descriptions) deferred to polish.md.
- Tests: backend go test ./... ✓, parity (Go harness) ✓, frontend tsc ✓.
- Commit: 9c288cf
- Status: A3 multi-review fixes DONE.

### 2026-05-22 01:36 PDT — implementer A5 multi-review fixes
- security: computeNumericRange uses whitelistedIdent (pattern consistent
  with binding.go).
- go: WarmIntrospectionCache at server bootstrap; cold misses no longer
  double-query.
- db: added TestSelectionMatrix_FilteredCrossPair as regression for
  filtered cross-pair arg-count concerns flagged by db-reviewer.
- Remaining items deferred to polish.md.
- Tests: backend go test ./... -race ✓, parity ✓ (operator step; harness
  green at A5 commit 292aaac, no parity-affecting changes in this commit).
- Commit: 6f167e6
- Status: A5 multi-review fixes DONE.

### 2026-05-22 01:50 PDT — implementer B1
- Rebuilt Comparison route: heatmap replaced by faceted boxplot per
  Shiny workspace.py:221-323.
- New: frontend/src/plots/ComparisonBoxplot.tsx (per-(facet, x_val) Box
  traces, jittered points, shared y-axis via domain partitioning,
  one-legend-across-subplots, chronological facet/x ordering with
  graceful fallback for non-canonical db_names).
- New: frontend/src/components/ComparisonSidebar.tsx — top_n numeric
  (1..500 step 5), effect slider (0..5 step 0.1), pvalue slider
  (0.001..1 step 0.001), facet_by radio. All four push to URL.
- New: frontend/src/lib/comparison-palette.ts — verbatim mirror of
  workspace.py:30-60 + queries.py:339-353 (BINDING/PERTURBATION
  LABEL_MAP + PALETTE + ORDER constants).
- Rewrote: frontend/src/routes/Comparison.tsx — 260px sidebar grid,
  reads/writes top_n/effect/pvalue/facet_by URL keys, drops Tabs (no
  DTO tab) and FilterChips (dead-write removed). api.dto client entry
  preserved with explanatory comment; backend endpoint untouched.
- Deleted: ComparisonHeatmap.tsx, DTOPlot.tsx, FilterChips.tsx
  (sole consumer was Comparison; verified via grep before deletion).
- Cell-key collision bug (heatmap regulator+pair collapse) is gone by
  construction — boxplot plots every row as a point, no keying.
- Tests: pnpm exec vitest run ✓ (14 tests, 5 files); pnpm exec tsc
  --noEmit ✓; pnpm exec vite build ✓.
- Bundle delta: plotly chunk unchanged at 523.92 KB gzip (box trace
  was already registered in A6); index chunk 73.02 KB gzip (slightly
  smaller — three deleted source files net out the additions).
- Files touched: 10 (3 new, 3 deleted, 4 modified).
- Commit: 79eeea9
- Status: DONE.

### 2026-05-22 01:55 PDT — implementer B2
- Rebuilt Binding route: replaced single scatter with Shiny shape per
  workspace.py:218-610 (boxplot of pairwise correlations + per-pair
  scatter grid).
- New: frontend/src/plots/BindingCorrBoxplot.tsx — one go.Box per active
  dataset pair (boxpoints="all", jitter=0.4, pointpos=0); customdata =
  regulator locus tag so Plotly click writes ?regulator= back to URL
  (replaces Shiny's post_script bridge). Selected-regulator overlay
  trace draws large black dot per pair. Empty state = centered "Select
  at least two binding datasets..." annotation.
- New: frontend/src/plots/BindingScatterPair.tsx — single 400x400 scatter
  with r=N.NNN annotation top-right (paper 0.98/0.98), two-line title,
  per-axis "{display}: {col}" labels; collapses to empty <span/> when
  zero points (Shiny ui.span() parity).
- New: frontend/src/plots/BindingScatterRow.tsx — useQueries fan-out for
  one /binding/scatter per sorted(datasets) choose 2 pair; flex-wrap
  layout; skeleton + error placeholders per pair.
- New: frontend/src/components/BindingSidebar.tsx — Effect/P-value radio,
  Pearson/Spearman radio, RegulatorPicker; "Binding" heading matches
  Shiny sidebar_heading.
- Rewrote: frontend/src/routes/Binding.tsx — 300px sidebar grid;
  ?col=, ?corr=, ?regulator=, ?binding=, ?filters= all URL-backed;
  "Binding Correlation" h1; missing-datasets notice between boxplot
  and scatter row (workspace.py:451-491 set algebra: dataset is
  missing only when EVERY pair it appears in lacks the regulator);
  fetches /datasets once to build displayName lookup.
- Deleted: frontend/src/plots/BindingScatter.tsx.
- Query keys: added qk.bindingCorr + qk.bindingScatter to
  lib/query-keys.ts, both sort datasets/pair into the key so cache hits
  survive param-order permutation.
- Tests: pnpm exec tsc --noEmit ✓; pnpm exec vitest run ✓ (17 tests,
  5 files — added 3 new Binding cases: empty state, corr fetch URL,
  Spearman radio writes ?corr=, boxplot trace+overlay rendering with
  mocked corr response); pnpm exec vite build ✓.
- Bundle: plotly chunk unchanged at 523.35 KB gzip (box trace already
  registered in A6); index chunk grew slightly to 75.97 KB gzip (was
  73.02 KB after B1 — net +2.95 KB for the 4 new components). Well
  under the 530 KB ceiling called out in the task brief.
- Files touched: 9 (4 new components/plots, 1 rewrite, 1 delete,
  3 modified: query-keys, test, STATUS).
- Commit: 2432163
- Status: DONE.
