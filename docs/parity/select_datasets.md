# Select Datasets Module — Parity Inventory

**Generated:** 2026-05-21
**Shiny source:** `reference/tfbpshiny/modules/select_datasets/`
**React target:** `frontend/src/routes/Select.tsx`
**Backend touchpoints:** `GET /api/v/{v}/datasets` (only). No matrix, no per-dataset filters, no resolve, no metadata, no export endpoint is invoked from `Select.tsx`.

## 1. Summary

The React Select page implements a tiny subset of the Shiny module: a checkbox per dataset that writes `?binding=…&perturbation=…` to the URL. None of the **filter modal**, **regulator card / pairwise common regulator selection**, **intersection matrix**, **apply-to-all toggle**, **staged-vs-committed Apply gate**, **dataset description tooltip**, **search box**, **sidebar collapse**, **default-on dataset set**, **default filters** (e.g. `harbison.condition=YPD`), or **CSV/tar.gz export** are present. Backend has no endpoints for filter levels, column metadata (descriptions, roles, level_definitions), the matrix/intersection, common-fields, or export — they must be added before parity is achievable. This is by far the lowest-parity module in the rewrite.

## 2. Feature matrix

| # | Feature (what user sees/does) | Shiny behavior (file:line) | React status | Gap | Severity |
|---|------------------------------|-----------------------------|---------------|------|----------|
| 1 | Dataset list grouped by Binding / Perturbation, sorted by display name | `server/sidebar.py:109-132` | DONE | Closed in Phase C — commit `d3acce8`. `Select.tsx` now sorts the dataset list by `displayName` client-side. | — |
| 2 | Per-dataset toggle (on/off) | `server/dataset_row.py:55, 138-165` | Present as `<Checkbox>` (`Select.tsx:63-68`) | OK — but no "Apply" gate (writes immediately to URL) | P1 |
| 3 | Default-active dataset set (`harbison, rossi, chec_m2025, hackett, callingcards, kemmeren, degron` on first load) | `utils/vdb_init.py:40-50`, sidebar.py:149-152, 158-170 | DONE | Closed in Phase C — commit `d3acce8`. `Select.tsx` first-visit effect preselects datasets from `dataset_manifest.default_active` (schema v4) when URL has no `?binding=`/`?perturbation=`. | — |
| 4 | Default filter set (`harbison.condition=YPD`, `rossi.treatment=Normal`, `chec_m2025.Experimental condition=standard`, `hackett.time=[45,45]`) | `utils/vdb_init.py:55-68` | DONE | Closed in Phase C — commit `d3acce8`. Same first-visit effect seeds `?filters=` from `dataset_manifest.default_filters` (schema v4). | — |
| 5 | Per-row "Filter" button (opens filter modal) | `dataset_row.py:56-61, 168-221` | Missing — no filter UI at all | No filter editing in React app | P0 |
| 6 | Filter modal: two-column layout (Common Characteristics / dataset-specific) | `ui.py:232-490` | Missing | — | P0 |
| 7 | Filter modal: categorical fields → multi-select with `remove_button` plugin | `ui.py:71-102` | Missing | Backend has `filter_level_cache` but no endpoint to read it | P0 |
| 8 | Filter modal: numeric fields → range slider clamped to data min/max | `ui.py:126-156` | Missing | No min/max metadata exposed by backend | P0 |
| 9 | Filter modal: boolean fields → switch with `"{field} ({description})"` label | `ui.py:104-124` | DONE | Closed in Phase C — commit `d3acce8`. `DatasetFilterModal` renders boolean fields with `title={description}` (sourced from `field_manifest.description`, schema v4). | — |
| 10 | Filter modal: experimental_condition columns → labelled checkbox group from `level_definitions` | `ui.py:161-219` | Missing | No `level_definitions` in backend manifest | P0 |
| 11 | Filter modal: FIELD_TYPE_OVERRIDES (e.g. hackett.time numeric→categorical sorted numerically) | `queries.py:17-20`, `ui.py:57-78` | Missing | Override table must move into backend metadata | P1 |
| 12 | Per-field "Apply to all datasets" toggle in modal header (common fields only) | `ui.py:63-69, 191-197`, sidebar.py:541-548, 613-650 | DONE | Closed in Phase C — commit `0eab148`. `DatasetFilterModal` renders a per-field "Apply to all datasets" checkbox for categorical/numeric fields common to every active dataset; modal Apply mirrors flagged specs into other active datasets. | — |
| 13 | Regulator card inside modal: searchable multi-select of `SYMBOL (LOCUS_TAG)` | `ui.py:329-417`, dataset_row.py:192-205 | DONE | Closed by SD-5 — `RegulatorFilterCard.tsx` is a search + removable-chips multi-select over `GET /datasets/{db}/regulators` (`SYMBOL (LOCUS_TAG)` display), with Clear + Apply-to-all (default ON) + the `from_pair` restricted-choices variant. Writes a `regulator_locus_tag` categorical spec. | — |
| 14 | Regulator card: "Apply to all datasets" + "Clear" button | `ui.py:393-405`, sidebar.py:443-469 | DONE | Closed in Phase C — commit `0eab148`. Apply-to-all + Clear semantics land via the same per-field apply-to-all path used by the common-fields surface. | — |
| 15 | Pairwise regulator filter context in modal (note + restricted choices when `from_pair` set) | `ui.py:339-380` | DONE | Closed in Phase C — commit `0eab148`. Filters carrying the `from_pair` annotation surface an inline cleanup link in the modal; `CommonRegulatorsModal` attaches the originating display-name pair when writing `regulator_locus_tag`. | — |
| 16 | Modal footer: "Reset" + "Apply Filters" buttons | `ui.py:478-489`, sidebar.py:401-441, 471-677 | Missing | — | P0 |
| 17 | Reset semantics: clears this dataset's filters AND common-field filters from all datasets | `sidebar.py:401-441` | DONE | Closed by SD-6b — modal Reset calls `onResetDataset(db)`, which drops the open dataset's whole block + every active dataset's common-field blocks, committed immediately. `regulator_locus_tag` on *other* datasets is preserved (not a common df column), matching Shiny. | — |
| 18 | Apply semantics: propagates common-field filters to all datasets per `apply_to_all`; auto-activates dataset | `sidebar.py:471-677` | DONE | Closed in Phase C — commit `0eab148`. Modal Apply returns `{next, applyToAllFields}`; page mirrors flagged specs into every other active dataset that has the field. | — |
| 19 | Cascade: upstream categorical selectize narrows condition-checkbox choices in same modal | `sidebar.py:295-399` | Missing | Needs column-role metadata and `level_definitions` | P1 |
| 20 | Pending-vs-committed staging: changes to toggles + filters do not fire downstream queries until user clicks sidebar "Apply" | `sidebar.py:154-189, 679-691` | DONE (toggles) | Closed in Phase C — commit `0eab148`. Dataset checkbox toggles now update `pendingBinding`/`pendingPerturbation` local state; sticky footer Apply/Reset commits to URL. **Filter modal Apply still writes URL directly** — smallest-blast-radius decision per audit §8. SD-6c persists each common/regulator spec's `applyToAll` annotation in `?filters=` (frontend-only; the Go decoder drops it, so no cache fragmentation), so propagation + retroactive-clear survive reopen and are driven off the annotation rather than the live active-set intersection. | P2 (modal stage) |
| 21 | Sidebar "Apply" button visible only when pending differs from committed | `sidebar.py:906-911` | DONE | Closed in Phase C — commit `0eab148`. Footer Apply/Reset surface only when pending differs from committed. | — |
| 22 | Dataset description shown as tooltip on each row label | `dataset_row.py:50-55` | DONE (field-level) | Closed in Phase C — commit `d3acce8`. Field-level description tooltip lands via `title=` on `FieldLabel` (from `field_manifest.description`). Dataset-row tooltip needs `dataset_manifest.description` (schema v5) — see polish.md. | P2 (dataset row) |
| 23 | Sidebar collapse / expand toggle (header chevron) | `server/sidebar.py:218-229, 873-902` | DONE | Closed in Phase C — commit `0eab148`. Header chevron toggles `?selectSidebar=collapsed`. URL-canonical per CLAUDE.md. | — |
| 24 | Search box in sidebar filtering datasets by display-name substring | `server/sidebar.py:815-820, 839-863` | DONE | Closed in Phase C — commit `0eab148`. Sidebar local-state search box filters by `displayName.toLowerCase().includes(q)`. | — |
| 25 | Per-row "active filter" badge (`btn-filter-active` CSS) when dataset has any filters set | `dataset_row.py:55-61`, sidebar.py:812, 834 | Missing | — | P1 |
| 26 | Intersection matrix workspace: per-dataset diagonal (`{N} regulators / {M} samples`) | `server/workspace.py:74-126`, queries.py:208-237 | Missing | No backend matrix endpoint | P0 |
| 27 | Intersection matrix: upper-triangle off-diagonal cells (`{N} common regulators`) | `workspace.py:74-126`, queries.py:239-305 | Missing | No backend pairwise endpoint | P0 |
| 28 | Diagonal-cell click → modal explaining sample/regulator multiplicity, listing differentiating columns | `workspace.py:127-185`, queries.py:133-185, ui.py:509-544 | DONE | Closed in Phase C — commit `d3acce8`. `DatasetBreakdownModal` (modeled on `CommonRegulatorsModal`) opens on diagonal cell click via the existing `/api/v/{v}/selection/breakdown` endpoint. | — |
| 29 | Off-diagonal-cell click → modal listing N common regulators with "Select N common regulators" button | `workspace.py:187-229`, ui.py:547-583 | Missing | Backend `/regulators/resolve?common=A:B` supports the resolve, but the modal flow & matrix UI absent | P0 |
| 30 | Applying common-regulators from a pair writes `regulator_locus_tag` filter to ALL datasets with `from_pair` annotation and highlights cell | `workspace.py:231-290` | DONE | Closed in Phase C — commit `0eab148`. `CommonRegulatorsModal` writes `regulator_locus_tag` filters carrying a `from_pair` annotation via new `AnnotatedFilterSpec` helper; `SelectionMatrix` highlights the originating cell. | — |
| 31 | Re-clicking the active off-diagonal pair clears the regulator filter and unhighlights | `workspace.py:192-218, 333-353` | DONE | Closed in Phase C — commit `0eab148`. Clicking a highlighted cell fires `onHighlightedClear`; `Select.tsx` removes every `from_pair`-annotated `regulator_locus_tag` filter plus the `?regulators=` side-channel. | — |
| 32 | Empty-state copy: "Select datasets from the sidebar to view sample counts." | `workspace.py:357-368` | Missing (workspace itself absent) | — | P2 |
| 33 | Matrix error fallback: "Failed to load dataset matrix. Check that filters are valid." | `workspace.py:369-382` | Missing | — | P2 |
| 34 | "No datasets match your search" empty state | `sidebar.py:865-871` | DONE | Closed in Phase C — commit `0eab148`. Sidebar shows "No datasets match your search." when query is non-empty and no rows match. | — |
| 35 | Per-dataset CSV+README export bundled as `.tar.gz` (one dir per dataset, `metadata.csv` + `annotated_features.csv` + `README.md`), with progress bar | `export.py:39-213`, sidebar.py:693-780 | DONE | Closed in Phase C — commit `d0bcd24`. `GET /api/v/{v}/export?datasets=…&filters=…` streams gzip+tar (one subdir per dataset, three files each). | — |
| 36 | Sidebar footer with "Export Selected Datasets" button — visible only when ≥1 dataset is active | `sidebar.py:916-933` | DONE | Closed in Phase C — commit `d0bcd24`. `ExportSelectedButton` in the Select sidebar footer; visibility gated on committed selection. | — |
| 37 | Selection persists across navigation (return to Select tab shows same toggles) | `sidebar.py:782-810` (`active_module` re-renders) | Present-by-accident: URL is the canonical state and other routes read `?binding=`/`?perturbation=`, so coming back to /select preserves it | OK | — |
| 38 | Toggling off a dataset clears its filter from `dataset_filters` | `dataset_row.py:152-165` | N/A — no filters state exists | Becomes P1 once filters land | P1 |
| 39 | Loading skeleton during `/datasets` fetch | n/a (Shiny) | Present (`Select.tsx:119-129`) | OK | — |
| 40 | Error fallback if `/datasets` fails | n/a (Shiny) | Present (`Select.tsx:132-141`) | OK | — |
| 41 | Read-only dataset metadata block (`db_name`, `assay`, `source`, `sample_id`, `Fields(n)`) | not shown in Shiny sidebar | Present (`Select.tsx:73-99`) — React-only addition, useful for dev | OK | — |

