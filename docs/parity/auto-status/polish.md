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
## From A5 (commit pending — Select Datasets backend)

- **Default-active datasets / default filters** (audit §7 row 7). Shiny's
  `vdb_init.py:40-68` has hard-coded defaults. A follow-up schema bump
  (schema_version=4) should add `dataset_manifest.default_active BOOLEAN`
  and `dataset_manifest.default_filters VARCHAR` (JSON-serialized). Out of
  scope for the overnight Phase A; defer.
- **`description` and `level_definitions` columns** on field_manifest
  (audit §7 row 1). Need labretriever's `ColumnMeta` exposed in the
  `build_duckdb` path; same schema_version=4 bump as above. Tooltip
  rendering on the filter modal will need these.
- **Export endpoint** (audit §7 row 8). Deferred — large surface, needs
  streaming + tar.gz machinery (and another DB checkout from
  `MaxOpenConns=2`, which is a t3.small starvation risk).
- **FIELD_TYPE_OVERRIDES is currently a Go constant** with one entry
  (`hackett.time → categorical`). The audit §7 row 11 flags that this
  override map should live in the artifact (e.g. a new
  `field_manifest.ui_kind_override` column) so the Go binary doesn't need
  to be rebuilt to add a new override. Same schema_version=4 bump.
- **Matrix SQL is N*(N-1)/2 + 1 separate queries** (one UNION ALL for the
  diagonal, one UNION ALL for the cross), all on a single DB checkout.
  Acceptable for the typical 2-7 active datasets; benchmark against the
  Shiny single-UNION baseline during cutover and consolidate if hot.

## From A6 (commit pending — Plotly bundle)

- **Bundle size at 523 KB gzipped** (was 512 KB target). Adding the `box`
  trace took us 11 KB over. Three options once Phase B is done:
  1. Drop `bar` from the bundle (only used by the existing comparison
     heatmap; the new boxplot from B1 should not need it).
  2. Drop `heatmap` after B1 replaces ComparisonHeatmap with the boxplot.
  3. Increase the documented target to ~530 KB. The 512 KB number was a
     soft heuristic, not a load-time budget. Document and move on.

  **RESOLVED — partial (Task C8, commit on `auto/overnight-phase-a`).**
  Option 1 applied: `bar` dropped from `plotly-bundle.ts` post-B1, since
  the boxplot rebuild removed the sole `bar` consumer (ComparisonHeatmap
  no longer renders `type: "bar"` anywhere in `frontend/src`). New plotly
  chunk: 1,494.18 kB raw → **514.25 kB gzipped** (down from 523 KB; saved
  ~9 KB). Still ~2 KB over the 512 KB soft target. Remaining headroom
  comes from option 2 (drop `heatmap` — but `SelectionMatrix` still uses
  it for the dataset-overlap matrix, so this is a Phase C5+ decision)
  or option 3 (formally raise the target to ~520 KB). The 512 KB number
  was always a soft heuristic; treating C8 as a sufficient recovery and
  closing the entry. Re-open if cutover load testing flags a regression.

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

## From A5 multi-review (commit 292aaac)

- **Error context wrapping** (go-reviewer IMPORTANT). Several `return nil, err`
  sites in `select_datasets.go` (handlers around `buildDatasetRegulatorsResponse`,
  `queryMatrixDiagonal`/`Cross`, `buildBreakdownResponse`, `listColumns`)
  bubble raw errors without dataset/query context. Wrap with `fmt.Errorf`
  for actionable logs.

- **`initIntrospect` design** (go-reviewer NICE-TO-HAVE). Move the cache
  initialization into the `Server` constructor so future methods don't
  forget to call `initIntrospect()` before use.

- **Matrix filter test coverage** (go-reviewer NICE-TO-HAVE).
  `TestSelectionMatrix_WithCallingcardsFilter` could also assert the
  cross-cell NCommon value to pin the filter-arm INTERSECT semantics.

- **Cross-pair filter regression coverage** (db-reviewer flagged as
  CRITICAL). Resolved by `TestSelectionMatrix_FilteredCrossPair` added in
  the A5 follow-up commit — confirms `buildSquirrelWhere` only emits `?`
  placeholders so the arg count holds with filtered inputs on both sides.

## From B4 (commit pending — Select Datasets rebuild)

P1/P2 features from docs/parity/select_datasets.md §2 that were intentionally
deferred during the overnight B4 task. Each is one line of context.

- **Default-active datasets / default filters** (rows 3, 4). Need
  schema_version=4 bump exposing `dataset_manifest.default_active` +
  `dataset_manifest.default_filters` so first-time visitors land on Shiny's
  preselection (`vdb_init.py:40-68`). Duplicates the A5 polish note.
- **Apply-to-all toggle on common fields** (rows 12, 14). Per-field
  switch in the modal header that propagates a common-field filter to
  every active dataset. Complex; needs cross-dataset field common-set
  computation and a sane resolution rule when a dataset has its own
  override.
- **from_pair annotation** (rows 15, 30, 31). Pairwise common-regulator
  apply writes `regulator_locus_tag` with a `from_pair: [A, B]`
  annotation; modal reads it to switch UI mode. FilterSpec wire shape
  needs an extra annotation field.
- **Pairwise highlight cell coloring** (row 30). Active pair gets a
  highlight background in the matrix once its tags are applied. Cheap
  once `from_pair` lands.
- **Sidebar search box** (row 24). Substring filter over display name
  with "No datasets match your search" empty state (row 34).
- **Sidebar collapse/expand** (row 23). Chevron toggle to hide the
  datasets sidebar from non-Select routes.
- **CSV+README export tarball** (rows 35, 36). Streamed tar.gz per
  dataset; requires `/api/v/{v}/export` (audit §7 row 8). Already
  flagged under A5 polish above.
- **Diagonal cell click → breakdown modal** (row 28). Backend already
  serves `/api/v/{v}/selection/breakdown`; the UI was scoped out for
  overnight budget reasons.
- **Cascade narrowing inside modal** (row 19). Upstream categorical
  selectize narrows downstream condition checkbox choices; needs
  column-role metadata + `level_definitions` (same schema_version=4
  bump).
- **Sort datasets by display_name** (row 1). Currently backend orders
  by `db_name`; minor visual nit, no behavioral change.
- **FIELD_TYPE_OVERRIDES via backend** (row 11). Already handled in A5
  (the field response already says `kind="categorical"` for
  `hackett.time`). Listed only for completeness.
- **Description tooltip on row** (row 22). Need `description` on
  field/dataset manifest (schema_version=4 bump).
- **Per-row staged Apply gate** (rows 18, 20). The B4 MVP writes the
  modal's "Apply Filters" directly to the URL, so each modal apply is
  a commit. The Shiny pattern coalesces toggles + filter edits before
  firing downstream queries; audit §8 already flagged this as UNCLEAR.
