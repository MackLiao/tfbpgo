# Parity re-audit — 2026-06-11: promoter sets + comparison rewrite

**Go/React rewrite (`main`, this repo) vs reference Shiny app (`reference/`, branch `michael_revisions`, HEAD `1b53df0`, 2026-06-10).**

## Why this audit exists

The Go service was last certified at full parity against reference commit **`1f5c29b`** (2026-05-22).
Since then the reference Shiny app advanced significantly (commits `4a3e3b3` → `1b53df0`):
it added a family of **promoter-set dataset variants**, **rewrote the comparison tab** (queries
`+416` lines, server `+2199`), reworked **binding/perturbation** (`+1010` / `+1052`), changed
several **first-load defaults**, **removed the export feature**, and added a complete SQL
catalogue at `reference/docs/sql_operations.md`.

Separately, the Go data-prep dataset config (`data_prep/brentlab_yeast_collection.yaml`) was
**copied once on 2026-05-12 and never re-synced**. It carries only the 11 base datasets — it
never even picked up the `_mindel`/`_peaks` variants that existed at the `1f5c29b` baseline.

So the gap = (everything the reference changed since `1f5c29b`) + (the never-synced roster).

## How this was produced

A 6-way parallel module comparison (data-roster, select-datasets, binding, perturbation,
comparison, home-chrome), each diffing `reference 1f5c29b..1b53df0` against the Go counterpart,
followed by an adversarial-verification pass on every blocker/high finding and a completeness
critic over the full diff. **Every load-bearing claim below was then re-verified directly against
the current reference source** (the automated agents produced several false positives — see
§Refuted). The perturbation comparison agent crashed; its area is covered by the critic + direct
reads of `perturbation/queries.py`.

---

## Gap summary

Severity: **B**locker (wrong/missing scientific result or data users expect) · **H**igh
(visible behaviour/contract divergence) · **M**edium · **L**ow/cosmetic. "Verified" = confirmed
by direct read of current reference + Go source (not just an agent claim).

| ID | Area | Sev | Verified | One-line |
|----|------|-----|----------|----------|
| R-1 | data-roster | **B** | ✅ | 11 promoter-set variants missing from Go artifact (`callingcards_*`, `rossi_*`, `chec_m2025_*`) |
| R-2 | data-roster / manifest | **B** | ✅ | `DATASET_MEASUREMENT_COLUMNS` lacks variant entries → `write_dataset_manifest` raises |
| R-3 | manifest bug (existing) | **B** | ✅ | **degron pvalue column is now `padj`, not `pvalue`** — wrong even before variants |
| R-4 | manifest schema | **H** | ✅ | measurement config is now a 4-tuple: `rossi`/`chec_m2025` gain `log_poisson_pval` (log10p) |
| CMP-1 | comparison SQL | **B** | ✅ | `topn.sql` missing `intersecting_targets` CTE → top-N ranks binding-only targets |
| CMP-2 | comparison config | **B** | ✅ | `bindingConfigs` (Go) has 4 of 15 binding datasets; variants/peaks dropped silently |
| CMP-4 | comparison contract | **H** | ✅ | reference replaced effect/pvalue sliders with **Relaxed/Stringent** presets |
| CMP-5 | comparison thresholds | **H** | ✅ | Stringent applies per-dataset thresholds (degron 0.38/0.1, kemmeren 0.77/0.05, …) |
| CMP-6 | comparison UI | **H** | ✅ | 3-tab restructure: Compare Datasets / Promoter Definitions / Analysis Methods |
| BIND-1 | binding contract | **H** | ✅ | new `log10pval` measurement column option (with per-dataset source fallback) |
| BIND-2 | binding UI | **H** | ✅ | correlation-matrix tab with cell-click pair selection (pending → committed pairs) |
| BIND-3 | binding behaviour | **H** | ✅ | `col_preference` drives a `-log10(p)` scatter transform (clip at `1e-10`) |
| BIND-5 | binding default | **H** | ✅ | default measurement changed `effect` → `log10pval` |
| BIND-6 | binding default | **H** | ✅ | default correlation method changed `pearson` → `spearman` |
| PERT-1 | perturbation | **H** | ✅ | same `log10pval` / 4-tuple / spearman-default changes as binding |
| DEF-1 | defaults | **H** | ✅ | `harbison` removed from `DEFAULT_ACTIVE_DATASETS` |
| DEF-2 | defaults | **M** | ✅ | `hackett.time` default filter changed numeric `[45,45]` → categorical `[45]` |
| SD-2 | feature removal | **H** | ✅ | reference deleted the export feature; Go still ships it → **decision required** |
| SD-3 | select contract | **M** | ⚠️ | dataset names rendered as DOI links (Go has no DOI in `/datasets`) |
| HOME-1 | chrome | **H** | ✅ | nav label + comparison page `<h1>` changed to "Binding/Perturbation Comparisons" |
| HOME-2 | chrome | **M** | ✅ | new loading/pending CSS (`.cd-pulse`, `.pending-banner`, table-loading skeletons) |
| HOME-3 | chrome | **L** | ✅ | app-level "Datasets loading…" banner on first paint |
| BIND-7 | perf (non-parity) | **L** | ✅ | reference runs corr per-pair (not one UNION) to bound peak memory — optional |

