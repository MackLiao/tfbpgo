# Comparison Module — Parity Inventory

**Generated:** 2026-05-21
**Shiny source:** `reference/tfbpshiny/modules/comparison/`
**React target:** `frontend/src/routes/Comparison.tsx`
**Backend touchpoints:**
- `GET /api/v/{v}/comparison/topn` → `backend/internal/api/comparison_topn.go` → `backend/internal/queries/comparison/topn.sql`
- `GET /api/v/{v}/comparison/dto` → `backend/internal/api/comparison_dto.go` → `backend/internal/queries/comparison/dto.sql`
- `GET /api/v/{v}/regulators/resolve` → used by `FilterChips` from the Comparison route (cosmetic; result is written to URL but not consumed by either plot today)
- `GET /api/v/{v}/datasets` → indirect, via Select page (drives the `binding=` / `perturbation=` URL params)

## 1. Summary

The Shiny Comparison module renders exactly one visualization — a faceted Plotly **boxplot with jittered points** of `% responsive in top-N` across every active (binding, perturbation) pair, configured by four sidebar controls (`top_n`, `effect_threshold`, `pvalue_threshold`, `facet_by`). The React route renders a fundamentally different plot — a **regulator × pairKey heatmap** of `responsive_ratio` — and exposes none of the four controls except via raw URL query string. It also adds a second tab ("DTO") that displays a tabular dump of `dto_expanded` rows, a view that **does not exist in Shiny** (the `fetch_dto_data` query is defined in `queries.py` but never called by the workspace; the endpoint is new product surface, not parity surface). The backend endpoints are otherwise correct and parity-compliant: the topn UNION-ALL shape, the harbison dedup CTE, the calling-cards target blacklist, the hackett `time=45` filter, and the dynamic `responsive_expr` all match the Python reference. Plot type, controls, color palette, axis units, facetting, and hover are all P0 gaps. The DTO tab is a P2 extra rather than a regression.

## 2. Feature matrix

