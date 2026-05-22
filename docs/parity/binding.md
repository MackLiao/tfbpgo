# Binding Module — Parity Inventory

**Generated:** 2026-05-21
**Shiny source:** `reference/tfbpshiny/modules/binding/`
**React target:** `frontend/src/routes/Binding.tsx`
**Backend touchpoints:**
- `GET /api/v/{v}/binding?regulator=...&datasets=...&filters=...` — only call used by the React route (`backend/internal/api/binding.go:28-94`, SQL `backend/internal/queries/binding/data.sql:1-13`)
- `GET /api/v/{v}/regulators?search=...&limit=...` — used by `RegulatorPicker` (`backend/internal/api/regulators.go`, SQL `backend/internal/queries/regulators/search.sql`)
- (Shiny-side only, no Go endpoint) per-regulator dataset-pair correlation (`reference/tfbpshiny/modules/binding/queries.py:331-390` — `corr_all_pairs_sql`)
- (Shiny-side only, no Go endpoint) per-regulator scatter join across two datasets (`queries.py:393-477` — `regulator_scatter_sql`); the existing `backend/internal/queries/binding/{corr_pair,regulator_scatter}.sql` files are still placeholder stubs (`-- placeholder; populated in later tasks`).
- (Shiny-side only) `*_meta` lookup for per-sample condition labels (`reference/tfbpshiny/utils/sample_conditions.py:55-94`).

## 1. Summary

The React `/binding` route is a **skeleton implementation, not a port**. It draws a single scatter plot where X is `target_locus_tag` and Y is the raw measurement value — that is not what the Shiny Binding page shows. The Shiny page is a **two-tier correlation analyser**: (1) a top **box-plot of per-regulator Pearson/Spearman correlations** between every pair of selected binding datasets, with the currently-selected regulator highlighted as a large black dot per box; (2) a row of **N choose 2 per-pair scatter plots** showing the joined per-target effect/p-value values for the currently-selected regulator only, each annotated with its `r` value. Almost none of that exists yet: there is no Pearson/Spearman switch, no Effect/P-value switch, no pairwise distribution box plot, no per-pair scatter row, no `r` annotation, no click-from-box-to-regulator interaction, no condition-aware hover, no "regulator not found in dataset X" warning, and the backend has no `/binding/corr` or `/binding/scatter` endpoint — only a raw single-dataset `WHERE regulator_locus_tag = ?` data dump. Overall: ~10% of the surface, ~0% of the differentiating analytical features. Backend work is required (two new endpoints or a single combined one) before parity is achievable.

## 2. Feature matrix

