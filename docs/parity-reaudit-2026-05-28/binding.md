# Binding

**Parity verdict:** Substantially implemented and far closer to parity than the 2026-05-21 audit suggested. The sidebar (Effect/P-value + Pearson/Spearman radios, URL-backed), the per-pair correlation boxplot with jittered points + selected-regulator black-dot overlay + click-to-pick, the active-pair-scoped regulator picker, the per-pair scatter grid (400×400, flex-wrap, `r=` annotation, axis labels), and the "regulator not found in" notice are all present and structurally match Shiny. **The core correlation `corr_pair` SQL is a faithful port** — shared-regulator `INTERSECT`, NULL/inf/nan input exclusion, `HAVING COUNT(*) >= 3`, and rank-direction (`ABS DESC` vs `ASC`) logic verified line-for-line (orchestrator-confirmed).

Remaining gaps: two P1 divergences (one numeric in the **scatter** path, one UX), the shared symbol/default-regulator gaps, plus cosmetics. **No P0 here.** Multi-pair flows are visually unexercised (single-dataset fixture).

> **NaN→500 — verified NON-gap.** The workflow flagged a P0 that the boxplot `corr()` path 500s on a zero-variance (NaN) group. Direct inspection refutes it: `buildCorrResponse` (the shared body of `/binding/corr` and `/perturbation/correlations`) drops NaN/Inf rows at `binding_corr.go:243` (`if math.IsNaN(row.Correlation) || math.IsInf(row.Correlation, 0) { continue }`), explicitly mirroring Shiny's `df.dropna`. See [non-gaps.md](non-gaps.md) and [CRITICAL.md](CRITICAL.md).

## P1

### B-1 · Per-pair SCATTER SQL filters NULL/inf/nan that Shiny intentionally keeps → Spearman ranks/r + plotted points diverge
This is the subtle one. Shiny's **corr_pair** path filters non-finite values *only because DuckDB `corr()` raises on them* (explicit comment, `binding/queries.py:196-199`). But Shiny's **scatter** path (`regulator_scatter_sql`) uses pandas, not DuckDB `corr()`, and is **deliberately unfiltered**:
- Pearson scatter: plain `JOIN`, no value filter (`queries.py:471-475`).
- Spearman scatter: the `joined` CTE has **no WHERE**, so NULL/inf targets participate in `RANK() OVER (ORDER BY …)` (`queries.py:455-469`).
- Displayed `r` = `merged["_val_a"].corr(merged["_val_b"])` (pandas, drops NaN pairwise) (`workspace.py:569`); raw `_val_a/_val_b` plotted (`:574-575`).

The Go scatter templates **add** the six-clause finite filter:
- `regulator_scatter_pearson.sql:38-43` (outer SELECT)
- `regulator_scatter_spearman.sql:43-48` — **inside the `joined` CTE, before `RANK()`** at `:52-53`.
- `buildScatterResponse` computes `R` via `pearsonR(points)` over the already-filtered points for both methods (`binding_corr.go:405`, `correlation.go:265`).

**Effect:** (1) **Spearman** — filtering before `RANK()` shifts ranks for any regulator with a NULL/inf/nan target → diverges both plotted points *and* the server r. (2) **Pearson** — for NULL/NaN the r still matches (pandas drops pairwise) but the plotted point set drops rows Shiny renders as gaps; for `inf`, pandas propagates `inf→NaN` (`r=nan`) while Go yields a finite r — even the r diverges.

This was **deliberately introduced**: `TestScatterSQL_HasNullInfNaNFilter` (`correlation_fixups_test.go:36-60`) asserts the filter is present, with a comment treating it as "the same shape as the corr_pair filter" — a misapplication, since Shiny does not filter the scatter path. Never caught end-to-end because the fixture is finite-by-construction. **Mirrored identically in the perturbation scatter templates** (see [perturbation.md](perturbation.md)). Violates the non-negotiable numerical-parity rule (CLAUDE.md), but data-dependent → P1 not P0.

### B-2 · Regulator gene-symbol display names never wired into the dropdown or boxplot hover
Shiny builds `sym_map = {locus_tag: "SYMBOL (LOCUS_TAG)"}` at server init from `regulator_display_names` (`vdb_init.py:165-180`, `workspace.py:71-74`) and uses it everywhere: dropdown choices labeled `sym_map.get(r,r)` sorted case-insensitively by symbol (`workspace.py:393-394`); box all-points hover (`:281-285,313`); selected-regulator overlay hover line 1 (`:295,306`).

The React `regulatorDisplayMap` prop **exists** on `ActivePairRegulatorPicker` (`:29,52`) and `BindingCorrBoxplot` (`:26,63-64,89,96`) but `Binding.tsx` **never passes it** (`:158-163`, `:179-185`), so both fall back to the bare locus tag. **And no endpoint can supply the map even if it tried:** `/binding/corr` carries no symbol (`domain/correlation.go:7-14` `CorrPairPoint` has only `RegulatorLocusTag`); `/regulators/resolve` returns `[]string` of locus tags (`regulators_resolve.go:22-25,206`); `/regulators` returns `{locusTag,displayName}` but only for ≤limit typeahead hits (`regulators.go:21-24,34-43`). `regulator_display_names` is only LEFT-JOINed for Comparison topn (`comparison/topn.sql:52`) and the capped search (`search.sql:5`).
**Effect:** dropdown + box/overlay hovers show `YBR289W` instead of `CBF1 (YBR289W)`, and the dropdown loses Shiny's symbol-sort order. Shared with perturbation. Fix needs a bulk-regulator fetch or a corr-response extension, not a one-line prop pass.

### B-3 · No default-regulator auto-select on first load (and stale regulator never reconciled)
Shiny's `regulator_selector` sets `default = current if current in choices else next(iter(choices))` (`workspace.py:400`), so the moment ≥2 binding datasets are active, the scatter grid **and** the black-dot overlay render immediately. React `reg` is purely URL-sourced (null on load); `ActivePairRegulatorPicker` renders a disabled "Select a regulator" placeholder with no auto-select `useEffect` (`:75-91`), and the scatter row is gated on `reg && datasets.length >= 2` (`Binding.tsx:193`). **Effect:** on first load the boxplot shows but the scatter grid and overlay are **blank** until the user manually picks. (Perturbation has the same gap plus a stale-selection variant — see [perturbation.md](perturbation.md).)

## P2 / cosmetic

| # | Gap | Evidence |
|---|---|---|
| B-4 | Single-point / zero-variance scatter reports `r=0.000`; Shiny shows `r=nan` (`pearsonR` returns 0 when n<2 or denom≈0) | `correlation.go` pearsonR vs `workspace.py` pandas `.corr()` |
| B-5 | Empty pairs render a blank box category instead of being omitted | `BindingCorrBoxplot.tsx` |
| B-6 | One `go.Box` trace **per pair** vs Shiny's single combined Box keyed by category (visually equivalent — jitter 0.4, pointpos 0, boxpoints all) | `BindingCorrBoxplot.tsx:83-123` vs `workspace.py:255-324` |
| B-7 | Fixed plot heights (360 empty / 420 populated) vs Shiny's auto-height; margins + empty-state text otherwise match | `BindingCorrBoxplot.tsx:174,206` vs `workspace.py:340-345` |
| B-8 | Regulator selector relocated from workspace body into the sidebar | layout choice |
