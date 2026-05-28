# Perturbation

**Parity verdict:** A faithful structural port that mirrors the Binding rewrite 1:1, including the same omissions. The science layer is largely correct: the effect/pvalue measurement-column map in `data_prep` matches Shiny's `DATASET_COLUMNS` exactly (degron / hughes_* / kemmeren / hackett / hu_reimand), the `isPValueCol("pval")` heuristic and Spearman ORDER BY direction match, and the `corr_pair` / `regulator_scatter` templates reproduce `_corr_pair_sql_impl` (shared-regs `INTERSECT`, INNER JOIN on regulator+target, NULL/Inf/NaN input filter, `RANK()` partition, `HAVING COUNT>=3`, UNION-ALL across sorted pairs). The regulator-filter strip is implemented and tested.

Because the module was copied from Binding, it inherits **all** of Binding's gaps plus one perturbation-specific stale-selection bug. **No P0 here.** Multi-pair flows are visually unexercised — the fixture has a single perturbation dataset, so corr collapses to empty pairs.

> **NaN→500 — verified NON-gap.** The workflow flagged (and "empirically reproduced") a P0 where a zero-variance group 500s the whole `/perturbation/correlations` response. The DuckDB reproduction is correct in isolation, but the handler never reaches `json.Marshal` with a NaN: `perturbation_corr.go:11 → serveCorr → buildCorrResponse`, and `buildCorrResponse` drops NaN/Inf rows at `binding_corr.go:243`, mirroring Shiny's `df.dropna(subset=["correlation"])` (`workspace.py:255`). See [non-gaps.md](non-gaps.md). *(Hardening the React boxplot to also guard `pt.correlation` is a belt-and-suspenders nicety, not a gap.)*

## P1

### P-1 · Scatter SQL filters NULL/inf/nan that Shiny keeps (shared with Binding B-1)
Perturbation delegates `regulator_scatter_sql` to the shared binding impl (`perturbation/queries.py:139-151,278-300`), which is **unfiltered** (Pearson plain JOIN; Spearman RANK over all joined rows). Go's perturbation scatter templates add the finite filter on both variants (`regulator_scatter_pearson.sql:40-45`, `regulator_scatter_spearman.sql:43-48`). Spearman ranks (axis positions) and the resulting r diverge whenever a joined target has a NULL/NaN on either side. See [binding.md → B-1](binding.md#b-1--per-pair-scatter-sql-filters-nullinfnan-that-shiny-intentionally-keeps--spearman-ranksr--plotted-points-diverge).

### P-2 · No default-regulator auto-select on first load
Identical to [binding.md → B-3](binding.md#b-3--no-default-regulator-auto-select-on-first-load-and-stale-regulator-never-reconciled). Shiny auto-picks `next(iter(choices))` so scatter + overlay render immediately (`workspace.py:374-388`); React `reg` is URL-only and null on load (`Perturbation.tsx:43`), the picker has no auto-default (`ActivePairRegulatorPicker.tsx:75-91`), and the scatter row is gated on `reg && datasets.length >= 2` (`:184-202`). **Effect:** scatter grid + overlay blank until the user picks.

### P-3 · Stale selected regulator never reset when it leaves the option set
Distinct from P-2: this fires *after* a valid selection becomes invalid. Shiny recomputes choices from `_all_corr_data()` on every render and falls back to `next(iter(choices))` when the current pick is gone (`workspace.py:377-388`), immediately re-rendering for a valid regulator. React never writes a fallback — there is no `useEffect` reconciling the URL regulator against the loaded corr set (`Perturbation.tsx:42-89`). A stale tag shows the disabled placeholder (`ActivePairRegulatorPicker.tsx:80`) while `PerturbationScatterRow` still fans out fetches for it (`:50-64`) → blank scatter + empty overlay until the user re-picks.

### P-4 · Regulator gene symbols absent from picker + boxplot hover (shared with Binding B-2)
`Perturbation.tsx` renders `ActivePairRegulatorPicker` and `PerturbationCorrBoxplot` with **no** `regulatorDisplayMap` (`:153-160,176-182`), so both fall back to bare locus tags (`ActivePairRegulatorPicker.tsx:52`, `PerturbationCorrBoxplot.tsx:60-61,86,93`). Same root cause + same missing-API-path as [binding.md → B-2](binding.md#b-2--regulator-gene-symbol-display-names-never-wired-into-the-dropdown-or-boxplot-hover). `CorrPairPoint` has no display field (`generated.ts:1343-1358`); `regulatorDisplayName` exists only on `TopNRow` (`:1302`).

## P2 / cosmetic

| # | Gap | Evidence |
|---|---|---|
| P-5 | One box trace **per pair** with palette-cycled colors vs Shiny's single combined Box (uniform color) — each pair gets a different color in the rewrite | `PerturbationCorrBoxplot.tsx` vs `workspace.py` |
| P-6 | Degenerate scatter shows `r=0.000` vs Shiny `r=nan` (pandas `.corr()` on <2 pts / zero variance) | `pearsonR` vs `workspace.py` |
| P-7 | Selected-regulator overlay black dot is not click-to-select in React | `PerturbationCorrBoxplot.tsx` |
| P-8 | Exactly-one-dataset empty state renders as plain text vs Shiny's Plotly placeholder figure | `Perturbation.tsx` |
| P-9 | Regulator selector relocated from workspace body to sidebar | layout choice |