**Refuted (do not chase):** SD-1 (matrix `COUNT(DISTINCT)` vs `COUNT(*)` — equivalent, meta is
1 row/sample) · SD-4 (numeric categorical coercion — DuckDB implicit-casts; not a correctness
bug) · BIND-4 (median-per-pair in `/corr` response — only needed *if* we adopt BIND-2's matrix
UI) · CMP-3 / `_meta_sample_where` (reference filters via `{db}_meta` subquery because its new
`vdb_materialize` projects columns off the wide view; the Go artifact keeps all columns on `{db}`,
so direct filtering is **numerically equivalent** — code-health only, not a gap).

---

## Detail + authoritative configs (copy-paste ready)

### R-1 / R-2 / R-3 / R-4 — data layer (the unblocker)

The build is fully YAML-driven: `build_full` → `labretriever.VirtualDB(yaml)` registers
`{db}`+`{db}_meta` views for every YAML dataset → `materialize_views_as_tables` (discovered via
`information_schema`) → `_run_manifests` builds `dataset_manifest`/`field_manifest` from the
materialized columns. So adding the variants needs **no new pipeline logic** — only YAML + the
per-dataset constant tables that gate the build.

**R-1** — sync `data_prep/brentlab_yeast_collection.yaml` to the reference's current roster.
Add the 11 variants (copy the dataset blocks + the `region_sets` keys they reference) and the
consolidated `rossi_peaks`. The reference's current binding roster:

```
callingcards, callingcards_mindel, callingcards_500bp, callingcards_intergenic,
harbison,
rossi, rossi_mindel, rossi_500bp, rossi_intergenic, rossi_peaks,
chec_m2025, chec_m2025_mindel, chec_m2025_500bp, chec_m2025_intergenic, chec_m2025_peaks
```
(Perturbation roster unchanged: `degron, hughes_overexpression, hughes_knockout, kemmeren, hackett, hu_reimand`; plus `dto`.)

**R-3 + R-4** — `data_prep/src/data_prep/manifests.py::DATASET_MEASUREMENT_COLUMNS` must become a
**4-tuple** `(effect_col, pvalue_col, log10p_col, neglog10p_col)` and gain the variants. The
authoritative values from `reference/.../binding/queries.py` + `perturbation/queries.py`
(`DATASET_COLUMNS`) and `comparison/queries.py` (`BINDING_CONFIGS`):

