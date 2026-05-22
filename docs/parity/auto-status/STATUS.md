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
| A3  | correlation endpoints                      | PENDING     | depends on A1+A2 |
| A4  | Comparison hackett filter parity fix       | PENDING     | independent |
| A5  | Select Datasets backend endpoints          | PENDING     | depends on A1 |
| A6  | Plotly bundle: register box trace          | PENDING     | independent |
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
