# Verified non-gaps — confirmed FINE, do not re-investigate

These were flagged as candidate gaps and then **adversarially verified to be non-divergences**. Recording them so future passes don't waste effort, and so reviewers know what is *actually* at parity.

## 1 · Home feature-card images — full parity
Shiny's `_feature_card` renders a 100×100 `object-fit:contain` img for Binding/Perturbation and omits it for Dataset-selection/Comparison (`home/ui.py:45-58,88-113`). React `FeatureCard` does the same with identical styling and the same image-bearing/image-less split (`Home.tsx:11-34,58-79`). The images are **byte-identical** — `cmp` reports IDENTICAL and sha256 matches between `frontend/public/` and `reference/tfbpshiny/www/` (binding `c7e7a54b…`, perturbation `94d7d7fc…`). Vite has no `publicDir`/`base` override, so `/binding.png` resolves correctly.
*Side note (not a source divergence):* the committed `backend/static/dist/` is stale and contains no PNGs — a generated artifact that `npm run build` regenerates from the correct source.

## 2 · `plot_formatter.py` — dead code in Shiny; React matches the *runtime* figures
`grep -rn plot_formatter reference/` returns exactly one hit (the `def` at `plot_formatter.py:8`) — it is never imported or called. The real Shiny runtime figures are hand-built with **different** styling than the dead helper (binding `workspace.py:340-345` margins `l40/r20/t50/b80`, `showlegend=False`; comparison `:319-322` margins `l50/r20/t80/b30` + dynamic legend title). React replicates the **runtime** figures exactly (`BindingCorrBoxplot.tsx:208`, `ComparisonBoxplot.tsx:56,145-146`), including the dynamic legend title the dead helper would have gotten wrong. **Porting `plot_formatter` would *introduce* a divergence.** No gap.

## 3 · `ratelimit.py` debounce/throttle — unused in Shiny; correctly absent in Go
`ratelimit.py` defines `debounce()`/`throttle()` (`:20-114`) but **zero** `@debounce`/`@throttle` applications or imports exist across the Shiny module code (the only `@debounce(0.3)` is a stale doc snippet in `reference/docs/development.md:179`). Shiny instead handles click-storms via the staged-Apply commit (`select_datasets/server/sidebar.py:679-691`), which the React SPA reproduces (`Select.tsx:577-598`). The Go backend's stateless-per-request + `MaxOpenConns=2` + singleflight + ristretto model structurally replaces the single-shared-asyncio-event-loop failure mode `ratelimit.py` guarded against; it also has `RequestGuard` (`request_guard.go:30-67`, `MaxQueryKeys=32`). Since Shiny never applies these decorators, there is nothing to be in parity with. No gap.

## 4 · `sample_conditions` hover-label *mechanism* — fully ported (both Binding & Perturbation)
`build_condition_label` joins non-empty/non-NaN trimmed values with ` / ` (`sample_conditions.py:38-49`); `fetch_sample_condition_map` queries `{db}_meta` and omits empty-label samples (`:82-94`); the overlay hovertext appends one HTML-escaped condition line per dataset joined with `<br>` (`workspace.py:295-306`). The Go handler (`sample_conditions.go:102-146`) and **both** React routes (`Binding.tsx:106-120`, `Perturbation.tsx:105-110` → `BindingCorrBoxplot.tsx:132-145`, `PerturbationCorrBoxplot.tsx:131-145`, `html-escape.ts:10-17`) mirror this exactly. The original finding named only Binding; Perturbation is wired identically, so the claim was if anything understated.

> **But:** this is the **mechanism** only. The **column set** fed into it is wrong for hackett/harbison/chec_m2025 — see [data-prep-manifest.md → DM-1](data-prep-manifest.md#dm-1--condition_cols-includes-hidden-fields--wrong-sample-hover-labels). Correct pipe, wrong input.

## 5 · NaN/Inf correlation → 500 — FIXED by `9cbc3ae` (the workflow's withdrawn P0)
The multi-agent workflow flagged this as a P0 across binding/perturbation/sql-parity (and "empirically reproduced" the DuckDB NaN + `json.Marshal` failure). It was a **real latent bug** — but commit `9cbc3ae` landed the fix *during* this audit, which is why an agent reading early saw no guard and the orchestrator's later read did. As of HEAD it is fully closed and **generalized beyond the corr path**:
- `buildCorrResponse` drops NaN/Inf correlation rows at `binding_corr.go:243` (`if math.IsNaN(row.Correlation) || math.IsInf(row.Correlation, 0) { continue }`), mirroring Shiny's `df.dropna(subset=["correlation"])`.
- New `domain.SafeFloat` (`domain/safefloat.go`) marshals non-finite values as JSON `null` and is applied to `BindingRow.Value`, `PerturbationRow.Value`, `DTORow.{DTOEmpiricalPValue,DTOFDR}`, `TopNRow.ResponsiveRatio` — so the **data tabs, DTO, and TopN** non-finite paths (which this audit did not even flag) are closed too.
- Pinned by `domain/safefloat_test.go` + `real_data_regression_test.go`, with a harbison IEEE-NaN cell + zero-variance column added to the fixture.

Do not chase it. (A SQL-level outer `WHERE NOT isnan(correlation)` would be belt-and-suspenders, not required.)

## Also confirmed closed (orchestrator hand-verified, vs the 2026-05-21 audit's P0 claims)
- **Correlation `corr_pair` SQL** (Pearson + Spearman) is a faithful port of `_corr_pair_sql_impl` — CTE structure, shared-regulator `INTERSECT`, NULL/Inf/NaN exclusion, `RANK()`-based Spearman with effect-vs-pvalue ORDER BY, `HAVING COUNT(*) >= 3`. (`corr_pair_*.sql` vs `binding/queries.py:201-288`.)
- **Comparison plot is a faceted boxplot, not the old heatmap** — the heatmap's cell-key/data-loss bug cannot recur.
- **Comparison hackett perturbation-filter-skip** matches `queries.py:432` (`comparison_topn.go:280-283`) and is regression-pinned.
- **DTO tab is genuinely net-new** — `fetch_dto_data` has no Shiny UI consumer; the scope decision holds.
- **schema_version=4 manifest plumbing** is complete and consumed end-to-end.