| db_name | effect_col | pvalue_col | log10p_col | neglog10p_col |
|---|---|---|---|---|
| callingcards(+_mindel/_500bp/_intergenic) | `callingcards_enrichment` | `poisson_pval` | — | — |
| harbison | `effect` | `pvalue` | — | — |
| rossi(+_mindel/_500bp/_intergenic) | `enrichment` | `poisson_pval` | `log_poisson_pval` | — |
| rossi_peaks | `peak_score` | — | — | — |
| chec_m2025(+_mindel/_500bp/_intergenic) | `enrichment` | `poisson_pval` | `log_poisson_pval` | — |
| chec_m2025_peaks | `peak_score` | — | — | — |
| **degron** | `log2FoldChange` | **`padj`** ⬅ was `pvalue` | — | — |
| hughes_overexpression | `mean_norm_log2fc` | — | — | — |
| hughes_knockout | `mean_norm_log2fc` | — | — | — |
| kemmeren | `Madj` | `pval` | — | — |
| hackett | `log2_shrunken_timecourses` | — | — | — |
| hu_reimand | `effect` | `pval` | — | — |

> **R-3 is a latent bug in the *current* production artifact**: Go's degron `pvalue_col` is
> `"pvalue"`, but the reference responsiveness now keys on `padj`. The degron comparison
> responsive-ratio is computed against the wrong column today. Verify the materialized `degron`
> table column name when rebuilding (it must expose `padj`).

This requires adding `log10p_col`/`neglog10p_col` columns to the `dataset_manifest` table and the
Go `db.DatasetRow` struct → **`schema_version` 5 → 6** (Go compatible range `[6,6]`,
`backend/internal/db/startup.go`). See `backend/internal/db/manifest.go`.

**Variant exposure (see Decision D2):** the reference keeps a `PRIMARY_DATASETS` set and shows
*only* primary datasets in the dataset selector — "alternate promoter variants remain registered…
accessible to analysis modules once a promoter selector is wired up." The Go `/datasets` endpoint
returns the whole manifest, so adding variants would surface them as 15 selectable toggles
(divergence). Recommended: add an `is_primary BOOLEAN` column to `dataset_manifest` (same schema-6
bump) and have the frontend selector filter to `is_primary`; comparison reads all.

**Defaults (DEF-1/DEF-2):** in `manifests.py`, remove `harbison` from `DEFAULT_ACTIVE_DATASETS`;
change `hackett` default filter from numeric `[45,45]` to categorical `[45]`. `DEFAULT_DATASET_FILTERS`
otherwise matches (Go maps reference's Title-Case `"Experimental condition"` → lowercase machine
columns — equivalent and intentional).

### CMP-1 — `intersecting_targets` CTE (numerical blocker)

`backend/internal/queries/comparison/topn.sql` ranks **all** binding targets, then joins
perturbation. The reference (`queries.py:381-402`) now computes a perturbation CTE first and an
`intersecting_targets = binding ⋂ perturbation on (regulator, target)` CTE, and `binding_ranked`
**INNER JOINs `intersecting_targets` before `RANK() OVER`**. Effect: top-N slots are not consumed
by binding-only targets, changing `responsive_ratio`. Fix: reorder `topn.sql` CTEs to
`binding → perturbation → intersecting_targets → binding_ranked(INNER JOIN it) → top_n_binding →
SELECT`. (`buildOnePair` in `comparison_topn.go` already emits the perturbation CTE; the
restructure is mostly SQL.)

### CMP-2 — variant binding configs

`comparison_topn.go::bindingConfigs` has 4 of the 15 reference binding configs. Authoritative
`BINDING_CONFIGS` (`comparison/queries.py:570`):

- `callingcards`,`callingcards_mindel`,`callingcards_500bp`,`callingcards_intergenic` → `rank_col=poisson_pval`, `rank_asc=True`, `target_blacklist=CC_TARGET_BLACKLIST`
- `harbison` → `rank_col=pvalue`, `rank_asc=True`, `binding_dedup_cte` (harbison MIN-dedup, condition='YPD')
- `chec_m2025`,`chec_m2025_mindel`,`chec_m2025_500bp`,`chec_m2025_intergenic` → `rank_col=enrichment`, `rank_asc=False`
- `rossi`,`rossi_mindel`,`rossi_500bp`,`rossi_intergenic` → `rank_col=enrichment`, `rank_asc=False`
- `chec_m2025_peaks`,`rossi_peaks` → `rank_col=peak_score`, `rank_asc=False`