| # | Feature (what user sees/does) | Shiny behavior (file:line) | React status | Gap | Severity |
|---|------------------------------|-----------------------------|---------------|------|----------|
| 1 | Workspace header "Top N by Binding" | `ui.py:31-35` | Replaced by `<Tabs>` with "Top-N" / "DTO" triggers | Header label and section semantics changed | P2 |
| 2 | Primary visualization: faceted boxplot with jittered points (one box per `x_col` value within each facet panel) | `server/workspace.py:221-323` | Renders a 2-D heatmap (`ComparisonHeatmap.tsx:33-57`) | Wrong plot type — heatmap shows regulator-level cells, not per-binding-sample distributions | **P0** |
| 3 | Y-axis: `% responsive in top N`, fixed range `[0, 100]` | `workspace.py:316-318` | Heatmap color encodes `responsiveRatio` (0–1 fraction, Viridis scale) | Unit (% vs ratio), encoding (color vs y-position), and fixed scale all missing | **P0** |
| 4 | One subplot per facet value, `shared_yaxes=True`, subplot titles = facet labels | `workspace.py:273-278` | Single heatmap; no subplots | Facetting absent | **P0** |
| 5 | `facet_by` radio control: `"binding"` (binding=facets, perturbation=color) vs `"perturbation"` (perturbation=facets, binding=color) | `server/sidebar.py:91-105`, `workspace.py:242-262` | Not implemented — no control, no toggle | Whole control + axis-swap logic missing | **P0** |
| 6 | `top_n` numeric input (default 25, min 1, max 500, step 5) | `sidebar.py:131-138` | Only via raw URL `?top_n=` (`Comparison.tsx:17`); no UI control | Sidebar control missing | **P0** |
| 7 | `effect_threshold` slider (`0.0`–`5.0`, step `0.1`, default `0.0`) | `sidebar.py:140-147` | Only via raw URL `?effect=`; no UI control | Sidebar control missing | **P0** |
| 8 | `pvalue_threshold` slider (`0.001`–`1.0`, step `0.001`, default `0.05`) | `sidebar.py:148-155` | Only via raw URL `?pvalue=`; no UI control | Sidebar control missing | **P0** |
| 9 | Empty state when no binding OR no perturbation selected | `sidebar.py:111-119`, `workspace.py:236-240` | Yes (`Comparison.tsx:62-67`) — text differs but semantics match | OK | — |
| 10 | Per-point hover: `regulator_label` line then `%y:.1f%` line | `workspace.py:307-308` | Heatmap default tooltip (`hoverongaps:false`); shows regulator/pair/value but not the Shiny-style label | Hover content/format different | P1 |
| 11 | Color palette — binding (4 hex codes) + perturbation (6 hex codes) per dataset label | `workspace.py:30-44` | Viridis colorscale on heatmap; no per-source color | Palette + mapping missing | P1 |
| 12 | Legend grouped by `x_col`, single legend across subplots (`legendgroup=x_val`, `showlegend=(col_idx==1)`) | `workspace.py:304-305, 319-322` | No legend (heatmap colorbar instead) | Legend semantics missing | P1 |
| 13 | Facet / x-axis order from `_BINDING_ORDER` / `_PERT_ORDER` constants (chronological) | `workspace.py:46-60`, `workspace.py:245-264` | Heatmap sorts by `pairKey` lexicographically (`ComparisonHeatmap.tsx:12-13`) | Ordering rules missing | P1 |
| 14 | Display labels: `BINDING_LABEL_MAP` / `PERTURBATION_LABEL_MAP` (e.g. `callingcards` → "2026 Calling Cards") | `queries.py:339-353`, `workspace.py:119-134` | Raw `db_name` rendered (heatmap x is `binding__perturbation` pair key, y is locus tag) | Human-readable labels missing | P1 |
| 15 | Regulator display name on hover (`get_regulator_display_name` joined into rows) | `workspace.py:159-212` | Heatmap shows raw `regulatorLocusTag` from API response | Display name lookup absent | P1 |
| 16 | Dataset filters: `dataset_filters` reactive `Value` injected into both binding and perturbation CTEs (per-dataset filter spec, see `queries.py:111-138`) | `workspace.py:152, 187` | URL has `?filters=` passthrough (`Comparison.tsx:20, 34`); UI to edit filters lives on other pages, not Comparison | Filters honored by backend; no UI on Comparison to author/edit them | P1 |
| 17 | Hackett perturbation: `perturbation_filters` deliberately set to `None` when `hackett_time_filter=True` (filters dropped for hackett to avoid double-restriction) | `queries.py:432` | Same logic in `comparison_topn.go:283-286` — pertJoin added; user filters still applied to hackett (see Gap row in §7) | Subtle parity divergence: backend always passes `filters[pDB]`, Python skips them for hackett | P1 |
| 18 | "DTO" tab — table of `dto_expanded` rows (4 columns: binding source, pert source, dto_empirical_pvalue, dto_fdr) | NOT in Shiny — only `fetch_dto_data` exists in `queries.py:69-88`, never wired to a `render.ui` | New in React (`Comparison.tsx:77-86`, `DTOPlot.tsx`) | Extra feature, not a regression. The Shiny DTO query result was likely meant for a `-log10(pvalue)` plot or volcano (suggested by `DTO_LOG_PSEUDO=1e-3` constant at `queries.py:21`) but never built. | P2 |
| 19 | DTO presentation per Shiny intent: pseudo-`log10` transformation hinted by `DTO_LOG_PSEUDO` and the multi-table join (binding/pert set sizes are returned but unused) | `queries.py:21, 36-66` | React renders bare `toExponential(2)` strings in a `<Table>`; no plot, no log transform, no set-size badges | If a plot was intended, it was never specified in Shiny; React choice of "table" is plausible but does not exercise the columns | P2 |
| 20 | `FilterChips` at top of Comparison route | NOT in Shiny | `Comparison.tsx:46-54` — calls `/regulators/resolve` with `common=A:B` to compute regulator intersections, writes top-30 tags to URL `?regulators=...` | New control; result is never read back by either tab (dead writes) | P1 |
| 21 | URL state for sidebar params (`top_n`, `effect_threshold`, `pvalue_threshold`, `facet_by`) | NOT in Shiny (Shiny is single-session, in-memory inputs) | `top_n`, `effect`, `pvalue` only via URL on the React side; `facet_by` absent altogether | Half-built — defaults read from URL but no writes back when (missing) controls change | P1 |
| 22 | Per-dataset palette lookup: "no binding/perturbation config" datasets logged and skipped | `workspace.py:172-181` | `comparison_topn.go:86-97` returns **400** if a dataset lacks a config | Different behavior — Python silently drops, Go rejects whole request. Either is defensible; the React UI does not surface the 400 well. | P2 |
| 23 | Tab switching preserves Shiny's `req(active_module() == "comparison")` blocker | `workspace.py:116-117` | React: `useQuery` only `enabled` when both lists populated; both topn + dto fire on mount | Less aggressive blocking; DTO query fires even if user never opens that tab (it is currently unconditional) | P2 |
| 24 | Downloads (CSV/PNG export) | NONE in Shiny workspace | NONE in React | Match — none expected | — |
| 25 | Error display | Shiny renders empty state if `topn_all_pairs_sql` raises (`workspace.py:188-190`) | React shows raw error message inline (`Comparison.tsx:68-70, 79-81`) | Behavior different but acceptable | P2 |

