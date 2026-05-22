# Parity Inventory — Source of Truth

**Generated:** 2026-05-21
**Purpose:** Map every user-visible feature in the Python Shiny app (`reference/tfbpshiny`) against the in-progress Go + React rewrite. This is the source of truth for implementation planning.

## Reports

| Module | File | Lines | Headline gap |
|---|---|---|---|
| Home | [home.md](home.md) | 87 | Cosmetic (cards → bullet list, missing illustrations + nav chrome). No backend work. |
| Select Datasets | [select_datasets.md](select_datasets.md) | 129 | Almost nothing implemented — filter modal, intersection matrix, defaults, Apply gate all missing. Needs 5 new backend endpoints + `schema_version=3`. |
| Binding | [binding.md](binding.md) | 219 | Wrong plots entirely — Shiny shows per-pair correlation boxplot + scatter grid; React shows a single bare scatter. Needs `/binding/corr`, `/binding/scatter` endpoints + Pearson/Spearman SQL. |
| Perturbation | [perturbation.md](perturbation.md) | 179 | Same shape as Binding — entire correlation + per-pair scatter UI missing; current "volcano" is a placeholder. Needs `/perturbation/correlations`, `/perturbation/scatter`. |
| Comparison | [comparison.md](comparison.md) | 194 | Wrong plot type (heatmap vs faceted boxplot), missing 4 sidebar controls, last-write-wins data loss bug, hackett-filter divergence. Mostly frontend; one backend patch. |

## Headline assessment

**The rewrite is structurally complete but functionally early.** Routes exist, the API surface is in place, and the build pipeline ships. But the *behavior* inside each page is largely stubbed or wrong:

- **Home**: cosmetic regression only.
- **Select Datasets, Binding, Perturbation**: the actual analytical experience (filter modal, correlation plots, per-pair scatter grids, sidebar controls) does **not exist** on the React side. The current pages render placeholder visualizations against a smaller set of endpoints than the science requires.
- **Comparison**: the React page renders a *different plot* than Shiny and has a silent data-loss bug in cell keying.

Your gut read ("nothing to do with what I wanted") is accurate for the three core analytical modules.

## Scope clarification: DTO is net-new, not parity

The Go backend exposes `/api/v/1/comparison/dto` and the React app renders a `DTOPlot` tab. **Neither has a Shiny equivalent** — `fetch_dto_data` is defined in `reference/tfbpshiny/modules/comparison/queries.py:69` but has zero references in any other Shiny file (verified). Treat the DTO tab as **net-new product**, not parity work. Decide separately whether to keep, defer, or drop it; do not let it consume Phase A/B budget.

## Cross-cutting backend gaps

These show up in multiple module reports — fixing once unblocks several modules:

| Gap | Blocks | Effort |
|---|---|---|
| `schema_version=3` bump in `data_prep/` — move effect/p-value/condition column maps from hard-coded Go into `field_manifest` / `dataset_manifest` | Select, Binding, Perturbation | Medium (Python + Go startup + parity tests) |
| Pearson/Spearman correlation SQL (`corr_pair.sql` is currently a placeholder) | Binding, Perturbation | Medium (must match Shiny's `HAVING COUNT(*) >= 3`, NaN/Inf/NULL handling, rank-based for Spearman) |
| Sample-condition labels exposed via API (`{db}_meta` lookup) | Binding, Perturbation (hover tooltips), Select (default filter values) | Small |
| Plotly bundle: register `box` trace type | Binding, Perturbation, Comparison | Trivial (one line; remeasure gzip budget) |
| Hackett filter skip (mirror `queries.py:432` — skip `perturbation_filters` for hackett) | Comparison | Trivial (1-line bugfix) |

## Recommended implementation order

The audits suggest a **3-phase plan**, ordered by dependency and shippable increments:

### Phase A — Backend foundations (1–2 weeks)

Everything analytical depends on these. Ship before any UI work.

1. **`schema_version=3`** — externalize effect/p-value/condition column maps to manifests (Phase 1.6 from CLAUDE.md). Includes Python build + Go startup assertions + parity tests.
2. **Pearson/Spearman correlation endpoints** — `/api/v/1/binding/corr`, `/api/v/1/perturbation/correlations`. Numerical parity tests vs the Shiny reference are mandatory before shipping.
3. **Per-pair scatter endpoints** — `/api/v/1/binding/scatter`, `/api/v/1/perturbation/scatter` (joined values or ranks).
4. **Select Datasets supporting endpoints** — field metadata, filter levels, dataset intersection matrix, breakdown.
5. **Comparison hackett-filter fix** — 1-line patch + regression test.

### Phase B — Restore the three broken modules (3–4 weeks)

Frontend-heavy. One module at a time, fully shippable per module.

1. **Comparison** — easiest of the three; backend already mostly there. Replace heatmap with faceted boxplot, wire sidebar controls, fix cell-keying bug, add label maps + palette.
2. **Binding** — pairwise correlation boxplot + per-pair scatter grid + sidebar (Effect/P-value, Pearson/Spearman radios) + click-to-pick-regulator interaction.
3. **Perturbation** — same shape as Binding; should be a fast follow once Binding's pattern is established.
4. **Select Datasets** — filter modal, intersection matrix, default selections, Apply gate (pending vs committed selection state).

### Phase C — Polish (1 week)

1. **Home** — restore Bootstrap-style cards, drop illustrations into `frontend/public/`, fix nav chrome + version pill.
2. **Cross-page** — wine-red theming, three-line logo, GitHub badge.
3. **Plot polish** — hover tooltip parity, legend behavior, axis title parity across all modules.

## Getting a real `tfbp.duckdb` for parity work

The committed test fixture (`tests/fixtures/tfbp_test.duckdb`) is enough to boot the Go service, but parity work needs **the same data the Shiny app sees**. Easiest path: run `../tfbpshiny` locally once to populate the HuggingFace cache, then build the Go artifact off that cache without needing `HF_TOKEN`. See [`data_prep/README.md` → "Reusing the tfbpshiny HuggingFace cache"](../../data_prep/README.md#reusing-the-tfbpshiny-huggingface-cache-no-hf_token-needed) for the exact commands.

## How to use this document

- **Before implementing anything**, open the relevant module's `.md` and read sections 2 (feature matrix), 3-4 (controls + plots), and 9 (backend gaps).
- **When proposing a plan**, cite specific row numbers from the feature matrix as acceptance criteria.
- **When something is unclear**, check section 8 / "Open questions" — those need a human decision before code.
- **Don't trust the audits blindly**: they were generated by parallel agents in one pass. If something looks wrong while implementing, re-read the Shiny source (cited with `file:line` throughout) and update the markdown.

## Review status

**Audits verified 2026-05-21** against the actual code. Spot-checks confirmed every P0 claim across all 5 reports — placeholder SQL files, plot stubs, the ComparisonHeatmap data-loss bug, the hackett-filter divergence between `queries.py:432` and `comparison_topn.go:271`, and the absence of sidebar controls in all three analytical modules. The DTO scope clarification above was the only material addition. **No factual corrections to the per-module audits were needed.**

## Next step

Pick one of:
1. **Brainstorm + write a Phase A plan** (recommended — backend is the gate).
2. **Spike on one specific module** to validate the audit before committing to the plan.
3. **Refine the audits** if anything in them looks wrong from your domain knowledge.
