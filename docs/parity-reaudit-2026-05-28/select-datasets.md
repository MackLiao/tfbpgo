# Select Datasets

**Parity verdict:** Far more complete than the 2026-05-21 audit claimed — the intersection matrix, filter modal, common-regulators modal, breakdown modal, default-active datasets, sidebar search/collapse, staged-Apply gate, `from_pair` annotation, and CSV+README export **all exist at HEAD**. But this surface also carries the most remaining correctness defects, including **one of the two P0 blockers** and several P1s that silently corrupt the selected regulator set or crash on legitimate input. The single-dataset fixture hides nearly all of them.

> The headline defect (the common-regulators flow 400-ing the matrix/breakdown/export) is documented in [CRITICAL.md → P0-2](CRITICAL.md#p0-2--common-regulators-narrowing-flow-400s-end-to-end).

## P0

**SD-0a · Default filters 400 the matrix on first load (P0-3, reproduced live on real data)** — see [CRITICAL.md → P0-3](CRITICAL.md). On the real artifact, `write_field_manifest`'s `join_keys = data_cols ∩ meta_cols` heuristic (`manifests.py:355`) drops the experimental-condition columns (`condition`/`time`/`treatment`) from `field_manifest`, but `dataset_manifest.default_filters` seeds exactly those fields for chec_m2025/hackett/harbison/rossi. The Select page seeds them into the URL on first visit → `/selection/matrix` → `CheckField` rejects each → **400** with zero user action. Symptom: *"Failed to load dataset matrix. Check that filters are valid. (HTTP 400)"* (`SelectionMatrix.tsx:77`). **Fixture-masked** — the synthetic `{db}`/`{db}_meta` don't share metadata columns, so it only appeared once the real `tfbp.duckdb` was built.

**SD-0b · `regulator_locus_tag` filter rejected (400) by matrix/breakdown/export (P0-2)** — see [CRITICAL.md → P0-2](CRITICAL.md). After "Select N common regulators" writes the filter to every dataset, the matrix refetch, breakdown modal, and export all 400 because the field is hidden from `field_manifest` and only `/corr` strips it. Same HTTP-400 symptom as SD-0a, different trigger + fix site.

## P1

### SD-1 · Common-regulators resolve is filter-blind (matrix cell is filter-aware)
The matrix cell `n_common` applies each dataset's active filters to both INTERSECT arms (`select_datasets.go:532-536`, `matrix_cross_dataset.sql:18-23`) — matching Shiny (`queries.py:266-272`, `workspace.py:115`). But the modal behind that cell calls `api.resolve({ common })` with **no filters** (`CommonRegulatorsModal.tsx:81-85`); the `api.resolve` signature can't send filters at all (`client.ts:85-94`); `RegulatorsResolve` reads no `?filters=` (`regulators_resolve.go:71-121`); and `resolve_intersect.sql:5-9` is `SELECT DISTINCT … FROM {table}_meta INTERSECT …` with **no WHERE**.
Shiny's apply path recomputes the intersection with non-regulator filters applied, stripping only `regulator_locus_tag` (`workspace.py:253-269`).
**Effect:** when any non-regulator filter is active, the cell shows `|filter(A) ∩ filter(B)|` but the modal displays *and writes back* the larger `|all(A) ∩ all(B)|` superset — a numeric + behavioral divergence on the selected regulator set.

### SD-2 · Common-regulator set silently capped at 1000 tags
`/regulators/resolve` caps at `maxResolvedTags = 1000` and sets `truncated:true` (`regulators_resolve.go:18-19,207-208`); the modal selects only the returned tags (`CommonRegulatorsModal.tsx:87,134-142`). Shiny writes the **full** `sorted(reg_sets[a] & reg_sets[b])` with no bound (`workspace.py:269,280-286`). A pair sharing >1000 regulators narrows to the alphabetically-first 1000 → smaller diagonal/cross counts than Shiny. Fixture can't exercise this.

### SD-3 · Filter modal exposes data-table-only columns → filtering them 500s
Shiny builds the filter modal from `SELECT * FROM {db}_meta` columns only (`dataset_row.py:182-183`, `ui.py:289`) — so `target_locus_tag`, `score`, `poisson_pval`, `effect`, `pvalue`, etc. are **never** filter controls.
The rewrite builds `field_manifest` by unioning `{db}` **and** `{db}_meta` columns (`manifests.py:350-369`); `/datasets/{db}/fields` returns all of them and the modal renders all of them (`select_datasets.go:250-301`, `DatasetFilterModal.tsx:197-216`). Fixture: callingcards `field_manifest` = `[callingcards_enrichment, condition, poisson_pval, score, target_locus_tag]` vs `callingcards_meta` = `[gm_id, regulator_locus_tag, regulator_symbol, condition]` — **4 of 5 are data-table-only**. The matrix WHERE runs against `{db}_meta` (`select_datasets.go:457`), so filtering on e.g. `score` emits `"score" >= ?` against a view lacking the column → SQL error → **500**.

> **Real-data confirmation (2026-05-28, artifact `local-20260528`):** worse on the real artifact, and entangled with [P0-3](CRITICAL.md). The `join_keys` exclusion (`manifests.py:355`) drops the *useful* experimental-condition filters (`condition`/`time`/`treatment`) while leaving measurement + **genomic-coordinate** columns in `field_manifest` — e.g. chec_m2025 exposes `enrichment, poisson_pval, end, start, strand, seqnames, target_symbol, target_locus_tag, …` and rossi exposes `background_counts, experiment_counts, end, start, …`. So on real data the filter modal offers coordinates/p-values (which 500 when filtered) and hides the condition filters (which 400 via default_filters). Both SD-3 and P0-3 are symptoms of the same broken `field_manifest` field-selection logic.

### SD-4 · High-cardinality categoricals are unfilterable
`filter_level_cache` only stores levels for fields with ≤ `LEVEL_CACHE_THRESHOLD = 50` distinct values (`manifests.py:396-400`); the fixture has zero rows for `target_locus_tag`. `/datasets/{db}/fields` returns `levels:[]` for those, and the modal renders "No cached levels for this field." with **no control** (`DatasetFilterModal.tsx:289-314`). Shiny enumerates live distinct values and renders a searchable selectize regardless of cardinality (`ui.py:71-102`). (Combined with SD-3, the leaked `target_locus_tag` is also a dead control.)

### SD-5 · No in-modal Regulator selectize card
Shiny prepends a Regulator card to the filter modal: a searchable selectize over the **full** `regulator_display_labels`, an "Apply to all datasets" switch defaulting **True**, a Clear button, and a restricted-choices variant when `from_pair` is active (`ui.py:339-417`); the Apply handler propagates the regulator filter to all datasets (`server/sidebar.py:549-611`), with a separate Clear effect (`:443-469`).
The rewrite renders only generic fields (`DatasetFilterModal.tsx:197-217`); the only in-modal regulator entry is an inline "Click to clear" link on an *already-set* `fromPair` filter (`:250,268-282,431-445`). The only way to *create* a regulator filter is the pairwise CommonRegulatorsModal, which always produces a `from_pair`-annotated intersection (`Select.tsx:372-399,612-620`). The `/datasets/{db}/regulators` handler is wired (`router.go:70`, `client.ts:209`) but **never called**.
**Effect:** a user cannot manually pick an arbitrary regulator (or hand-picked set) to filter by unless they route through a pair intersection.

### SD-6 · Cascade narrowing missing · Reset semantics inverted · apply-to-all not persisted
*(Originally bundled P2; verifier re-scoped to P1 for the apply-to-all sub-claim.)*
- **Cascade narrowing — missing.** Shiny narrows condition-checkbox *choices* to upstream-co-occurring levels via per-column reactive effects (`server/sidebar.py:295-399`, `:39-68`). The rewrite renders the full level list and documents the cascade as deferred (`DatasetFilterModal.tsx:11-15,289`). Needs `upstream_cols` (not in the artifact — see [data-prep-manifest.md](data-prep-manifest.md)).
- **Reset inverted.** Shiny's `_reset_filter_modal` *clears* common-field filters from **every** dataset and pops the open dataset's filters (`sidebar.py:401-441`). React `onReset` merely reverts local pending to current — a "revert edits" button, not a "clear filters" button — and never touches sibling datasets (`DatasetFilterModal.tsx:159-162`).
- **apply-to-all not persisted (the impactful one).** The wire `FilterSpec` is `{type,value}` only (`generated.ts:1573-1577`); React `applyToAll` is local `useState({})` reset on every modal open (`DatasetFilterModal.tsx:142,161`). Consequences vs Shiny: (a) no True-default (Shiny defaults condition + regulator toggles to True, `ui.py:192,337,403`); (b) **removed common fields are not retroactively cleared from sibling datasets** (`Select.tsx:281-282`), leaving a **stale filter constraining other datasets' queries** that the user believes they removed — a downstream numeric impact. Shiny handles this via `prev_apply_to_all` (`sidebar.py:634-650`).

> **Refuted sub-claim:** the audit also alleged a `chec_m2025` default-field-name divergence (`condition` vs `Experimental condition`). The verifier found the rewrite is **more correct** — Shiny keys the default on the alias label `"Experimental condition"` which `_build_where` would interpolate as a non-existent SQL column (a latent Shiny bug); data_prep correctly keys on `condition` (`manifests.py:46`). Not a gap.

## P2 / cosmetic

| # | Gap | Evidence |
|---|---|---|
| SD-7 | Breakdown drops a column when only one regulator varies (React filters `distinctValues>1`; Shiny keeps `>0`) and mislabels "(N values)" | `select_datasets.go:755`; `workspace.py:173` vs `queries.py:164-166` |
| SD-8 | Matrix axes ordered by `db_name` alpha (interleaving binding/perturbation) vs Shiny's binding-then-perturbation, each by display_name/year | `Select.tsx:176-179`, `select_datasets.go:424-425` vs `workspace.py:69`, `sidebar.py:109-132` |
| SD-9 | Filtering an **inactive** dataset does not activate it (React writes only `?filters=`); Shiny toggles it on | `Select.tsx:273-312` vs `sidebar.py:671-673` |
| SD-10 | "Apply to all datasets" toggle defaults OFF; Shiny defaults condition + regulator ON | `manifests`/modal vs `ui.py` |
| SD-11 | Condition checkbox labels drop the raw-value suffix (`{def} ({v})`) — empty because level-definitions ship empty (see [data-prep-manifest.md](data-prep-manifest.md)) | `ui.py:185-188` |
| SD-12 | Export: subdirs named by raw `dbName` vs sanitized display_name; README always emitted with extra metadata; numeric filter WHERE lacks `TRY_CAST`; one-shot default seeding vs per-session reseed; no per-dataset progress bar; different archive filename | `export.go:157-181`, `binding.go:142-150`, `Select.tsx:321-365` vs `export.py:170,201`, `ui.py:419-471`, `sidebar.py:149-160` |