| # | Feature (what user sees/does) | Shiny behavior (file:line) | React status | Gap | Severity |
|---|------------------------------|-----------------------------|---------------|------|----------|
| 1 | Sidebar **Column** radio: Effect / P-value | `reference/tfbpshiny/modules/binding/server/sidebar.py:91-98` (`input_radio_buttons("col_preference", choices={effect,pvalue}, selected="effect", inline=True)`) | MISSING | No control rendered. `frontend/src/routes/Binding.tsx:31-51` only renders a `RegulatorPicker`. | P0 |
| 2 | Sidebar **Correlation** radio: Pearson / Spearman | `sidebar.py:99-106` | MISSING | No control. | P0 |
| 3 | Default Column = `effect`, default Correlation = `pearson` | `sidebar.py:53,70`; reset to defaults when input not yet rendered | MISSING | N/A — controls don't exist. | P0 |
| 4 | Active datasets come from upstream `active_binding_datasets` (selected on Select page) | `binding/server/workspace.py:30,82-100` consumes the reactive; sorted, combinations of 2 form `_active_pairs` | PARTIAL | React reads `?binding=<csv>` from URL (`Binding.tsx:15`) — same upstream selection model, good. But never forms pairs (it sends the full list to a per-dataset endpoint). | P0 |
| 5 | Dataset filters (set elsewhere) participate in correlation/scatter SQL | `workspace.py:33,167,533` — `dataset_filters()` dict keyed by db_name, with per-field `{type, value}` specs (categorical / numeric / bool) | PARTIAL | React reads `?filters=` and passes raw to API (`Binding.tsx:16,21`). Backend parses + validates (`binding.go:52-69`, `parseFilters`) — matches Shiny's three filter kinds (`binding.go:191-195`). But because only the data-dump endpoint is wired, filters never reach `corr_pair`/`regulator_scatter` (those endpoints don't exist). | P1 |
| 6 | **Distributions box plot**: one box per dataset pair, jittered points = per-regulator r values | `workspace.py:218-364` (`distributions_plot`). `go.Box(x=all_x, y=all_y, boxpoints="all", jitter=0.4, pointpos=0, marker=size 4 opacity 0.5)`. X categorical labels `"<dataset A><br>vs<br><dataset B>"`. Y axis labelled `"{Pearson|Spearman} r"`. Title `"{Pearson|Spearman} correlation across regulators"`. | MISSING | No box plot anywhere. `BindingScatter.tsx` draws a scatter (`type:"scatter"|"scattergl"`), not a box. | P0 |
| 7 | Box-plot **selected-regulator overlay**: large black dot drawn on top of the jitter for the currently-selected regulator, one per box | `workspace.py:326-338` — second `go.Scatter` trace `marker=dict(size=10, color="black", symbol="circle")`. Custom multi-line hover including gene symbol, `r = X.XXX`, and the per-dataset condition label (`label_a + ": " + cond_label`) when present, HTML-escaped before joining with `<br>`. | MISSING | No overlay. | P0 |
| 8 | Box-plot **click-to-set-regulator**: clicking any dot writes `customdata` (locus tag) into `input.selected_regulator` via a `post_script` Plotly handler | `workspace.py:346-364` — injects JS `Shiny.setInputValue('selected_regulator', pt.customdata, {priority:'event'})` | MISSING | No click handler on any plot. Regulator can only be set via the search box. Removes the primary cross-plot navigation pattern. | P0 |
| 9 | Box-plot empty state: "Select at least two binding datasets to see correlations." | `workspace.py:236-245` — figure annotation centered (paper coords 0.5, 0.5) | PARTIAL | React shows a paragraph `"Pick a regulator on the left and select one or more binding datasets…"` (`Binding.tsx:42-46`) — but only when `!datasets.length`, and the **threshold differs**: Shiny needs ≥ 2 datasets (a pair); React accepts 1. Wording diverges. | P1 |
| 10 | Regulator selectize dropdown labelled `"Regulator"`, choices = union of regulators present in any pair's correlation data, displayed by gene symbol with fallback to locus tag, sorted case-insensitively | `workspace.py:366-407` (`regulator_selector` — `ui.input_selectize` with `choices = {locus: sym}` sorted by symbol lower). Selected value persists across re-renders when still present. | DONE | Closed in Phase C — commit `3e4b80a`. `ActivePairRegulatorPicker` narrows the regulator selectize to regulators present in the `/binding/corr` response (native `<select>` under 50 options, typeahead above), and falls back to the global RegulatorPicker before corrQuery resolves. | — |
| 11 | Search-by-symbol or locus tag inside the selectize | Shiny `input_selectize` provides built-in fuzzy search over `choices` | DONE (different UI) | React `RegulatorPicker` query-by-string against the backend instead of client-side fuzzy. Functionally good enough; differs in being server-backed. | — |
| 12 | "Regulator not found" warning: gray paragraph listing dataset display-names where the selected regulator yielded no correlation row, e.g. `"YBR289W was not found in: Calling Cards, Harbison. Pairs involving these datasets are omitted."` | `workspace.py:451-491` (`scatter_missing_note`). Computed as `failed - succeeded` so a dataset present in any successful pair is excluded. | MISSING | No equivalent. User has no signal when their selection produces empty plots. | P1 |
| 13 | **Per-pair scatter row**: one Plotly figure per active `(db_a, db_b)` pair, side-by-side flex layout, fixed 400×400 px, gap 1rem | `workspace.py:423-449` (`scatter_container`); each scatter rendered by its own `@render.ui` so pairs resolve independently (`_make_scatter_render` at `:493-610`) | MISSING | React only ever shows one `BindingScatter` with one trace per dataset — not one *plot per pair* of datasets. | P0 |
| 14 | Per-pair scatter axes: X = `display_name(db_a): {col_a}`, Y = `display_name(db_b): {col_b}` (e.g. `"Calling Cards: callingcards_enrichment"`); title = two-line `{label_a}<br>vs<br>{label_b}` centered | `workspace.py:596-603` | MISSING | React scatter X-axis hides ticks (`xaxis: { showticklabels: false }`), no titles, no per-axis labels (`BindingScatter.tsx:21-25`). | P0 |
| 15 | Per-pair scatter markers: size 4, opacity 0.6, color `#4A90D9`; hover shows `"<dataset A>: %{x:.3f}<br><dataset B>: %{y:.3f}"` (no tag — target is shown via `text`) | `workspace.py:572-584` | MISSING | React passes raw `targetLocusTag` as X data and `sampleId` as `hovertext`; no marker styling; no hover template. | P0 |
| 16 | Per-pair scatter **`r=N.NNN` annotation in top-right** (`xanchor=right yanchor=top` at paper 0.98,0.98) | `workspace.py:585-595` (computed in Python: `merged["_val_a"].corr(merged["_val_b"])`) | MISSING | No correlation annotation anywhere. | P0 |
| 17 | Spearman vs Pearson handling for scatter: Spearman uses RANK of `val_a` (`ABS(val_a) DESC` for effect, `val_a ASC` for p-value) and RANK of `val_b`, then plots ranks; Pearson uses raw values | `workspace.py:452-475` + `queries.py:393-477` (`regulator_scatter_sql`) | MISSING | No correlation method awareness. Backend has no path that returns the joined `(target, _val_a, _val_b)` rows for a single regulator. | P0 |
| 18 | Correlation method for box-plot data: Pearson uses `corr(a.val, b.val)`; Spearman ranks within `(regulator, sample_a, sample_b)` partitions; effect cols ranked by `ABS DESC`, p-value cols by `ASC` (smaller = better); `HAVING COUNT(*) >= 3` floor; INNER JOIN keeps only shared targets; NULL / `isinf` / `isnan` filtered out (DuckDB `corr` raises on non-finite) | `queries.py:122-294` (`_corr_pair_sql_impl`); UNION-ALL all pairs in one query `:331-390` (`corr_all_pairs_sql`) — single round-trip optimisation | MISSING | No correlation endpoint in Go. The placeholder SQLs `backend/internal/queries/binding/corr_pair.sql:1` and `regulator_scatter.sql:1` literally contain `-- placeholder; populated in later tasks`. The whole numerical-parity contract for the binding page is unwritten. | P0 |
| 19 | Distinct sample-id handling: when a regulator has multiple samples per dataset, each `(regulator, db_a_id, db_b_id)` combination produces a separate row → potentially multiple dots per regulator per box | `queries.py:268-288, 254-256`; comment in `workspace.py:142-145` | MISSING | The single data-dump endpoint returns rows but never aggregates to correlation; sample-id semantics for the box plot do not exist client-side. | P0 |
| 20 | **Measurement column resolution per dataset** (`DATASET_COLUMNS`): callingcards→(`callingcards_enrichment`,`poisson_pval`); harbison→(`effect`,`pvalue`); rossi→(`enrichment`,`poisson_pval`); chec_m2025→(`enrichment`,`poisson_pval`); p-value falls back to effect if absent | `queries.py:18-53` (`DATASET_COLUMNS`, `get_measurement_column`) | PARTIAL | Backend mirrors the map (`binding.go:21-26`) but **only for the effect column** — p-value column is never looked up. Endpoint cannot honour an Effect/P-value toggle. CLAUDE.md flags this as Phase 1.6 follow-up ("Hard-coded measurement column maps … still need to move to `dataset_manifest`"). | P0 |
| 21 | Sample-condition label map per dataset, used to build per-dot hover text on selected-overlay | `workspace.py:103-129`, `utils/sample_conditions.py:55-94` (`fetch_sample_condition_map` queries `{db_name}_meta` for the condition columns specified in `AppDatasets.condition_cols`; join values with `" / "`; drop empty/NaN) | DONE | Closed in Phase C — commit `3e4b80a`. New `GET /api/v/{v}/datasets/{db}/sample-conditions` builds the `{sample_id: condition_label}` map from `dataset_manifest.condition_cols` (schema v4); frontend consumes it in `BindingCorrBoxplot` overlay hover. | — |
| 22 | XSS hardening: every DB-sourced string (display name, condition label, gene symbol) is HTML-escaped before being interpolated into Plotly hovertext (Plotly renders hovertext as HTML) | `workspace.py:294-306` uses `html.escape(...)` | UNKNOWN | React uses Plotly's `text`/`hovertext` arrays, which are passed as strings to Plotly. **Plotly renders `hovertext` as HTML by default**, so any DB-sourced string with `<…>` is a stored-XSS sink. Current React passes raw `targetLocusTag` (safe) and `sampleId` (mostly safe), but the moment condition labels or display names are added, parity requires escaping. Flag for any future hover changes. | P1 |
| 23 | Active dataset pair list is sorted: `itertools.combinations(sorted(active), 2)` — stable ordering for cache and UI | `workspace.py:97` | MISSING | React never forms pairs; backend dedupes datasets but does not enforce sort order beyond cache canonicalisation (`binding.go:74-86`). When the pair endpoint lands, ordering must match. | P1 |
| 24 | Stable scatter slot DOM: one slot per ALL-possible pair, slot hidden via `ui.span()` when pair is inactive — minimises layout shift when toggling datasets | `workspace.py:412-449,493-610` (all pairs pre-registered) | N/A in current React | Document for when pair plots land. | P2 |
| 25 | Performance: combined UNION-ALL pair query in `_all_corr_data`, single VirtualDB round-trip | `queries.py:331-390` | MISSING | Backend has no pair endpoint at all; when implemented, parity expects this UNION-ALL shape. | P1 |
| 26 | Re-render minimisation: stable `reactive.value`s for `_corr_params`, `_active_pairs`, `_cond_maps_val` so input echo on tab switch doesn't double-fire `_all_corr_data` | `workspace.py:48-129` | DONE (different mechanism) | TanStack Query keys (`lib/query-keys.ts:13`) + URL state achieve the same — no double-fire concern. — | — |
| 27 | Cache: per-request cache key includes `artifactVersion` and canonicalises `datasets` order and `filters` JSON | `backend/internal/api/binding.go:74-87` (`canonValues`) | DONE | Solid; key shape per CLAUDE.md "Cache key shape". When pair endpoint is added, follow same pattern. | — |
| 28 | URL deep-link: `/binding?regulator=YBR289W&binding=callingcards,harbison&filters={...}` | URL state is the React design model | DONE | `Binding.tsx:11-16` reads `regulator`, `binding`, `filters` from `useSearchParams`; updates regulator via `setParams` (`:25-29`). Strict improvement over Shiny (which had no deep link on this page). | — |
| 29 | URL keys are data-type scoped (`?binding=`, `?perturbation=`, shared `?regulator=`) so a single URL covers both routes | inferred from comment in `Binding.tsx:13-14` | DONE | — | — |
| 30 | URL-driven correlation method / column preference (so Pearson-Spearman switch is deep-linkable) | Not in Shiny (sidebar state is in-memory only — Shiny refresh resets to defaults) | MISSING / opportunity | When method+col controls are added in React, they SHOULD be URL-encoded (e.g. `?corr=spearman&col=pvalue`) for consistency with the rest of the app's "URL is canonical state". | P2 |
| 31 | Loading state during data fetch | Shiny: spinner via `ui.output_ui` default | DONE | `<PlotSkeleton />` from `components/PlotSkeleton.tsx:1-6` (`Skeleton h-[400px]`) shown while `isPending && reg && datasets.length` (`Binding.tsx:40`). | — |
| 32 | Error display | Shiny: `logger.exception(...)`; failed pair shown as empty box, no UI banner | PARTIAL | React `<ErrorBoundary>` plus `<p className="text-red-600">{error.message}</p>` (`Binding.tsx:38-39, 47`). Better than Shiny (Shiny silently swallows). | — |
| 33 | Heading "Binding Correlation" | `workspace_heading("Binding Correlation")` in `binding/ui.py:28` | MISSING | No `<h1>` on the React route. Only the sidebar `<h2>Regulator</h2>` (`Binding.tsx:34`). | P2 |
| 34 | Sidebar heading "Binding" | `sidebar_heading("Binding")` in `binding/ui.py:19` | PARTIAL | React shows `<h2>Regulator</h2>` instead of `<h2>Binding</h2>` — heading describes the picker, not the module. | P2 |
| 35 | Cross-route navigation (Binding ↔ Perturbation ↔ Select) | Shiny: top nav buttons via `app.py` | DONE | `components/Nav.tsx:1-32`. | — |
| 36 | Tab switch suppression: `_sync_pairs` and `_sync_condition_maps` are silently gated by `active_module()=='binding'` so tabs in background don't run SQL | `workspace.py:94,114` | N/A | React routes unmount on navigation, so no equivalent needed — React queries with `enabled:` gate fetching. | — |
| 37 | WebGL fallback for large point clouds (Shiny doesn't have this; React has it for the wrong plot) | — | DONE (wrong scope) | `BindingScatter.tsx:10` switches to `scattergl` when `total > 5000`. Will be useful for the per-pair scatters when they land. | — |
| 38 | Download / export plot or correlation table | Shiny: Plotly's built-in mode-bar provides PNG download; no custom CSV/JSON download | DONE | React uses `displaylogo:false, responsive:true` (`BindingScatter.tsx:23`); Plotly mode bar provides PNG. No custom CSV/JSON export in either. | — |
| 39 | Plot mode-bar: pan, zoom, lasso, reset axes, hover toggle | Plotly default mode-bar in both | DONE | Same Plotly defaults; React `displaylogo:false` is identical to Shiny's default config. | — |
| 40 | Sample id text shown anywhere for the user | Shiny: not directly; condition label is the visible surrogate | PARTIAL | React puts raw `sampleId` in `hovertext` (`BindingScatter.tsx:17`) — exposes an internal ID. Should be condition label once that map is implemented. | P2 |
| 41 | Tooltip on box-plot points: `"<gene symbol>\nr = X.XXX"` via `hovertemplate=%{text}<br>r=%{y:.3f}<extra></extra>` | `workspace.py:309-324` | MISSING | No box plot exists. | P0 |
| 42 | Tooltip on selected overlay dots: `"<gene symbol>\nr = X.XXX\n<dataset A>: <cond A>\n<dataset B>: <cond B>"` (HTML-escaped, joined with `<br>`) | `workspace.py:295-306` | DONE | Closed in Phase C — commit `3e4b80a`. `BindingCorrBoxplot` renders the multi-line overlay hovertext; every DB-sourced string passes through `lib/html-escape.ts`. | — |
| 43 | Plot resize handling | `PlotLazy.tsx` calls `factory(Plotly)` → React-Plotly handles resize when `useResizeHandler` set | DONE | `BindingScatter.tsx:24` sets `useResizeHandler`. | — |
| 44 | Lazy-load Plotly bundle so route-shell renders before bundle arrives | `frontend/src/plots/PlotLazy.tsx:1-17` (`lazy`) | DONE | Better than Shiny (Shiny ships Plotly on every page). | — |
| 45 | Loaded Plotly trace types: scatter, scattergl, heatmap, bar | `plots/plotly-bundle.ts:1-10` | PARTIAL | **Missing `box` trace type** — distributions plot needs `Plotly.register(box)`. `histogram2d` was already dropped to keep gzip ≤ 512 KB; adding `box` will need to be measured against that budget. | P0 |
| 46 | Filter inputs (regulator-locus tags, categorical, numeric range, boolean) UI | Filters are applied on Select Datasets page in Shiny; this module only consumes `dataset_filters` | OUT-OF-SCOPE | This module trusts `?filters=`. Filter-editing UI is the Select page's concern. Within Binding the only thing that matters is the URL → API plumbing, which is wired. | — |
| 47 | Per-dataset filter stripping: when fetching scatter for a regulator, the `regulator_locus_tag` filter is removed from the per-dataset filter spec to avoid `WHERE regulator IN (...) AND regulator = ?` redundancy | `workspace.py:536-540` (`_strip_reg`) | MISSING | When per-pair scatter endpoint is added, backend must replicate this strip; otherwise filters interact badly with the per-regulator `WHERE`. | P1 |
| 48 | DB-source `display_name`s come from `vdb.get_tags(db_name)["display_name"]` falling back to `db_name` | `workspace.py:66-69` | DONE | Backend exposes `displayName` on each `DatasetEntry` (`backend/internal/domain/responses.go:7`); React Select uses it (`Select.tsx:69`). Binding route doesn't render display names yet (no plot needs them). When per-pair scatters land, they must show display names for axis/title text. | P1 |

Severity: P0 = core, P1 = significant, P2 = polish.

## 3. Controls (every input/selector/threshold/toggle)

### Shiny controls (in `reference/tfbpshiny/modules/binding/server/sidebar.py`)
- **Column** radio buttons (sidebar.py:91-98): `effect` / `pvalue`, default `effect`, inline layout, **no label**, `<small>Column</small>` heading above (via `sidebar_label`).
- **Correlation** radio buttons (sidebar.py:99-106): `pearson` / `spearman`, default `pearson`, inline layout, `<small>Correlation</small>` heading above.
- **Regulator** selectize dropdown (workspace.py:402-407): label `"Regulator"`, choices = `{locus_tag: gene_symbol or locus_tag}` sorted by symbol case-insensitively. Built dynamically from regulators present in any pair's correlation result (so the choice set narrows as datasets/filters change). Default = current selection if still valid, else first item. Both **a programmatic update target** (set by box-plot clicks) and a **user-driven selector**.

### React controls (in `frontend/src/routes/Binding.tsx`, `frontend/src/components/RegulatorPicker.tsx`)
- **RegulatorPicker** (`RegulatorPicker.tsx`): text input + server-search list (`useDeferredValue`, `api.regulators({ search, limit: 20 })`, enabled on `length >= 1`). Lists locus tag + display name, click to set. Stores selection in URL `?regulator=`.
- **Nothing else.** No Column radio, no Correlation radio.

### Gaps
- Add `effect`/`pvalue` toggle → URL `?col=effect|pvalue` (default `effect`).
- Add `pearson`/`spearman` toggle → URL `?corr=pearson|spearman` (default `pearson`).
- Narrow RegulatorPicker (or add a second selector) to **only regulators present in the active pair correlation data** — the current global typeahead can hand the user a tag that will yield empty plots silently. At minimum, surface a "regulator not present in any pair" warning when zero pairs have data.

## 4. Plots (every plot type, with axes/colors/tooltips/legend detail)

### 4.1 Pairwise distribution box plot (Shiny: `distributions_plot`, workspace.py:218-364) — **MISSING in React**

- **Plot type:** single combined `go.Box` trace with `boxpoints="all", jitter=0.4, pointpos=0`.
- **X axis:** categorical, label per box = `"<display_name(A)><br>vs<br><display_name(B)>"`. One box per active dataset pair (`sorted(active) choose 2`).
- **Y axis:** numeric, title = `"{Pearson|Spearman} r"`.
- **Markers (box points):** `size=4, opacity=0.5`; line `width=1.5`. No per-point color encoding; all jitter dots share the box color.
- **Selected-regulator overlay (second trace):** `go.Scatter`, `mode="markers"`, one marker per pair where the selected regulator yielded a row, `marker=dict(size=10, color="black", symbol="circle")`. Drawn on top of the box trace.
- **Hover (box):** `hovertemplate="%{text}<br>r = %{y:.3f}<extra></extra>"` where `text` = gene-symbol display name. `customdata` carries the locus tag.
- **Hover (overlay):** `hovertemplate="%{hovertext}<extra></extra>"`; `hovertext` is multi-line `"<symbol>\nr = X.XXX\n<dataset A label>: <cond A>\n<dataset B label>: <cond B>"`, HTML-escaped per line, joined with `<br>`. Lines for datasets with no condition label are omitted.
- **Title:** `"{Pearson|Spearman} correlation across regulators"`.
- **Legend:** `showlegend=False`.
- **Layout:** `margin=dict(l=40, r=20, t=50, b=80)`. Plotly autosize (Shiny inlines via `to_html`).
- **Empty state:** when no active pairs, single centered annotation "Select at least two binding datasets to see correlations." (paper coords 0.5, 0.5).
- **Click behavior:** every dot is clickable. Post-script JS reads `customdata` (locus tag) and writes it back to `input.selected_regulator` with `priority: 'event'`. This is the primary cross-plot interaction.

### 4.2 Per-pair scatter (Shiny: `_make_scatter_render`, workspace.py:493-610) — **MISSING in React**

One Plotly figure per active `(db_a, db_b)` pair, each in its own DOM slot inside a flex row.

- **Plot type:** single `go.Scatter` trace, `mode="markers"`.
- **X axis:** title `"{display_name(db_a)}: {col_a}"`, where `col_a` is the resolved effect or p-value column for `db_a` given current Column preference (e.g. `callingcards_enrichment`, `poisson_pval`, `effect`, `pvalue`). For Spearman, values are **ranks** (effect ranked by `ABS DESC`, p-value ranked `ASC`) — axis title still shows the raw column name even though the rendered values are ranks.
- **Y axis:** title `"{display_name(db_b)}: {col_b}"`.
- **Markers:** `size=4, opacity=0.6, color="#4A90D9"` (single solid blue).
- **Text per marker:** `target_locus_tag` (set as `text=`). Shown via the hover template.
- **Hover:** `"<display_name(db_a)>: %{x:.3f}<br><display_name(db_b)>: %{y:.3f}<extra></extra>"`. Note: target locus tag is in `text` but NOT in the hovertemplate (a Shiny minor oversight — the `text` is unused).
- **Annotation:** `r=N.NNN` in top-right (paper 0.98, 0.98, anchor right/top, font size 12). `r` is `merged["_val_a"].corr(merged["_val_b"])` — Pearson of whatever values are plotted (so Spearman pairs end up showing the Pearson of the *ranks*, which equals the Spearman of the raw values).
- **Title:** two-line center `"{display_name(db_a)}<br>vs<br>{display_name(db_b)}"`, `xanchor=center, x=0.5`.
- **Legend:** `showlegend=False`.
- **Size:** fixed `width=400, height=400`. Container `flex: 0 0 auto` so plots don't stretch.
- **Layout:** `margin=dict(l=50, r=20, t=100, b=50)`.
- **Empty state:** when join returns zero rows OR when the regulator is not in either dataset, the slot renders `ui.span()` (zero space).

### 4.3 React scatter (current `frontend/src/plots/BindingScatter.tsx`)

- One `scatter`/`scattergl` trace per dataset in `data.datasets`.
- X = `targetLocusTag` (categorical strings — yields a useless point cloud with N strings on the X axis), Y = `value`.
- `xaxis: { showticklabels: false }` — ticks are hidden because the X data is identifier strings.
- Hovertext = `sampleId`. No hovertemplate, no axis titles, no `r` annotation, no per-dataset color encoding except trace-default colors.
- `height: 400`. No fixed width. `useResizeHandler` honored.

**Verdict:** The React plot bears no resemblance to either of the Shiny binding plots. It is closer to a debug view of the raw `/binding` payload than to the analytical view the module is supposed to provide.

## 5. Tables / downloads

Neither implementation has a tabular view of the underlying data. Neither has an explicit CSV/JSON download button.

- Plotly's mode-bar PNG download is available in both (default Plotly behavior).
- No "download correlation table" or "download joined scatter" button in Shiny or React.

No gap.

## 6. Interactions (hover, zoom, brush, click-to-filter, cross-plot linking)

| Interaction | Shiny | React | Gap |
|---|---|---|---|
| Hover with rich tooltip on box-plot dots | YES (gene symbol + r) | n/a | P0 — no box plot |
| Hover with condition label on selected overlay | YES (symbol + r + per-dataset condition) | n/a | P0 |
| Hover on per-pair scatter | YES (`x:.3f`, `y:.3f`, dataset display names) | NO (only `sampleId` in hovertext on the wrong plot) | P0 |
| **Click box-plot dot → set selected regulator** | YES (JS post_script writes `input.selected_regulator`) | NO | P0 — primary cross-plot navigation gone |
| Click per-pair scatter point | NO | NO | — |
| Plotly default zoom/pan/reset/lasso/box-select | YES | YES (Plotly default) | — |
| Cross-route regulator linking (Binding → Perturbation with same `?regulator=`) | NO (Shiny has no URL) | YES (URL-driven) | DONE+ |
| Cross-plot linking (per-pair scatter highlight via shared color/symbol) | Implicitly via the selected-overlay; per-pair scatters always reflect the current selection | n/a | P0 |
| Brushing across pair plots | NO | NO | — |

## 7. Data flow

### Shiny queries (file:line + SQL shape)
- **Per-regulator correlation across ALL active pairs** — `reference/tfbpshiny/modules/binding/queries.py:331-390` (`corr_all_pairs_sql`). UNION-ALL of one `_corr_pair_sql_impl` per `(db_a, db_b)` pair. Each sub-query is a CTE chain (`a_raw`, `b_raw`, `shared_regs INTERSECT`, `joined INNER JOIN`, `WHERE NOT isinf NOT isnan`, `GROUP BY regulator, sample_a, sample_b HAVING COUNT(*) >= 3`, `SELECT corr(...) AS correlation` or Spearman via `RANK()`). Returns one DataFrame, partitioned client-side by `pair_key = "{db_a}__{db_b}"` (workspace.py:204-216).
- **Per-regulator scatter join for one pair** — `queries.py:393-477` (`regulator_scatter_sql`). Builds `binding_data_query(db_a, col_a, filters_a)` and `..._b`, appends `AND regulator_locus_tag = $reg`, then either `SELECT a.target_locus_tag, a.col AS _val_a, b.col AS _val_b FROM a JOIN b ON a.target = b.target` (Pearson) or wraps with `RANK() OVER (ORDER BY ABS(val) DESC)` / `ORDER BY val ASC` (Spearman).
- **Sample-condition map** — `utils/sample_conditions.py:55-94`. `SELECT sample_id, "cond_col_1", "cond_col_2" FROM {db_name}_meta`. Returns `{sample_id: " / ".join(non-empty cond values)}`.
- **Regulator display-name table** — `utils/vdb_init.py:163, 213` (`regulator_display_names` precomputed at app init). Used to build `sym_map` (`workspace.py:71-74`).
- **Underlying binding data** — `queries.py:56-81` (`binding_data_query`). `SELECT regulator_locus_tag, target_locus_tag, sample_id, {col} FROM {db_name} {WHERE filters}`. Used as a sub-query by both `corr_pair_sql` and `regulator_scatter_sql`; never executed directly by the binding module's renderers (the React app's `/api/v/{v}/binding` endpoint runs essentially this exact SELECT in isolation, which is what makes the current React endpoint *adjacent to* but *not the same as* what the page needs).