## 3. Controls (inputs, selectors, toggles, search)

- **Per-dataset toggle**: React has `<Checkbox>` per row; Shiny has `ui.input_switch` plus a staged-Apply gate. Severity P1 — coalescing toggles before query fires was an explicit Shiny pattern.
- **Filter button per row**: missing entirely (P0).
- **Inside filter modal**: missing entirely — selectize/multi-select, slider, switch, checkbox group, "Apply to all" switch, "Reset" + "Apply Filters" buttons, regulator selectize with "Clear" (P0/P1).
- **Sidebar "Apply"**: missing (P1) — currently every checkbox click immediately changes URL and re-queries downstream.
- **Sidebar search box**: missing (P2).
- **Sidebar collapse chevron**: missing (P2).
- **Export Selected Datasets button**: missing (P1).
- **Matrix cell buttons (diagonal & off-diagonal)**: missing (P0/P1) — workspace not implemented at all.

## 4. Outputs (lists, summaries, validations)

- **Dataset list**: present, but sorted differently and dataset-row UI is far richer in React (shows `assay`/`source`/`fields` block) while missing description tooltip.
- **Intersection matrix table**: missing (P0). This is the primary visual output of the Shiny `selection-workspace` and is what conveys "regulators × samples × pairwise overlap" at a glance.
- **Diagonal modal copy** (uniform vs differentiating columns): missing (P1).
- **Off-diagonal modal copy** ("A and B share **N** regulators…"): missing (P0).
- **Active-filter badge on row**: missing (P1).
- **Pending-changes "Apply" button visibility**: missing (P2).
- **Error/empty states**: matrix-empty, matrix-failed, no-search-match all missing (P2 because the surrounding features are also missing).
- **Loading skeleton + error fallback for the dataset list**: present in React (good).

