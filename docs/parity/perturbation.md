# Perturbation Module — Parity Inventory

**Generated:** 2026-05-21
**Shiny source:** `reference/tfbpshiny/modules/perturbation/`
**React target:** `frontend/src/routes/Perturbation.tsx`
**Backend touchpoints:**
- `GET /api/v/{v}/perturbation` → `backend/internal/api/perturbation.go:26`
- SQL template: `backend/internal/queries/perturbation/data.sql` (rows for one regulator × one dataset)
- `backend/internal/queries/perturbation/corr_pair.sql` — **placeholder only** (`corr_pair.sql:1`)
- Indirectly used by React picker: `GET /api/v/{v}/regulators` (`RegulatorPicker.tsx:17`)

## 1. Summary

The Shiny module is a **multi-dataset correlation explorer** keyed on Effect-vs-P-value and Pearson-vs-Spearman: a box plot of per-regulator correlation values across every pair of selected perturbation datasets, with a regulator drop-down that overlays a black dot on each box and renders a grid of per-pair scatter plots beneath. The React route currently implements **none of this**: it renders a single `scattergl` "volcano" trace per dataset whose y-axis is the absolute value of the x-axis (literally `|effect|`), with no correlation math, no pair logic, no Pearson/Spearman toggle, no Effect/P-value toggle, no per-pair scatter grid, no sample-condition tooltips, and no missing-regulator warning. The backend exposes `/perturbation` returning per-(regulator, dataset) rows but ships no correlation endpoint — the SQL needed for it lives only as an empty placeholder file.

## 2. Feature matrix