(callingcards has no peaks variant.) Without these, `keepConfigured` silently drops variant pairs.
**Cleaner option:** externalize `rank_col`/`rank_asc`/`harbison_dedup`/`blacklist_ok` into
`dataset_manifest` (the same schema-6 bump) instead of a hard-coded Go map — consistent with how
`effect_col`/`pvalue_col` were externalized in schema 3.

### CMP-4 / CMP-5 — responsiveness presets

Reference `ui.py` now offers a **Relaxed/Stringent** radio (default **Relaxed**) instead of
effect/pvalue sliders. `DEFAULT_RESPONSIVENESS_PRESETS` (`vdb_init.py:113`):

```
Stringent: { "*": (1.0, 0.05), degron: (0.38, 0.1), hackett: (0.0, 1.0),
             kemmeren: (0.77, 0.05), hu_reimand: (0.0, 0.05),
             hughes_overexpression: (1.0, 1.0), hughes_knockout: (1.0, 1.0) }
Relaxed:   { "*": (0.0, 0.05), hackett: (0.0, 1.0) }   # DEFAULT
```

> **No default numerical regression:** Go's current hard-coded `(effect=0.0, pvalue=0.05)` equals
> the **Relaxed** preset for every dataset (hackett's `(0.0,1.0)` is inert — no pvalue col). So
> first-load output already matches. The gap is the **missing Stringent option** + the contract
> shift from numeric params to a preset enum. Recommended: accept `?preset=Relaxed|Stringent` and
> look up per-(preset, p_db) thresholds in `buildOnePair` (keep numeric params as a back-compat
> path or drop them with a version bump).

### CMP-6 / BIND-2 / BIND-1 / BIND-3 — new analysis UI (large frontend work)

These are the bulk of "more progress and decisions" and are **new React feature builds**, not
config tweaks:

- **Binding correlation-matrix tab** (BIND-2): upper-triangle N×N matrix, one cell per pair with
  median-correlation label, cell-click toggles `pending_pairs` (highlight), "Execute Analysis"
  commits → `committed_pairs` drives boxplot + scatter. New tab layout: Correlation Matrix / Pair
  Distribution / Gene Scatter. (Reference `utils/correlation_matrix.py` is the builder.) *If*
  adopted, the `/binding/corr` response needs per-pair medians (BIND-4 becomes real then).
- **`log10pval` measurement** (BIND-1/BIND-3, PERT-1): add `log10pval` to `validCorrCols`
  (`correlation.go`), resolve via `neglog10p_col > log10p_col > pvalue_col > effect_col`, and apply
  the `-log10(clip(p, 1e-10))` scatter transform client-side (Pearson only; Spearman returns
  ranks). Needs the schema-6 `log10p_col`/`neglog10p_col` manifest fields.
- **Defaults** (BIND-5/BIND-6): once log10pval lands, default measurement → `log10pval`, method →
  `spearman` (`Binding.tsx` `DEFAULT_COL`/`DEFAULT_METHOD`; same for perturbation).
- **Comparison 3-tab restructure** (CMP-6): "Compare Datasets" (binding×perturbation responsive
  matrix — `utils/topn_matrix.py`), "Compare Promoter Definitions", "Compare Analysis Methods"
  (peaks vs enrichment). Frontend display constants to mirror: `PROMOTER_SET_MAP`,
  `PROMOTER_VARIANT_PAIRS`, `METHOD_BASE_LABEL_MAP`, `SCORING_VARIANT_MAP`, `PEAKS_VARIANT_MAP`,
  `SCORING_VARIANT_ORDER`, `SCORING_VARIANT_COLORS` (500bp `#7B4F9E`, Intergenic `#F39B7F`, …),
  plus extended `BINDING_LABEL_MAP` — update `frontend/src/lib/comparison-palette.ts` (currently
  base-only; variants fall back to gray + raw db_name).

### HOME-1/2/3 — chrome

- HOME-1: `Nav.tsx` "Comparison" → "Binding/Perturbation Comparisons"; comparison page `<h1>`
  likewise. **Keep the Home feature-card title "Comparison"** (reference left it unchanged — the
  agent over-reached here).
- HOME-2: add loading/pending CSS (`.cd-pulse` keyframes, `.cd-cell-loading`/`.cp-table-loading`/
  `.cm-table-loading`, `.pending-banner` amber `#fff3cd`/`#ffc107`/`#664d03`).
- HOME-3: app-level "Datasets loading. This typically takes less than 5 seconds…" banner on first
  paint.

---

## Decisions required (do not implement unilaterally)

- **D1 — Export removal (SD-2).** The reference deleted export entirely (handler, button,
  `export.py`, tests). Go's export is a working, isolated feature (`backend/internal/api/export.go`,
  `ExportSelectedButton`, `/export` route, semaphore-guarded). Removing it is destructive and a
  product call. **Recommendation: keep it** unless the Brent Lab wants strict parity; revisit at
  cutover. Flag, don't delete.
