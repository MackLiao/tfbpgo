# Deferred Polish — review findings not blocking overnight work

Items flagged by review subagents during overnight Phase A work. Defer
unless they cause downstream breakage.

## From A1 multi-review (commits 1976f59, c784d9e)

- **CHECK constraint on `field_manifest.role`** (database-reviewer NICE-TO-HAVE).
  With only two known values today (`''`, `'experimental_condition'`), free-form
  VARCHAR is fine. Add `CHECK (role IN ('', 'experimental_condition'))` to both
  `manifests.py` and `build_fixture.py` if the role vocabulary grows.

- **Struct-field schema-version separator** (go-reviewer NICE-TO-HAVE).
  Grouping new v3 fields under `// --- schema_version=3+ ---` in
  `backend/internal/db/manifest.go:20-37` would aid future audits.

- **Log-warn for binding/perturbation datasets missing topn config** (go-reviewer
  NICE-TO-HAVE). `AssertHandlerMapsCoverManifest` deliberately doesn't fail
  on missing `bindingConfigs`/`pertConfigs` entries (topn-eligibility is
  request-time), but a startup log-warn would surface drift earlier.

- **Parity-snapshot regeneration** (code-reviewer NICE-TO-HAVE). The
  committed `tests/parity/snapshots/` files weren't re-recorded after
  fixture regeneration. `make parity` is still green (verified by
  fix-up implementer), so the snapshots remain valid — but if a future
  manifest change *does* affect API output, re-record with `make parity-snapshot-record`.

## From A3 multi-review (commit 218bf3c)

- **Per-pair vs UNION-ALL** (database-reviewer IMPORTANT). The Go `/corr` handler
  issues N*(N-1)/2 sequential queries; Shiny does one UNION-ALL. With
  MaxOpenConns=2 on t3.small this could matter on cold-cache requests with
  4+ datasets. Benchmark during cutover; consolidate to a single UNION-ALL
  query in Phase C if numbers warrant.
- **Error context wrapping** (go-reviewer NICE-TO-HAVE).
  `buildCorrResponse`/`buildScatterResponse` `return nil, err` lose pair
  context. Wrap with `fmt.Errorf("corr pair %s/%s: %w", dbA, dbB, err)` at
  the DB error site for actionable logs.
- **OpenAPI descriptions** (code-reviewer NICE-TO-HAVE). `CorrPair.dbB`,
  `CorrPair.colB`, all `ScatterPoint.*` fields lack `description:` entries.
- **Cache canonicalization test fidelity** (go-reviewer NICE-TO-HAVE).
  `TestBindingScatter_CacheCanonicalization` re-issues an identical request;
  it tests HIT but not canonicalization. Re-write to permute param order.
## From A6 (commit pending — Plotly bundle)

- **Bundle size at 523 KB gzipped** (was 512 KB target). Adding the `box`
  trace took us 11 KB over. Three options once Phase B is done:
  1. Drop `bar` from the bundle (only used by the existing comparison
     heatmap; the new boxplot from B1 should not need it).
  2. Drop `heatmap` after B1 replaces ComparisonHeatmap with the boxplot.
  3. Increase the documented target to ~530 KB. The 512 KB number was a
     soft heuristic, not a load-time budget. Document and move on.

- **A3 scatter parity golden URLs need snapshots recorded** (fix-up note).
  Four new entries added to `tests/parity/golden_urls.txt` for
  `/binding/scatter` and `/perturbation/scatter` (pearson + spearman).
  Snapshot capture is an operator step (`make parity-snapshot-record`
  against a running backend pointed at a fixture with manifest tables);
  the operator must record + commit `tests/parity/snapshots/<hash>.expected`
  for each new URL during cutover prep. `/binding/corr` and
  `/perturbation/correlations` are intentionally NOT in golden_urls.txt:
  the fixture has only one dataset per data_type and dedupeAndCapCSV
  collapses CSV duplicates, so they cannot produce a 200 against the
  fixture without widening it (Phase 1 Task 21 work).