| # | Feature (what user sees/does) | Shiny behavior (file:line) | React status | Gap | Severity |
|---|------------------------------|-----------------------------|---------------|------|----------|
| 1 | Sidebar "Column" radio: Effect vs P-value | `server/sidebar.py:91-97` | Absent | No control rendered anywhere | P0 |
| 2 | Sidebar "Correlation" radio: Pearson vs Spearman | `server/sidebar.py:98-105` | Absent | No control rendered anywhere | P0 |
| 3 | Empty-state message when no perturbation datasets selected | `server/sidebar.py:75-79` ("Select perturbation datasets…") | Partial (`Perturbation.tsx:43-48`) | React shows a single message that also requires `regulator`; Shiny shows the empty-state before any regulator is chosen | P2 |
| 4 | Box plot of per-regulator correlation values, one box per dataset pair | `server/workspace.py:199-345` (`distributions_plot`) | Absent | Replaced by a single scattergl "volcano" trace | P0 |
| 5 | Box plot x-axis label per pair = `"{display_a}<br>vs<br>{display_b}"` | `server/workspace.py:251` | Absent | No multi-pair concept in React | P0 |
| 6 | Box plot title = `"{Method} correlation across regulators"`, y-axis title `"{Method} r"` | `server/workspace.py:321-323` | Absent | Volcano hardcodes `xaxis title="effect", yaxis title="|effect|"` (`PerturbationVolcano.tsx:24-25`) | P0 |
| 7 | Box plot points shown (`boxpoints="all"`, `jitter=0.4`, `pointpos=0`, marker size 4, opacity 0.5) | `server/workspace.py:298-301` | Absent | No box trace exists | P0 |
| 8 | Default hover per box point: `"{display_name}\nr = {corr:.3f}"` | `server/workspace.py:294-297` | Absent | Volcano `hovertext` is only `targetLocusTag` (`PerturbationVolcano.tsx:16`) | P0 |
| 9 | Selected-regulator overlay (black `size=10` circle on every pair where that regulator exists) | `server/workspace.py:307-319` | Absent | No regulator drives the box; volcano shows whole result list | P0 |
| 10 | Selected-regulator hover with HTML-escaped condition labels per dataset: `display`, `r=…`, `"{label_a}: {cond}"`, `"{label_b}: {cond}"` | `server/workspace.py:276-287` | Absent | No condition map plumbed end-to-end; backend doesn't expose it | P1 |
| 11 | Click on any point in box plot sets selected regulator (Plotly `plotly_click` → `Shiny.setInputValue`) | `server/workspace.py:327-337` | Absent | No click handler; `PlotLazy` does not subscribe to `onClick` | P1 |
| 12 | Annotation when zero pairs (`<2 datasets`): "Select at least two perturbation datasets to see correlations." | `server/workspace.py:217-226` | Partial: React only warns when `<1` dataset OR `<1` regulator (`Perturbation.tsx:43-48`); does not enforce the "at least two" rule | P1 |
| 13 | Regulator drop-down (`input_selectize`), choices = union of regulators present in any pair's correlation data, labelled by gene symbol, sorted case-insensitively | `server/workspace.py:347-388` | Absent | Picker is a free-text search box (`RegulatorPicker.tsx`) that hits `GET /regulators?search=`, not constrained by data availability | P0 |
| 14 | Drop-down preserves previously selected regulator if still in the new choice set; otherwise picks the first item | `server/workspace.py:377-381` | Absent | URL only; no auto-default | P2 |
| 15 | "Scatter container": flex grid of one scatter plot per active pair below the box plot | `server/workspace.py:402-427` | Absent | No per-pair scatter is rendered at all | P0 |
| 16 | Per-pair scatter dots = effect vs effect (Pearson) or rank vs rank (Spearman) for the selected regulator across shared targets | `queries.py:216-300` (`regulator_scatter_sql`); rendered at `server/workspace.py:471-581` | Absent | No equivalent SQL on backend (`corr_pair.sql` is a stub); React doesn't request it | P0 |
| 17 | Per-pair scatter: title `"{display_a}<br>vs<br>{display_b}"` centered, x-axis `"{display_a}: {col_a}"`, y-axis `"{display_b}: {col_b}"`, fixed 400×400 px, color `#4A90D9`, marker size 4, opacity 0.6 | `server/workspace.py:570-577`, `547-557` | Absent | No scatter exists; current single volcano is 400 px high but full-width | P1 |
| 18 | Per-pair scatter: in-plot annotation `"r={corr:.3f}"` (top-right paper coords) using Pearson `corr()` of the joined values | `server/workspace.py:543, 559-569` | Absent | No correlation computed anywhere on client | P1 |
| 19 | Per-pair scatter hovertemplate: `"{display_a}: {x:.3f}\n{display_b}: {y:.3f}"` (no symbol/locus tag) | `server/workspace.py:553-556` | Absent | n/a | P1 |
| 20 | "scatter_missing_note": gray italic paragraph listing display names where the selected regulator is not found ("{reg} was not found in: …. Pairs involving these datasets are omitted.") | `server/workspace.py:429-469` | Absent | n/a | P1 |
| 21 | Selected regulator filter strips `regulator_locus_tag` before applying per-dataset filters to scatter SQL (avoids double-filter) | `server/workspace.py:510-514` | Absent | Backend always WHERE-clauses on `regulator_locus_tag = ?` in `data.sql:11`; no scatter endpoint | P1 |
| 22 | Per-dataset filters from `dataset_filters` reactive value (categorical, numeric, bool) apply to both box and scatter | `queries.py:81-116`, `server/workspace.py:507-508` | Partial | Backend accepts `?filters=` JSON (`perturbation.go:50-67`) but no UI emits it for this route (`Perturbation.tsx:16`) | P1 |
| 23 | Loading skeleton during data fetch | n/a (Shiny reactive; spinner is implicit) | Present (`Perturbation.tsx:42`) | OK | — |
| 24 | URL deep link: dataset selection lives in `?perturbation=` (shared with `/select`), regulator in `?regulator=`, filters in `?filters=` | n/a in Shiny (session state, not URL) | Present (`Perturbation.tsx:11-16`); missing `corr_type` and `col_preference` keys | P1 (URL state extension) |
| 25 | Symbol map: display name = gene symbol from `regulator_display_names` table, fallback to locus tag | `server/workspace.py:71-74`, `__init__.py` via `regulators/resolve` | Present at picker only (`generated.ts:597`+) | OK (independent surface) | — |
| 26 | Condition labels source: `{db}_meta` table joined on `sample_id` via `AppDatasets.condition_cols` per dataset; `" / "` separator from `build_condition_label` | `utils/sample_conditions.py:25-94`, `server/workspace.py:99-123` | Absent | No backend endpoint exposes condition map or sample metadata | P1 (backend) |
| 27 | Performance: single UNION-ALL query for all pairs (`corr_all_pairs_sql`) | `queries.py:154-213` | Absent | Backend has no correlation query at all | P0 (backend) |
| 28 | Tab-switch suppression: skips re-computation when not the active module | `server/workspace.py:88-89, 108-109` | n/a | React already uses query-key invalidation; not load-bearing | — |
| 29 | "Pearson uses raw values, Spearman uses ranks (effect ranked by ABS DESC, pvalue ranked ASC)" | `queries.py:270-292` | Absent | n/a | P0 (backend) |
| 30 | Download/export of any plot or table | n/a in Shiny (only Plotly's built-in toolbar) | Absent | Plotly toolbar is on by default (`config={displaylogo:false}` only) | P2 |

Severity legend: P0 = core functionality missing/incorrect; P1 = significant; P2 = polish.

## 3. Controls (every input/selector/threshold/toggle)

| Control | Shiny | React |
|---|---|---|
| **Column** radio (Effect / P-value) | `server/sidebar.py:91-97`, default `effect`; feeds `col_preference()`. Drives `get_measurement_column(db, preference)` per dataset, so Hackett/Hu-Reimand/Kemmeren/etc. pick `pvalue_col` when available else fall back to effect (`queries.py:25-50`). | **Missing.** No sidebar UI; backend always picks the default column from `pertMeasurementColumn` in `perturbation.go:17-24` (effect column only). |
| **Correlation** radio (Pearson / Spearman) | `server/sidebar.py:98-105`, default `pearson`; feeds `corr_type()`. Determines `RANK()` vs raw values in scatter SQL (`queries.py:275-298`) and the `corr_all_pairs_sql` aggregate. | **Missing.** No correlation computation anywhere. |
| **Regulator** selectize | `server/workspace.py:383-388`. Choices restricted to regulators present in any pair's correlation result; gene-symbol-labelled and case-insensitive sorted. Click on box overlay also sets it via JS `plotly_click` post-script. | `RegulatorPicker.tsx` — **free-text search** that calls `/regulators?search=q&limit=20`. Not constrained to active datasets; no click-from-plot path; no preservation of previous value across data churn. |
| **Dataset selection** | Lives in shared "Select Datasets" page; surfaced here via `active_perturbation_datasets()` reactive. Empty/<2 states produce specific empty-state UI. | `?perturbation=` in URL, set on `/select` route (`Select.tsx:42-48`). Empty-state is a single "pick regulator + datasets" message. The "need ≥2 datasets" rule is silently absent. |
| **Per-dataset filters** | `dataset_filters` reactive value; categorical/numeric/bool (`queries.py:97-116`). Drives both box and scatter; stripped of `regulator_locus_tag` before scatter (`server/workspace.py:510-514`). | Wire is half-built: `Perturbation.tsx:16` reads `?filters=`; backend parses JSON and validates field whitelisting (`perturbation.go:50-67`). **No UI exists to set them.** `FilterChips.tsx` is a regulator-resolver chip, not a per-dataset filter editor. |
| **Plot toolbar** (Plotly built-in: zoom, pan, autoscale, download PNG) | Default-on via `to_html(include_plotlyjs=False)` | Default-on via `PlotLazy` (`config={displaylogo:false, responsive:true}`). |

## 4. Plots (every plot type, with axes/colors/tooltips/legend detail)

### 4.1 Distributions plot (top, full-width)

**Shiny — `server/workspace.py:199-345`:**
- Type: **single `go.Box`** trace with `x` as the category axis (one category per pair, label `"{display_a}<br>vs<br>{display_b}"`).
- `boxpoints="all"`, `jitter=0.4`, `pointpos=0`, marker `size=4, opacity=0.5`, `line.width=1.5`, `showlegend=False`.
- y values = per-regulator correlation `r` between `db_a` and `db_b` for the user-chosen measurement column and method.
- Default hover (any box point): `"{regulator display}\nr = {r:.3f}"`.
- **Overlay trace** `go.Scatter` for the currently selected regulator: black `size=10` circles at the same (pair_label, r), one per pair where that regulator exists. Hovertext is multi-line, HTML-escaped, and includes condition label per dataset when present.
- Layout: `title="{Method} correlation across regulators"`, `yaxis_title="{Method} r"`, `margin=dict(l=40, r=20, t=50, b=80)`, `showlegend=False`.
- Empty state (no pairs): an `add_annotation` text "Select at least two perturbation datasets to see correlations." anchored at paper center.
- Plotly `post_script` registers a `plotly_click` handler that pushes `pt.customdata` (the regulator locus tag) back into the Shiny input `selected_regulator`.

**React — `frontend/src/plots/PerturbationVolcano.tsx`:**
- Type: **`scattergl` markers per dataset** (one trace per dataset, named `d.dbName`).
- `x = d.rows.map(r => r.value)`, `y = d.rows.map(r => Math.abs(r.value))` — this is **not** a volcano (no p-value), just `value` vs `|value|`. The placeholder comment at `PerturbationVolcano.tsx:14` calls this out.
- Hovertext: only `targetLocusTag` (`PerturbationVolcano.tsx:16`).
- Layout: `height=400, margin.t=20, xaxis title "effect", yaxis title "|effect|"`. No legend control. No annotation. No overlay. No click handler.

Gap is total: the React plot is a different plot type with no correlation math, no per-pair structure, and no selected-regulator interaction.

### 4.2 Per-pair scatter grid (below the box plot)

**Shiny — `server/workspace.py:402-427, 471-581`:**
- Container: flex row (`display:flex; flex-wrap:wrap; gap:1rem; align-items:flex-start`), one slot per active pair, slot id `scatter_{db_a}__{db_b}`. All slots are pre-registered at server init from the full Cartesian-pair catalogue (`workspace.py:391-400, 583-584`); only the active ones render content.
- Data: `regulator_scatter_sql(db_a, col_a, fa, db_b, col_b, fb, method, reg, pair_idx)` — joins per-target values across the two datasets for one regulator, returning `_val_a`/`_val_b` either as raw values (Pearson) or `RANK()` (Spearman, ranked by `ABS(val) DESC` for effect or `val ASC` for pvalue).
- Plot type: `go.Scatter`, mode `markers`, marker `size=4, opacity=0.6, color="#4A90D9"`, text = `target_locus_tag`, `hovertemplate="{display_a}: %{x:.3f}\n{display_b}: %{y:.3f}<extra></extra>"`, `showlegend=False`.
- Annotation: `"r={r:.3f}"` at paper (0.98, 0.98), top-right, font size 12. `r` is `merged["_val_a"].corr(merged["_val_b"])` (Pearson-on-ranks for Spearman, which equals Spearman r).
- Layout: title `"{display_a}<br>vs<br>{display_b}"` (x=0.5, xanchor center), `xaxis_title="{display_a}: {col_a}"`, `yaxis_title="{display_b}: {col_b}"`, fixed `width=400`, `height=400`, `margin=dict(l=50, r=20, t=100, b=50)`.
- Above the grid: `scatter_missing_note` — gray italic `<p>` listing display names where the regulator was not present in any successful pair (`server/workspace.py:429-469`). Format: `"{reg} was not found in: {names}. Pairs involving these datasets are omitted."`

**React:** Not implemented at all.

## 5. Tables / downloads

- No HTML data tables in either Shiny or React.
- Downloads: only the Plotly toolbar PNG button (default-on in both). No CSV export, no "download correlation matrix" affordance, no copy-to-clipboard.

## 6. Interactions (hover, zoom, brush, click-to-filter, cross-plot linking)

| Interaction | Shiny | React |
|---|---|---|
| Hover on box point: regulator name + r | Yes (`workspace.py:294-297`) | n/a (no box) |
| Hover on selected overlay: regulator + r + condition lines per dataset | Yes (`workspace.py:276-287`) | n/a |
| Click any point in box → set selected regulator → updates overlay + scatter grid + missing-note | Yes (`workspace.py:327-337`) | **Absent.** `PlotLazy` does not forward `onClick`. |
| Hover on scatter dot: per-axis value formatted to 3 decimals | Yes (`workspace.py:553-556`) | n/a |
| Plotly built-in zoom/pan/autoscale/double-click reset | Default on both | Default on both |
| Cross-plot linking: scatter grid is derived from the regulator chosen via the box-plot click or the selectize | Yes (full bidirectional) | n/a |
| Missing-note auto-updates when regulator changes | Yes (`workspace.py:435`+) | n/a |
| URL sync of regulator selection | n/a in Shiny | Yes (`Perturbation.tsx:27-31`) |
| URL sync of corr_type / col_preference | n/a in Shiny | **Absent** — no controls to sync |

## 7. Data flow

### Shiny queries (file:line + SQL shape)

1. **Pair-wise correlation across all active pairs** — `corr_all_pairs_sql` (`queries.py:154-213`).
   - For each active `(db_a, db_b)` pair, builds `_corr_pair_sql_impl(perturbation_data_query, ...)` (from `binding/queries.py` — shared impl) with the per-dataset filters and the user's measurement column.
   - Combines all per-pair SQLs into one `UNION ALL` with each branch tagged `'{db_a}__{db_b}' AS pair_key`.
   - Returns one DataFrame with `db_a, db_a_id, db_b, db_b_id, regulator_locus_tag, correlation, pair_key`.
   - Multiple samples per regulator → multiple rows per regulator per pair (noted in workspace docstring at `workspace.py:135-138`).
2. **Per-pair regulator scatter** — `regulator_scatter_sql` (`queries.py:216-300`).
   - Two `perturbation_data_query` sub-selects (one per dataset), each WHERE-filtered to `regulator_locus_tag = :reg` and with per-dataset filters (regulator stripped at the caller, `workspace.py:510-514`).
   - JOIN on `target_locus_tag`.
   - Pearson branch: `SELECT target_locus_tag, a.{col_a} AS _val_a, b.{col_b} AS _val_b`.
   - Spearman branch: project `val_a, val_b`, then `RANK() OVER (ORDER BY ABS(val_a) DESC | val_a ASC if pvalue)` for each axis (heuristic: pvalue detection is `'pval' in col_a.lower()` at `queries.py:270-273`).
3. **Sample condition map per dataset** — `fetch_sample_condition_map` (`utils/sample_conditions.py:55-94`).
   - `SELECT sample_id, "col1", "col2", … FROM {db}_meta` where the column list comes from `AppDatasets.condition_cols[db]`.
   - Stored in `_cond_maps_val` reactive (`workspace.py:97-123`); consumed only by the selected-overlay hover lines.
4. **Display-name lookup** — `get_regulator_display_name(vdb)` at server init (`workspace.py:71-74`), one-shot.

### React API calls (endpoint + params)

1. `GET /api/v/{v}/regulators?search=…&limit=20` from `RegulatorPicker` (`RegulatorPicker.tsx:17`). Free-text typeahead.
2. `GET /api/v/{v}/perturbation?regulator={reg}&datasets={csv}&filters={json}` from `Perturbation` route (`api/client.ts:105-113`, `Perturbation.tsx:18-25`). Returns one `PerturbationDatasetResult` per dataset, each containing `rows = [{regulatorLocusTag, targetLocusTag, sampleId, value}]` for that one regulator (`domain/perturbation.go`, `data.sql:5-12`).

### Mismatches

- **No correlation endpoint.** The backbone of the Shiny module — per-regulator correlation across all dataset pairs — has no Go endpoint. `backend/internal/queries/perturbation/corr_pair.sql:1` is a literal `-- placeholder; populated in later tasks` stub.
- **No scatter endpoint.** Per-pair regulator scatter (especially with Spearman ranks) has no backend support.
- **No sample-condition endpoint.** The `{db}_meta` lookups needed for tooltip condition labels are not exposed.
- **Column choice is server-baked.** `perturbation.go:17-24` always picks the effect column; the `col_preference` (effect vs pvalue) toggle has no way to reach the backend.
- **Filters wired but unused.** Filters are accepted server-side and threaded into `data.sql`, but no UI on this route can produce them.
- **Row shape mismatch with usage.** The current React plot uses `r.value` against `Math.abs(r.value)` — backend returns one column at a time, so even a real volcano (effect vs −log10(p)) cannot be drawn without a second column or a second request.

## 8. URL state / deep linking

Shiny: nothing in the URL; all state is session-scoped reactive.

React (`Perturbation.tsx:11-16`):
- `?perturbation=` — comma-separated dataset names, shared with `/select` and `/binding`.
- `?regulator=` — selected regulator locus tag.
- `?filters=` — raw JSON string passed through to backend.
- **Missing:** `?col_preference=` and `?corr_type=` (no controls to drive them). When those controls are added they should round-trip through the URL to match the rest of the SPA contract (CLAUDE.md §"Architecture in one paragraph": URL is the canonical state model).
- **Missing:** no defaulting logic when the regulator from the URL is not present in the currently active pairs' correlation result (Shiny falls back to first available, `workspace.py:377-381`).

## 9. Backend gaps blocking parity

1. **No `corr_all_pairs` query / endpoint.** Need either `/api/v/{v}/perturbation/correlations?datasets=…&method=…&col=…&filters=…` returning `{pairs: [{dbA, dbB, points: [{regulatorLocusTag, sampleA, sampleB, correlation}]}]}`, or a richer `/perturbation` response that includes the cross-pair correlation matrix. `corr_pair.sql` is currently a 1-line placeholder; the Shiny implementation in `reference/tfbpshiny/modules/binding/queries.py` (function `_corr_pair_sql_impl`) is the SQL shape to port.
2. **No per-regulator scatter query / endpoint.** Need `/api/v/{v}/perturbation/scatter?dbA=…&colA=…&dbB=…&colB=…&regulator=…&method=…&filters=…` returning aligned `{targetLocusTag, valA, valB}` (Pearson) or `{targetLocusTag, rankA, rankB}` (Spearman, with rank rules matching `queries.py:270-292`).
3. **No sample-condition lookup.** Need to surface `AppDatasets.condition_cols` and `{db}_meta` joins — either as a one-shot `/api/v/{v}/datasets/conditions?datasets=…` returning `{db: {sampleId: label}}`, or fold a `conditionLabel` field into the rows of the correlation endpoint.
4. **Column preference must be a request parameter.** Today `pertMeasurementColumn` in `perturbation.go:17-24` is a hard-coded effect-only map. The Shiny logic at `queries.py:25-50` falls back to effect when pvalue is requested but the dataset has no pvalue column — that fallback rule needs to live server-side and ideally be table-driven via `dataset_manifest`/`field_manifest` (matches the post-cutover Phase 1.6 note in CLAUDE.md about moving the column maps out of code).
5. **Pearson/Spearman computation site.** SQL-side aggregate (`corr_all_pairs_sql` in Python uses DuckDB aggregates per the docstring at `workspace.py:127-138`) is the right place — handler returns pre-computed `r` per `(pair, regulator, sample_id, sample_id)`. Compute on the backend, not in JS.
6. **`?datasets=` count constraint.** The "≥2 datasets" rule lives in Shiny's plot annotation; the React/backend contract should formalize it: e.g. 200 with empty `pairs` list when `len(datasets) < 2`, plus a documented client check.
7. **OpenAPI surface.** The current generated schema (`frontend/src/api/generated.ts:597-613`) only knows about `PerturbationResponse{datasets:[{dbName, column, rows:[{regulatorLocusTag, targetLocusTag, sampleId, value}]}]}`. Any new endpoint(s) added in (1)–(3) above must be added to the OpenAPI annotations and regenerated.

## 10. Open questions

- Should the correlation endpoint return raw per-(regulator, sample, sample) `r` values (matching Shiny's "multiple samples per regulator → multiple correlation rows" semantics at `workspace.py:135-138`), or should the backend collapse duplicates? Shiny does not collapse — preserving that means the React box plot must accept multiple y-values per regulator per pair.
- Spearman: should ranks be computed in SQL (matching `queries.py:275-292`) or computed once over the joined arrays on the server? The Shiny version is SQL-side because the join is performed in SQL anyway.
- Should the regulator drop-down's choices be sourced from the new correlation endpoint's response (so we get the exact Shiny "regulators present in at least one pair" semantics at `workspace.py:367-375`), or stay on the global `/regulators` search? Recommend the former — the picker UX changes meaning ("any regulator known to the system" vs "any regulator with usable correlation data given current filters").
- Sample-condition labels: per CLAUDE.md the column maps are slated for `schema_version=3`. Are condition columns also moving to the manifest, or should this endpoint inline `AppDatasets.condition_cols` from a YAML for now?
- Plotly bundle: `plotly-bundle.ts:9` registers `scatter, scattergl, heatmap, bar`. Box plots are **not** registered. Implementing the distributions plot will require adding the `box` chart type — and re-checking the gzip budget noted in `plotly-bundle.ts:6`.
- Click-to-select: do we want the box-click handler to set both `?regulator=` (URL) and trigger an immediate scatter refresh, or only the URL (letting the regulator picker observe it)? Recommend URL-only so the picker remains the single source of truth.
- Filter UI: there is currently no per-dataset filter editor in the SPA at all (only `FilterChips.tsx`, which is a regulator-resolver). Is the filter editor a Perturbation-route problem to solve, or a shared component blocking multiple modules?