- **D2 — Variant exposure UX.** Variants must exist in the artifact (for comparison) but the
  reference hides them from the dataset selector (`PRIMARY_DATASETS`). Recommend `is_primary`
  manifest flag + frontend selector filter (above). Confirm this is the intended UX before the
  schema-6 bump locks it in.
- **D3 — Scope/sequencing of the new analysis UI** (BIND-2 matrix, CMP-6 three tabs, log10pval).
  These are large React builds that should go through `brainstorming`/`writing-plans` before
  implementation. The data-layer foundation (below) is a prerequisite for all of them and is
  unambiguous, so it goes first.

---

## Accepted implementation divergences (note at cutover)

- **Binding Gene Scatter scopes to committed pairs only (BIND-2).** The reference scatter +
  missing-note compute `sel_dbs = ⋃ committed datasets` and render every active pair whose two
  datasets are a subset of `sel_dbs` (`workspace.py:1001-1002`, `:1048-1049`) — a superset that, once
  ≥2 committed pairs span enough datasets, also shows the cross-combinations (commit A-B + C-D → also
  renders A-C/A-D/B-C/B-D). The React rewrite renders **exactly the committed pairs** (A-B, C-D). This
  is internally consistent (scatter grid + missing-note both use strict-committed), arguably the more
  intuitive "show what I selected," and deliberate — not a bug. Revisit only if the lab wants the
  superset behavior.

---

## Phased implementation plan + status

> **Subagent-driven build status (2026-06-11, branch `parity/promoter-sets-and-comparison`):**
> Tasks executed as fresh implementer subagents (Opus for integration/numerical work) with
> independent spec + code-quality review each. **DONE & merged on-branch:** schema 5→6
> (`is_primary` + `log10p`/`neglog10p` columns, DEF-1 harbison default-active) [Task 1];
> selector hides non-primary variants [Task 2]; `log10pval` measurement column + scatter
> `-log10(p)` transform + axis labels, binding default → spearman/log10pval (perturbation stays
> effect/pearson per its reference) [Task 3]; comparison Relaxed/Stringent preset radio [Task 4];
> binding correlation-matrix pair-selection tab (3 tabs, pending/committed, medians client-derived)
> [Task 5]; chrome — nav label "Binding/Perturbation Comparisons", loading CSS, datasets banner
> [Task 7]. **REMAINING:** comparison 3-tab restructure (Compare Datasets matrix / Promoter
> Definitions / Analysis Methods) + promoter/method display maps (CMP-6) [Task 6 — the largest build].
> **DEFERRED:** DEF-2 hackett filter numeric→categorical (frontend categorical-spec interaction);
> the `is_primary=False` Go-fixture case + a binding-only-target topn fixture (both want a widened fixture).
> Whole branch green: data_prep 76, backend all-ok+vet+gofmt, frontend 95/95+tsc, parity 18/18.