## 3. Controls (every input/selector/threshold/toggle, including which datasets to compare)

| Control | Shiny | React | Notes |
|---|---|---|---|
| Active binding datasets | Pulled from cross-module `active_binding_datasets` reactive (set on Select Datasets page) | Read from URL `?binding=` CSV (`Comparison.tsx:15`) | Backend accepts both `binding` and `perturbation` as CSV. |
| Active perturbation datasets | Pulled from cross-module `active_perturbation_datasets` | Read from URL `?perturbation=` CSV (`Comparison.tsx:16`) | Same. |
| `top_n` | `input_numeric("top_n", value=25, min=1, max=500, step=5)` (`sidebar.py:131-138`) | URL `?top_n=` only; default 25 (`Comparison.tsx:17`) | **No UI control.** Backend clamps via `clampTopN(...)`. |
| `effect_threshold` | `input_slider("effect_threshold", min=0.0, max=5.0, value=0.0, step=0.1)` (`sidebar.py:140-147`) | URL `?effect=` only; default 0.0 (`Comparison.tsx:18`) | **No UI control.** |
| `pvalue_threshold` | `input_slider("pvalue_threshold", min=0.001, max=1.0, value=0.05, step=0.001)` (`sidebar.py:148-155`) | URL `?pvalue=` only; default 0.05 (`Comparison.tsx:19`) | **No UI control.** |
| `facet_by` | `input_radio_buttons("facet_by", choices={"binding": "Binding source", "perturbation": "Perturbation source"}, selected="binding")` (`sidebar.py:157-165`) | **Not present at all.** | Completely missing on React. |
| Filters | `dataset_filters: reactive.Value[dict]` populated by other modules (Binding/Perturbation views) | URL `?filters=` passthrough only (`Comparison.tsx:20`) | Backend parses + applies. No author-on-this-page UI either side. |
| `FilterChips` "common A ∩ B" selector | Not present | `Comparison.tsx:46-54` + `FilterChips.tsx` | Extra; calls `/regulators/resolve`; result written to URL but not consumed by either plot. |
| Tab selector (Top-N vs DTO) | Not present (single section) | `Tabs` component, default `"topn"` | Extra; DTO query unconditional on mount. |

## 4. Plots (every plot type, with axes/colors/tooltips/legend detail)

### 4.1 Shiny — Top-N boxplot (the canonical view)

Implementation: `server/workspace.py:221-323`.

- Library: `plotly.subplots.make_subplots` + `plotly.graph_objects.Box` (`workspace.py:11-14, 273, 294`).
- Layout: 1 row × N cols where N = count of active facet values (`workspace.py:273-278`).
- `shared_yaxes=True`, subplot titles = facet labels list.
- Trace per (facet, x_val): one `go.Box` with
  - `y = grp["percent_responsive"].dropna()` (DataFrame is `responsive_ratio*100`, `workspace.py:218`)
  - `name = x_val`
  - `marker_color = palette[x_val]` (fallback `#888888`)
  - `boxpoints = "all"`, `jitter = 0.4`, `pointpos = 0`
  - `marker = dict(size=4, opacity=0.5)`, `line = dict(width=1.2)`
  - `legendgroup = x_val`, `showlegend = (col_idx == 1)`
  - `hoveron = "points"` (box body has no tooltip)
  - `text = reg_labels_col.values`
  - `hovertemplate = "%{text}<br>%{y:.1f}%<extra></extra>"`