## 5. Data flow

### Shiny queries (per `queries.py`):
- `metadata_query(db_name, filters)` — `SELECT * FROM {db}_meta {WHERE}` — fired when modal opens and inside cascade calc.
- `regulator_display_labels_query(db_name)` — `SELECT DISTINCT regulator_locus_tag, regulator_symbol FROM {db}_meta ORDER BY regulator_locus_tag` — modal open.
- `matrix_diagonal_query(active, filters)` — one UNION ALL across all active datasets → `(db_name, n_regulators, n_samples)`.
- `matrix_cross_dataset_query(pairs, filters)` — one UNION ALL across all pairs → `(pair_id, n_common, samples_a, samples_b)`.
- `regulator_breakdown_query(db_name, candidate_cols, filters)` — diagonal-cell modal: `n_multi` + per-column distinct counts.
- `regulator_locus_tags_query(db_name, filters)` — off-diagonal apply: distinct regulator tags per side; intersection in Python.
- `sample_count_query`, `full_data_query` — used by export.

### React API calls (from `Select.tsx` + transitive):
- `api.datasets()` → `GET /api/v/{v}/datasets` (only call).

### Mismatches:
- No frontend call for matrix counts, regulator labels per dataset, breakdown, sample counts.
- `/api/v/{v}/regulators/resolve` exists and handles N-way intersection (`regulators_resolve.go:70-144`) — could power the off-diagonal "common regulators" flow, but `Select.tsx` never invokes it. `FilterChips.tsx` invokes it but is not wired into Select.
- Default-on datasets + default filters from `vdb_init.py:40-68` are nowhere on the frontend; backend doesn't expose them either.
- The Shiny app caches `metadata_query` results client-side via reactive values; in the rewrite, raw metadata for the modal must come from a new backend endpoint (Go service is stateless).

