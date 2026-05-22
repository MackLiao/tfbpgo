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
| A5  | Select Datasets backend endpoints          | PENDING     | depends on A1 |
| A6  | Plotly bundle: register box trace          | DONE        | bundle now 523 KB gzip (11 KB over the 512 KB soft target); see [polish.md](polish.md) |
| B1  | Comparison module rebuild                  | PENDING     | depends on A4+A6 |
| B2  | Binding module rebuild                     | PENDING     | depends on A2+A3+A6 |
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
