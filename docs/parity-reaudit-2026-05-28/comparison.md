# Comparison

**Parity verdict:** In strong parity overall, and the 2026-05-21 audit's two big claims are **closed**. The plot is now a real **faceted boxplot** (one Box per `(facet, x)` group with jittered points), **not** the old heatmap — and the heatmap's silent cell-key/data-loss bug cannot recur because every `(binding_sample, regulator, pert_sample)` row contributes its own point. The TopN SQL (rank / partition / top-n / responsive-CASE / group-by) is a faithful port of `queries.py`; the per-source config maps, label maps, palettes, facet/x ordering, axis titles, hover templates, and all four sidebar controls match Shiny. **The hackett perturbation-filter-skip is correctly implemented and regression-pinned** (`comparison_topn.go:280-283` mirrors `queries.py:432`; orchestrator-confirmed). The **DTO tab is genuinely net-new** — `fetch_dto_data` has no Shiny UI consumer; `api.dto` is intentionally unconsumed. Scope decision holds.

One real numerical divergence and a set of P2/cosmetic differences remain. (There is **no P0 here.**) Note the TopN query's lack of an execution-level parity test is tracked in [sql-numerical-parity.md → SQL-2](sql-numerical-parity.md#sql-2--comparison-topn-has-no-execution-level-numerical-parity-test-p1).

## P1 / P2 — numerical

### C-1 · Harbison dedup branch applies user binding filters; Shiny drops them (P2, but numeric)
In `topn_responsive_ratio`, when `binding_dedup_cte` is set (harbison) Shiny sets `binding_cte_body = binding_dedup_cte` **verbatim** and never calls `_build_filter_where` for binding — `binding_filters[harbison]` is completely dropped (`queries.py` harbison branch).
The Go `buildOnePair` HarbisonDedup branch **injects** `filters[bDB]` into the dedup CTE via `harbisonDedupCTE(extra)` (`comparison_topn.go:212-225`). So a harbison binding filter (e.g. `pvalue` range) changes the TopN result in the rewrite but not in Shiny.
*Tension:* the inline comment claims dropping the filter "produced a parity divergence vs binding/data.sql" — but the parity target here is Shiny's **comparison** query, which deliberately ignores it. This needs a decision: match Shiny (drop) or keep the arguably-more-correct behavior and document the intentional divergence.

## P2 — behavioral

| # | Gap | Shiny | Current |
|---|---|---|---|
| C-2 | Unconfigured dataset handling | Silently skips datasets absent from `BINDING_CONFIGS`/`PERTURBATION_CONFIGS`, logs a warning, renders remaining pairs | `ComparisonTopN` returns **400** if any selected dataset lacks a config (`comparison_topn.go:86-97`) — fails the whole request |
| C-3 | Numeric filter `TRY_CAST` | `TRY_CAST("{field}" AS DOUBLE) BETWEEN` (`queries.py:129-134`) | bare `"field" >= ? AND "field" <= ?` (`comparison_topn.go:373-378`) — lexicographic on a VARCHAR-stored numeric. Shared latent issue across modules. |
| C-4 | Empty `(facet,x)` boxes | Emits a Box **unconditionally** per `x_val` (keeps the x-slot + legend), `showlegend=(col_idx==1)` | `if (points.length === 0) continue;` skips empty groups, `showlegend` only on `colIdx===0` → an x_val with data only in a non-first facet gets no legend entry |
| C-5 | `top_n` / threshold validation | `top_n() = max(1, val)` (0→1); effect/pvalue parse errors silently fall back to defaults (`sidebar.py:45-89`) | `clampTopN` returns default 25 when v<1 (0→25, not 1); effect/pvalue parse errors return **400** (`comparison_topn.go`); cap 1000 vs Shiny UI max |
| C-6 | Out-of-range threshold clamp | (clamp-and-fallback) | Backend doesn't range-clamp valid-but-out-of-range effect/pvalue (only malformed strings handled) |
| C-7 | Sidebar empty state | Replaces the four controls with a "select datasets first" message until both a binding and a perturbation dataset are active | React always renders the four controls (`ComparisonSidebar.tsx`) |

## Cosmetic

| # | Gap | Evidence |
|---|---|---|
| C-8 | No "Comparison" page heading and no "Top N by Binding" section heading (Binding has `<h1>`) | `Comparison.tsx` vs `comparison/ui.py:19,28,33` |
| C-9 | Empty/zero-data message wording differs from Shiny's two distinct empty-state strings | `Comparison.tsx` |

*See [data-prep-manifest.md](data-prep-manifest.md) for two related items: the per-source TopN config and the `BINDING_LABEL_MAP`/`PERTURBATION_LABEL_MAP` are re-hard-coded (in Go and the frontend respectively) rather than carried in the artifact, and the frontend label maps can drift from `dataset_manifest.display_name`.*