## 6. URL state / deep linking

- React encodes `?binding=A,B&perturbation=C,D` (Select.tsx:42-48) and shares it with Binding/Perturbation/Comparison (verified: `Binding.tsx:15`, `Perturbation.tsx:15`, `Comparison.tsx:15-16`). Good.
- React encodes `?filters=<json>` (read in Binding/Perturbation/Comparison routes) but Select.tsx never writes it.
- Shiny holds toggle + filter state as server-side reactive values keyed by session — not URL-encoded. The React URL model is a strict improvement, but **Select.tsx must own writing `?filters=` and the rest of the app must round-trip it**. The cache key in `binding.go:74-85` re-marshals filter JSON so ordering doesn't matter, which is good for parity.
- No URL key currently exists for: sidebar collapsed state, search term, active regulator-pair highlight, "from_pair" annotation. All but the first are user-visible state in Shiny.

## 7. Backend gaps blocking parity

These endpoints / payload fields do **not exist** today and must be added before React can reach parity:

1. **Column-metadata endpoint** (P0). Need at minimum per `(db_name, field)`: type (categorical/numeric/bool), description, role (`experimental_condition` / `regulator_identifier` / `target_identifier` / other), and `level_definitions` map. Currently `field_manifest` is just `(db_name, field)` strings (`manifest.go:29-33`). The CLAUDE.md outstanding-follow-ups list already flags this as a `schema_version=3` bump in `data_prep/`.
2. **Filter levels endpoint** (P0). Backend has `filter_level_cache` (`manifest.go:35-40`, populated in `data_prep/.../manifests.py:215-267` with threshold 50) but no HTTP exposure. Need `GET /api/v/{v}/datasets/{db_name}/fields` (or similar) returning levels + counts.
3. **Numeric field range** (P0). Need min/max per `(db_name, field)` for slider rendering; not in any manifest today.
4. **Regulator-display-labels endpoint** (P1). `GET /api/v/{v}/datasets/{db_name}/regulators` → `[{locus_tag, symbol, display}]`. Today `/regulators` is a global search by name, not a per-dataset enumeration.
5. **Matrix counts endpoint** (P0). `GET /api/v/{v}/selection/matrix?datasets=A,B,C&filters=<json>` returning Shiny's `_matrix_data()` shape: `{diagonal: {db: {regulators,samples}}, cross_dataset: {pair_id: {n_common, samples_a, samples_b}}}`. Internally folds `matrix_diagonal_query` + `matrix_cross_dataset_query` (queries.py:208-305).
6. **Regulator breakdown endpoint** (P1). `GET /api/v/{v}/selection/breakdown?dataset=…&filters=…` powering the diagonal-cell modal (`regulator_breakdown_query`).
7. **Defaults endpoint or static config** (P1). Expose `DEFAULT_ACTIVE_DATASETS` and `DEFAULT_DATASET_FILTERS` to the SPA so first-time visitors land on the same preselection. Could be baked into `dataset_manifest` (`default_active` bool column + a `default_filters` JSON column) or returned by `/datasets`.
8. **Export endpoint** (P1). `GET /api/v/{v}/export?datasets=…&filters=…` streaming a tar.gz with per-dataset `metadata.csv` + `annotated_features.csv` + `README.md`, mirroring `export.py:129-213`. Must stream chunks to avoid materialising the whole archive in memory under `mem_limit=1.6g`.
9. **Hidden-fields visibility** (P1). `HIDDEN_FILTER_FIELDS` (`data_prep/.../manifests.py:124-140`) drives modal exclusions. The runtime `field_manifest` already subtracts hidden fields (line 183), so no extra endpoint work needed for the "what to show" dimension — but the cascade logic in `sidebar.py:295-399` plus the diagonal modal in `workspace.py:127-185` both reference `HIDDEN_FILTER_FIELDS` directly; these uses must be re-implemented over the field manifest contract.
10. **`from_pair` round-trip** (P2). Pairwise filter writes a `from_pair: [displayA, displayB]` annotation into `regulator_locus_tag` (`workspace.py:281-285`); the filter modal reads it to switch UI mode (`ui.py:339-380`). Backend's `FilterSpec` currently has only `{type, value}` (`domain/filter.go:5-8`) — extra annotations must either pass through (`json.RawMessage` ignored fields) or get a dedicated URL param.