- X-axis per subplot: `showticklabels=False` (because the color/legend already encodes the same dimension).
- Y-axis col 1: `title="% responsive in top N"`, `range=[0, 100]`.
- Layout: `legend_title = "Perturbation source"` or `"Binding source"` depending on facet_by, `margin = dict(l=50, r=20, t=80, b=30)`.
- Palette constants:
  - Binding: `2004 ChIP-chip=#E64B35, 2021 ChIPexo=#F39B7F, 2025 Chec-seq=#00A087, 2026 Calling Cards=#3C5488` (`workspace.py:30-35`).
  - Perturbation: `2006 Overexpression=#F39B7F, 2006 TFKO=#00A087, 2007 TFKO=#8491B4, 2014 TFKO=#4DBBD5, 2020 Overexpression=#91D1C2, 2025 Degron=#B09C85` (`workspace.py:37-44`).
- Ordering arrays:
  - `_BINDING_ORDER = ["2004 ChIP-chip","2021 ChIPexo","2025 Chec-seq","2026 Calling Cards"]` (`workspace.py:55-60`).
  - `_PERT_ORDER = ["2006 Overexpression","2006 TFKO","2007 TFKO","2014 TFKO","2020 Overexpression","2025 Degron"]` (`workspace.py:46-53`).

### 4.2 React — ComparisonHeatmap (current Top-N tab)

Implementation: `frontend/src/plots/ComparisonHeatmap.tsx:1-58`.

- Library: lazy-loaded Plotly via `PlotLazy` (`plots/PlotLazy.tsx`).
- Single `type: "heatmap"` trace.
- `x = pairKeys` (sorted lexicographically — e.g. `callingcards__hackett`).
- `y = regs` = unique `regulatorLocusTag` sorted lexicographically.
- `z[i][j] = responsiveRatio` (0–1) for regulator i, pair j, else `null`.
- `colorscale: "Viridis"`, `hoverongaps: false`.
- Layout: `height = max(400, regs.length*18 + 100)`, `margin: { l: 100, t: 40 }`, axis titles `"binding__perturbation pair"` and `"regulator"`.
- No subplots, no legend, no per-source color, no facet swap, no jitter, no per-sample distribution — fundamentally a different aggregation (per regulator instead of per binding sample).

### 4.3 React — DTO tab

Implementation: `frontend/src/plots/DTOPlot.tsx:1-39`.

- Type: `<Table>` (HTML table, no plot).
- Columns: Binding ID, Pert ID, DTO empirical pvalue, DTO FDR.
- Values formatted with `toExponential(2)`.
- Discards 5 of 9 columns the backend returns (`bindingSetSize`, `perturbationSetSize`, `bindingSampleId`, `pertSampleId`, `time`).
- No Shiny equivalent — Shiny only has a query function for these rows, never a render.

## 5. Tables / downloads

- **Shiny:** no tables; no `download_button`s; no CSV/PNG export wired anywhere in `modules/comparison/`.
- **React:** the DTO tab is rendered as an HTML table (not a Plotly table), no download button. Top-N tab is plot-only.

No parity gap on downloads — neither side has them. If a download is desired, this is fresh product surface, not parity.

## 6. Interactions

| Interaction | Shiny | React |
|---|---|---|
| Change `top_n` → plot updates | Yes, via `@reactive.calc _topn_data` (`workspace.py:136-219`). Stable `_query_params` reactive prevents echo double-runs (`workspace.py:85-103`). | Triggered only if user edits URL. **No control.** |
| Change `effect_threshold` → plot updates | Yes. | URL-only. |
| Change `pvalue_threshold` → plot updates | Yes. | URL-only. |
| Toggle `facet_by` → axes swap (color encodes other dimension) | Yes — re-renders without re-running SQL (`workspace.py:233-323` consumes the cached DataFrame). | **Not implemented.** |
| Change active binding/perturbation datasets on Select page → Comparison plot updates | Yes via cross-module reactive. | Yes — URL `?binding=`/`?perturbation=` shared across routes. |
| Apply per-dataset filters elsewhere → Comparison query re-runs | Yes — `dataset_filters` reactive dependency. | Yes — `?filters=` propagated; no Comparison-local UI to author them. |
| Tooltip on box points | Regulator display name then `y:.1f%`. | Heatmap default `x/y/z` tooltip. |
| Tab switching for DTO | n/a | `Tabs` (state `tab` local, **not** persisted to URL). |
| Cache coalescing | Shiny: in-process `@reactive.calc`. | Backend: ristretto + singleflight, key includes `artifactVersion|binding|perturbation|top_n|effect|pvalue|filters` (`comparison_topn.go:130-149`). |