### React API calls (endpoint + params)
- `GET /api/v/{v}/binding?regulator=<tag>&datasets=<csv>&filters=<json>` — `frontend/src/routes/Binding.tsx:18-23`. Returns `BindingResponse { regulator, datasets[{ dbName, column, rows[{ regulatorLocusTag, targetLocusTag, sampleId, value }] }] }`.
- `GET /api/v/{v}/regulators?search=...&limit=20` — `frontend/src/components/RegulatorPicker.tsx:14-19`. Returns `RegulatorsResponse`.

That is the entire API surface the route consumes.

### Mismatches (where React can't get what Shiny renders)
1. **No correlation endpoint.** The Shiny page is fundamentally a correlation visualiser; the React-facing API has zero correlation primitives. `backend/internal/queries/binding/corr_pair.sql:1` is a placeholder.
2. **No per-pair joined-scatter endpoint.** `regulator_scatter.sql:1` is also a placeholder.
3. **Effect-vs-P-value column map is half-implemented.** The Go map only has the effect column; the p-value column (`poisson_pval`, `pvalue`) is not surfaced anywhere. The Shiny `get_measurement_column(...,"pvalue")` falls back to effect when no p-value exists; Go has no equivalent path.
4. **No sample-condition endpoint.** The hover-text feature for selected-overlay dots needs `{db_name: {sample_id: cond_label}}` maps, which `*_meta` queries provide. Backend has no `/api/v/{v}/dataset/{db}/sample_conditions` (or equivalent embed) yet.
5. **Pearson vs Spearman is a server-side computation (DuckDB `corr` + `RANK()` window).** It must live in Go SQL — there is no realistic way to compute Spearman in the browser over N regulators × M targets × P pairs.
6. **`HAVING COUNT(*) >= 3` and NULL/isinf/isnan filtering** must be replicated exactly. DuckDB's `corr` raises on non-finite inputs (workspace.py comment cites duckdb#14373 and discussion#10956). Parity tests in `tests/parity/` will fail otherwise.
7. **The `_val_a` rank inversion for p-value vs effect** (workspace.py:449-451, queries.py:192-193) is a domain-specific detail (smaller p-value = more significant ⇒ higher rank). Easy to get wrong on a port. Add a parity test that pins the rank direction for both column kinds.