## 8. Open questions

- **UNCLEAR**: Should the React version retain pending-vs-committed staging (sidebar "Apply" gate)? The CLAUDE.md design states "URL + Zustand on the frontend; stateless on the backend." URL writes are cheap, but every checkbox toggle today re-queries downstream tabs (because `qk.binding`/`qk.perturbation` keys change with the `datasets` array). Verification: load the Comparison tab and rapid-toggle four checkboxes on Select — confirm `/comparison/topn` fires 4 times, not 1.
- **UNCLEAR**: Is the intersection matrix a hard requirement for v1 cutover or can it ship in a follow-up? The CLAUDE.md status says "API contract is frozen — no further breaking changes without a version bump", which a `/selection/matrix` endpoint would not break (additive). Verification: check `tests/parity/` to see whether the matrix counts have a parity snapshot — none observed in this audit.
- **UNCLEAR**: Does the export feature need to be reachable from the Go runtime, or can it be deferred to a small companion Python service? The Shiny export uses `vdb._conn.cursor()` and gzips at `compresslevel=1`; doing this from Go means another DB checkout from the `MaxOpenConns=2` pool, which could starve other handlers on `t3.small`. Verification: peak-RSS measurement during a full export in k6/cutover gate (not yet recorded — `tests/loadtest-summary.md` is still a template).
- **UNCLEAR**: How is the `description` field for column metadata populated? `labretriever.ColumnMeta.description` is the source in Shiny (`ui.py:319`); the equivalent in the Go-served artifact must come from `DataCard` YAML during `data_prep/build_duckdb.py`. Verification: read `data_prep/brentlab_yeast_collection.yaml` and confirm per-field descriptions exist before promising the API.
- **UNCLEAR**: What is the intended UX for `FIELD_TYPE_OVERRIDES`? In Shiny, `hackett.time` is numeric in DB but categorical in UI. The override map (`queries.py:17-20`) is a Python constant — should the rewrite move this into `dataset_manifest`/`field_manifest` (recommended) or keep a JSON-side override constant in the React bundle? Verification: confirm with operator whether `time` is the only such override or whether more are anticipated.
- **UNCLEAR**: Should the default-active datasets be a server-side constant (in `dataset_manifest`) or a client-side default in Zustand? The former survives cache rolls; the latter is simpler. Recommend server-side to keep parity with `DEFAULT_ACTIVE_DATASETS`.