> **Phase A-core needs no schema bump.** Adding variant *rows*, fixing degron's column *value*,
> and changing default *values* don't alter the `dataset_manifest` *table schema*. Only the
> `log10p_col`/`neglog10p_col`/`is_primary` *columns* force schema 5→6, and those are only needed
> by the log10pval feature + variant-exposure UX (Phase C/D2) — so they move there.

**Phase A-core — dataset roster (backend/data_prep; the unblocker; non-destructive). ✅ LANDED 2026-06-11:**
1. ✅ Synced `data_prep/brentlab_yeast_collection.yaml` to the reference roster (R-1) — 21 tagged
   datasets incl. the 11 variants, `region_sets`, and the `hackett_2020`→`hackett_2020_analysis_set`
   HF-config-key rename. (Validated by the real `build_full`; the unit smoke test is `@integration`/skipped.)
2. ✅ `manifests.py::DATASET_MEASUREMENT_COLUMNS`: +11 variant entries (2-tuple, parent's columns;
   `_peaks` → `peak_score`/none) (R-2) and **degron `pvalue`→`padj`** (R-3).
   Verified: YAML parses, the YAML↔measurement-columns invariant holds (21/21), `71/71` data_prep tests green.
   Committed fixture untouched (own trimmed config; schema stays 5) → Go side unaffected.

**Phase A-defaults — first-load state (ripples into Go fixture + golden snapshots; do with a re-record):**
3. `manifests.py`: remove `harbison` from `DEFAULT_ACTIVE_DATASETS` (DEF-1); hackett default filter
   numeric `[45,45]` → categorical `[45]` (DEF-2). Update `test_build_fixture`/`test_manifests`
   assertions; rebuild `tests/fixtures/tfbp_test.duckdb`; re-run Go tests; re-record `tests/parity` +
   `/datasets` golden snapshots.

**Phase B — comparison numerical parity (backend). ✅ LANDED 2026-06-11:**
4. ✅ `topn.sql`: added the `intersecting_targets` CTE — binding targets are now intersected with
   perturbation targets *before* ranking (CMP-1). Reordered the CTEs (perturbation precedes
   `top_n_binding`) and the `buildOnePair` positional args to match. Numerically inert on the
   fixture (binding∩perturbation = all targets there), so the SQL-2 execution golden is unchanged
   — verifying equivalence on the all-shared case. (A binding-only-target regression case needs a
   widened fixture — follow-up.)
5. ✅ `comparison_topn.go`: 11 variant `bindingConfigs` entries (CMP-2; `_peaks`→`peak_score`/DESC,
   so `keepConfigured` no longer drops them) + a `?preset=Relaxed|Stringent` param with the
   per-dataset author thresholds (CMP-4/CMP-5); unknown/empty preset falls through to the request's
   numeric effect/pvalue (== today's behavior), so it's backward compatible. New tests:
   `TestResolveResponsivenessThresholds`, `TestComparisonTopN_PresetBindsAuthorThresholds`,
   `TestComparisonTopN_VariantBindingConfigsPresent`. Full backend + parity suites green; gofmt/vet clean.
   (Frontend slider→preset-radio wiring is Phase C; rank config could later move to the manifest.)

**Phase C — analysis UI + schema-6 (frontend + data_prep; gated on D2/D3 + a written plan):**
6. Schema 5→6: `log10p_col`/`neglog10p_col`/`is_primary` on `dataset_manifest`; `db.DatasetRow` +
   `startup.go` range → 6; widen fixture (representative variant + peaks + degron `padj`).
7. log10pval column support end-to-end (BIND-1/BIND-3/PERT-1) + defaults (BIND-5/BIND-6).
8. Binding correlation-matrix tab (BIND-2, +BIND-4 backend medians).
9. Comparison 3-tab restructure + promoter/method display maps (CMP-6); selector filters to `is_primary`.

**Phase D — chrome (frontend; low risk):** HOME-1/2/3 labels, CSS, loading banner.

Numerical parity (A/B) lands first and gets `tests/parity/` coverage; the UI rebuilds (C) need
design sign-off. Export (D1) is left in place pending a product decision.
