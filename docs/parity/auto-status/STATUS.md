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
| A1  | schema_version=3 — externalize column maps | DONE        | commit 1976f59 |
| A2  | Pearson/Spearman correlation SQL           | PENDING     | depends on A1 |
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