## 8. URL state / deep linking

| URL key | Shiny | React | Notes |
|---|---|---|---|
| `?regulator=<tag>` | not used (in-memory `input.selected_regulator`) | YES — read at `Binding.tsx:12`, written by `setRegulator` `:25-29` | DONE+ (improvement). |
| `?binding=<csv>` | not used (in-memory `active_binding_datasets`) | YES — read at `Binding.tsx:15` | DONE+. |
| `?filters=<json>` | not used (in-memory `dataset_filters`) | YES — read at `Binding.tsx:16`, passed through to backend | DONE+. |
| `?corr=pearson|spearman` | n/a | MISSING | Should be added when the radio is added (P0). |
| `?col=effect|pvalue` | n/a | MISSING | Same (P0). |

When the user clicks "back" / shares the URL, React already restores datasets+regulator+filters. After adding `?corr=` and `?col=` (and the box-plot click writing `?regulator=` instead of an in-memory reactive), the Binding URL becomes fully deep-linkable — a strict win over Shiny.

## 9. Backend gaps blocking parity

These items MUST be on the Phase 1.6/post-cutover plan; no amount of React work alone closes them.

1. **New endpoint: pair correlation distribution.** Suggested shape:
   - `GET /api/v/{v}/binding/corr?datasets=<csv,csv,...>&method=pearson|spearman&col=effect|pvalue&filters=<json>`
   - Returns: `{ method, col, pairs: [{ dbA, dbB, points: [{ regulatorLocusTag, dbAId, dbBId, correlation }] }] }`.
   - SQL: port `corr_all_pairs_sql` from `queries.py:331-390` into `backend/internal/queries/binding/corr_pair.sql` (currently placeholder). Must replicate: INNER JOIN on `(regulator, target)`; `WHERE NOT isnan NOT isinf NOT null`; `HAVING COUNT(*) >= 3`; Spearman = `RANK() OVER (PARTITION BY (reg, sample_a, sample_b) ORDER BY ...)`; effect ranked by `ABS DESC`, p-value by `ASC`.