## 9. Accepted divergences (SD-5 / SD-6 work, 2026-05-29)

These are intentional, reviewed deviations from Shiny driven by the URL-as-state architecture (CLAUDE.md), not bugs:

- **Apply-to-all propagates to ACTIVE datasets only** (Shiny writes the spec to every dataset in the VirtualDB, active or not — `sidebar.py:618,652`). The URL `?filters=` only carries blocks for active datasets, so a dataset *filtered while inactive then activated later* does not back-fill an apply-to-all filter set while it was off. In practice the only field common to **all** primary datasets is `regulator_locus_tag` (special-cased), so generic common-field divergence is limited to the rare "activate a previously-inactive dataset after an apply-to-all" sequence. Retroactive clear is annotation-driven (`Select.tsx onApplyFilters`), so a removed shared filter is still cleared from every *active* sibling regardless of the live `commonFields` intersection (closes the SD-6c stale-filter bug class for active datasets).
- **Regulator Clear stages behind Apply.** Shiny's `_clear_regulator_filter` commits immediately; the rewrite's single-gate filter modal clears the regulator from local pending and commits on "Apply Filters" (consistent with every other field edit). Committed result is identical.
- **`?filters=` 16 KB cap.** A manual regulator multi-select mirrored across several active datasets can exceed the backend `MaxFiltersBytes` cap and 400 (the pre-existing pairwise flow had the same ceiling). The backend fails safe; there is no client-side soft guard yet. Tracked as a follow-up.
- **Cascade narrowing (SD-6a)** remains deferred — inert on real data (`upstream_cols` empty); see `auto-status/polish.md`.

---

_Audit table updated 2026-05-29: SD-5 (regulator card) + SD-6b/SD-6c (Reset + apply-to-all persistence) closed. Prior update 2026-05-22 after Phase C._