## 7. Data flow

**Shiny queries:**

- `topn_all_pairs_sql(vdb, pairs, filters, top_n, effect, pvalue)` (`queries.py:396-456`) builds a `UNION ALL` of per-pair subqueries from `topn_responsive_ratio(...)` (`queries.py:183-332`). One CTE chain per pair: `binding` → `binding_ranked` (RANK partitioned by `binding_sample_id`) → `top_n_binding` → `perturbation` → final `GROUP BY binding_sample_id, regulator_locus_tag, perturbation_sample_id`. Columns returned: `binding_sample_id, regulator_locus_tag, perturbation_sample_id, n, n_responsive, responsive_ratio, pair_key`.
- `_HARBISON_DEDUP_CTE` (`queries.py:95-104`) is substituted for harbison's binding CTE: `MIN(pvalue)` per `(sample_id, regulator_locus_tag, target_locus_tag)` under `condition = 'YPD'`.
- Calling-cards target blacklist: `CC_TARGET_BLACKLIST = ("YOR201C","YOR202W","YOR203W","YCL018W","YEL021W")` applied as `target_locus_tag NOT IN (...)` (`queries.py:18, 242-248`).
- Hackett perturbation join: `JOIN hackett_analysis_set has ON ... AND has.time = 45` when `hackett_time_filter=True` (`queries.py:274-279`).
- `_responsive_expr`: per-dataset case expression using `DATASET_COLUMNS` from `perturbation/queries.py:15-22`; fallback to `CAST(p.responsive AS INTEGER)` when neither effect nor pvalue column exists (`queries.py:141-180`).
- `get_regulator_display_name(vdb)` is joined into the result for tooltip labels (`workspace.py:159-212`).
- `fetch_dto_data(vdb)` (`queries.py:69-88`) — DEFINED BUT NEVER CALLED. The DTO query exists in code; no Shiny module wires it into any `render.ui` / `render.plot`.

**React API calls:**

- Top-N tab: `api.topn({ binding, perturbation, top_n, effect, pvalue, filters? })` → `GET /api/v/{v}/comparison/topn?...` (`api/client.ts:114-131`). Enabled only when both CSVs are non-empty (`Comparison.tsx:36`).
- DTO tab: `api.dto()` → `GET /api/v/{v}/comparison/dto` (`api/client.ts:132`). **Unconditional** — fires on every mount of the Comparison route regardless of the active tab.
- `FilterChips` calls `api.resolve({ common })` → `GET /api/v/{v}/regulators/resolve?common=A:B` (`api/client.ts:85-95`, `FilterChips.tsx:13-17`); result written to URL `?regulators=` but never read back by the topn or dto handlers.

**Mismatches:**

1. **Shape mismatch — heatmap collapses per-sample rows into per-regulator cells.** Backend returns one row per `(binding_sample_id, regulator_locus_tag, perturbation_sample_id)`. The Shiny plot keeps one point per row (jittered into a box). The React heatmap drops `binding_sample_id` and `perturbation_sample_id` from the key, which causes silent overwrites when multiple binding samples target the same regulator: `cells.set(\`${reg}|${pk}\`, r.responsiveRatio)` (`ComparisonHeatmap.tsx:16-19`) — the *last* row wins. **This is a correctness bug, not a styling issue.**
2. **Hackett filters dropped on Python side, not on Go side.** `topn_all_pairs_sql` passes `None` for `perturbation_filters` whenever `pcfg["hackett_time_filter"]` is true (`queries.py:432`). The Go backend always passes `filters[pDB]` unconditionally (`comparison_topn.go:271`). Output divergence is silent and only triggers when a user has hackett-scoped filters set.
3. **Percent vs ratio.** Shiny multiplies by 100 (`workspace.py:218`); backend returns the raw fraction (0–1) in `responseRatio`. React heatmap displays the raw fraction; if/when the boxplot is built, it must convert. Documentation should say either side is fine as long as axis labels match.
4. **Regulator display name lookup.** Shiny issues a `get_regulator_display_name(vdb)` query and merges; the Go backend topn endpoint does **not** return a display name — only `regulatorLocusTag`. To match Shiny, React would need to call `/api/v/{v}/regulators` (or new `/regulators/by-tag`) and join client-side.
5. **DTO endpoint reads columns that are unused on both sides** (`bindingSetSize`, `perturbationSetSize`, `bindingSampleId`, `pertSampleId`, `time`). They're paid for in payload size and not yet rendered.