2. **New endpoint: per-pair regulator scatter.** Suggested shape:
   - `GET /api/v/{v}/binding/scatter?regulator=<tag>&pair=<dbA>,<dbB>&method=pearson|spearman&col=effect|pvalue&filters=<json>`
   - Returns: `{ regulator, dbA, dbB, colA, colB, method, points: [{ targetLocusTag, valA, valB }], r }`. (Compute `r` server-side so the client doesn't have to.)
   - SQL: port `regulator_scatter_sql` from `queries.py:393-477` into `backend/internal/queries/binding/regulator_scatter.sql`. Must strip `regulator_locus_tag` from `filters[dbA]` and `filters[dbB]` before applying (`workspace.py:536-540`) to avoid `WHERE reg IN (...) AND reg = ?` redundancy.
3. **Dataset-manifest measurement-column map (Phase 1.6).** Move both effect and p-value column names into `dataset_manifest` (`schema_version=3`). Today's `binding.go:21-26` only knows effect. CLAUDE.md already flags this. Until done, the `?col=pvalue` mode cannot work.
4. **Sample-condition map.** Add either (a) a dedicated endpoint `GET /api/v/{v}/dataset/{db}/sample_conditions` or (b) embed `{sample_id: cond_label}` in the existing `/binding/corr` response payload so the frontend doesn't need a second round-trip per dataset. Source columns come from `condition_cols` (currently in `AppDatasets`; needs to be exposed via `dataset_manifest` or `field_manifest` — `dataset_manifest` already has display-name and assay, so adding `condition_cols []string` is a small extension).
5. **Whitelist enforcement on `?corr=` / `?col=`.** Both must be enum-validated at request time (mirror `validFilterTypes` pattern at `binding.go:191-195`). Anything not in the enum → 400.
6. **Cache key canonicalisation for new params.** Include `method`, `col`, sorted `datasets`, canonical `filters` in `cache.Key(...)` (mirror `binding.go:74-87`).
7. **Numerical parity tests (`tests/parity/`).** Add fixtures that pin the documented outputs of `corr_all_pairs_sql` and `regulator_scatter_sql` for at least: (a) Pearson on effect; (b) Spearman on effect; (c) Pearson on p-value (where p-value column exists); (d) Spearman on p-value; (e) the `HAVING COUNT(*) >= 3` floor; (f) NaN/Inf/NULL row exclusion; (g) the `regulator_locus_tag`-strip on filters. The current `binding_test.go:1-87` tests only validation/error paths; no happy-path numerical tests exist (the file's own comment at `:3-4` flags this).
8. **Plotly bundle.** Add `Plotly.register(box)` to `frontend/src/plots/plotly-bundle.ts:9`. Measure gzip impact against the 512 KB target documented in the comment at `plotly-bundle.ts:6-7`. If over budget, drop `bar` (Comparison can keep using `heatmap`).

## 10. Open questions

1. **Pair endpoint or combined endpoint?** Shiny computes "all pairs at once" via UNION-ALL for a single round-trip. The React route in principle could fan out N×N/2 parallel requests (TanStack Query handles this fine), but each response carries the same regulator-symbol mapping and the same condition map, so server-side combining is the cheaper move. Recommend a single `/binding/corr` returning all pairs in one payload.
2. **Where do `regulator_display_names` get exposed to React?** Currently `RegulatorPicker` hits `/regulators` and gets `displayName` per row, but the box plot needs the *full mapping* for all regulators in the result. Either: (a) include `displayName` on every `points[]` row of the correlation response (duplicative but simple), or (b) add a separate `/regulators/displaynames` keyed by locus tag.
3. **What happens when only ONE binding dataset is selected?** Shiny shows the "Select at least two binding datasets…" annotation. React currently allows N=1 (the data-dump endpoint accepts any positive N). Decide: keep the React data-dump endpoint for N=1 as a fallback view, or remove it and gate the page on N≥2 like Shiny does.
4. **Per-pair `r` annotation method.** Shiny computes `r` in Python as Pearson over whatever is plotted (so Spearman pairs ship as the Pearson of the *ranks*, which mathematically equals the Spearman of the raw values). If we move `r` to SQL, we can compute it once and stamp it into the response — but then we lose the implicit "Pearson of ranks = Spearman" guarantee unless we use the *same* corr aggregate. Recommend computing `r = corr(_val_a, _val_b)` in the scatter SQL and returning it on the response.
5. **Selected-regulator overlay coloring.** Shiny uses a single black dot per box. With multiple samples per regulator/dataset there can be >1 overlay dot per box. Is that intentional UX or an accidental side-effect of the multi-sample correlation rows? Behaves the same way after porting; document the choice.
6. **`scattergl` for box plots?** Plotly does NOT provide `boxgl`. For the distribution plot we are stuck with `box` even at large regulator counts (e.g. ~2000 regulators × 10 pairs ⇒ 20k jitter points). Measure performance before shipping; the threshold for switching jitter points to a separate `scattergl` overlay (and turning off `boxpoints` in the `box` trace) may be lower than the existing 5000 threshold in `BindingScatter.tsx:10`.
7. **What is the React route shell?** Shiny has a sidebar (Column/Correlation radios) + a workspace body (heading "Binding Correlation" + distributions plot + hr + regulator selector + scatter row). React has a CSS grid `[300px_1fr]` with the sidebar containing only the RegulatorPicker. Once the radios land, decide: keep the radios in the sidebar (matches Shiny), or surface them above the box plot? Recommend sidebar for consistency.
8. **Does the React RegulatorPicker need to be filtered to "regulators present in active pairs"?** Shiny's selectize narrows to that set after correlation runs. Replicating exactly means: (a) wait for `/binding/corr` to return; (b) compute the union of `points[].regulatorLocusTag` across pairs; (c) restrict the picker. That is a chicken-and-egg: the picker drives plot fetch, plot fetch drives picker choices. The simpler model is to keep the picker global (current behavior) and surface a "regulator not present in any pair" notice (item 12 in §2). Decide before plan.

---

_Audit table updated 2026-05-22 after Phase C completion._