## 8. URL state / deep linking

| Param | Shiny | React | Notes |
|---|---|---|---|
| `binding`, `perturbation` (CSV of `db_name`) | n/a (Shiny is session-scoped) | Yes — read in Comparison and Select | Cross-route URL state works. |
| `top_n` | n/a | Read (`Comparison.tsx:17`); never written | One-way; defaults to 25. |
| `effect` | n/a | Read; never written | One-way; defaults to 0. |
| `pvalue` | n/a | Read; never written | One-way; defaults to 0.05. |
| `filters` | n/a | Read; never written from this route | One-way. |
| `facet_by` | n/a | **Not used in URL** | Will need a new query key when control is added. |
| `regulators` | n/a | Written by `FilterChips` (top-30 tags) | Never read back on this route. |
| Active tab (topn/dto) | n/a | **Local state only** (`useState`) | Not deep-linkable. Refreshing the page always returns to "topn". |

## 9. Backend gaps blocking parity

The backend is largely sufficient. Specifically:

- `/comparison/topn` already returns enough columns to reconstruct the Shiny boxplot (`binding_sample_id`, `regulator_locus_tag`, `perturbation_sample_id`, `responsive_ratio`, `pair_key`). The frontend just needs to use them.
- `/comparison/topn` does **not** return a regulator display name. The Shiny tooltip uses `get_regulator_display_name`. Options:
  - (cheap) frontend joins against a cached `/api/v/{v}/regulators` list.
  - (parity-clean) backend adds `regulator_display_name` to `TopNRow` (single LEFT JOIN against `regulator_display_names`).
- Hackett-filter parity (item 2 in §7) requires a small Go change: skip `filters[pDB]` whenever `pcfg.HackettTimeFilter` is true (mirroring `queries.py:432`). One-line patch.
- `/comparison/dto` returns 9 columns; only 4 are used. Either ship a slim variant or let it ride (it's cacheable and small).
- `binding`/`perturbation` payload caps: handler already does `dedupeAndCapCSV`. No change needed.
- No `dataset_manifest`/`field_manifest` change required — comparison columns are already whitelisted at `comparison_topn.go:121-128`.

In short: **one trivial backend tweak (hackett filter skip) is the only true parity blocker; everything else is frontend.**

## 10. Open questions

1. Was the DTO query ever meant to render as a `-log10(empirical_pvalue)` plot (constant `DTO_LOG_PSEUDO=1e-3` strongly suggests this) or as a results table? Confirm with @BrentLab before treating the React table as the final design.
2. Should the new Comparison sidebar use the same URL-as-state pattern as Binding/Perturbation, or local React state? CLAUDE.md says "URL + Zustand on the frontend"; the current Comparison route partly honors this for the three numeric thresholds but uses `useState` for tab and never writes `facet_by`. Consensus needed before building.
3. Boxplot per-pair density may be high (`N binding_samples × 1 box per (facet, x)`). Confirm whether jittered points should remain at the Shiny default or be downsampled when a single pair returns >1k samples.
4. The `FilterChips` "common A ∩ B" affordance on this route does not affect the rendered plot. Is it intended to scope topn to a regulator subset? If so, a backend `?regulators=` filter on `/comparison/topn` would need to be added, then wired into the cache key.
5. Should `bindingSetSize`/`perturbationSetSize` from `/comparison/dto` be displayed (e.g. as badge columns or a tooltip)? They are computed and shipped but currently dropped on the floor.
6. Calling-cards target blacklist (`CC_TARGET_BLACKLIST`) is hard-coded in both Python and Go. Should this be data-driven via `dataset_manifest` per the Phase 1.6 note in `CLAUDE.md`? Out of scope for parity, but worth flagging.
