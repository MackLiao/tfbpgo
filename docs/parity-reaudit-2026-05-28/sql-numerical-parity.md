# SQL / Numerical Parity

**Parity verdict:** The highest-risk area per the spec, and the rewrite holds up well on the central queries. The **correlation `corr_pair` templates** (Pearson + Spearman) are a near-line-for-line port of Shiny's `_corr_pair_sql_impl` — shared-regulator `INTERSECT`, INNER JOIN on `(regulator, target)`, NULL/Inf/NaN input exclusion, `RANK()`-based Spearman with effect-vs-pvalue ORDER BY direction, and `HAVING COUNT(*) >= 3` (orchestrator-verified directly). The eight correlation templates are pinned by `correlation_parity_test.go`. But the **scatter** path diverges (filters values Shiny keeps), the **boxplot** path 500s on NaN (P0), a **view-level hackett filter** is entirely missing, and the **TopN** query — the most complex numerical query in the app — has **no execution-level parity test**.

> **Spearman tie-handling note:** Shiny uses DuckDB `RANK()` (not scipy's average-rank ties), and the Go port uses `RANK()` too — so the rewrite matches the **parity target** (Shiny). Both diverge from scipy's `spearmanr`, but that is out of scope; parity is with the running app, and it is correct.

## P0

**None.** The corr SQL is faithful and the one alleged P0 (NaN→500) is a verified non-gap.

> **SQL-P0 (withdrawn) · NaN `corr()` → 500.** True that `corr_pair_*.sql` filters non-finite *inputs* (`corr_pair_pearson.sql:59-64`, `corr_pair_spearman.sql:65-70`) but not the `corr()` *output*, so a zero-variance group emits NaN. **But the Go handler drops it before serialization** — `buildCorrResponse` skips NaN/Inf rows at `binding_corr.go:243` (mirroring Shiny's `df.dropna`), so it never reaches `json.Marshal`. No 500. See [CRITICAL.md](CRITICAL.md) / [non-gaps.md](non-gaps.md). *(A SQL-level outer `WHERE NOT isnan(correlation)` would be a defense-in-depth nicety, but is not required for parity.)*

## P1

### SQL-1 · Hackett views never filtered to the analysis set (the missed view-level divergence)
Shiny's `ensure_hackett_analysis_set` (`vdb_init.py:159-160`) builds `hackett_analysis_set` **and then** calls `_filter_hackett_views` (`vdb_init.py:120-146`), which **permanently rewrites the `hackett` and `hackett_meta` views** to `WHERE sample_id IN (SELECT sample_id FROM hackett_analysis_set)`. So in Shiny **every** query against hackett — perturbation data tab, perturbation correlation, select-datasets regulator listing / sample counts / breakdown — sees only analysis-set samples.

The rewrite reproduces only the analysis-set **table** (`materialize.py:101-103`, `build_duckdb.py:59-64`) and **never re-filters** the materialized `hackett`/`hackett_meta` tables (`materialize_views_as_tables`, `materialize.py:91-98`, materializes all rows; no `_filter_hackett_views` equivalent anywhere in `data_prep` or Go). Grep confirms `hackett_analysis_set` is referenced **only** by `comparison/dto.sql:12` and `comparison_topn.go:298` — both correct. Every other Go surface queries hackett raw:
- `select_datasets.go:327` (regulators), `:456/:557` (matrix diagonal/cross sample counts), `:706` (breakdown)
- `perturbation/data.sql:10`

**Effect:** for hackett, the Go service surfaces non-analysis-set samples (extra mechanism/restriction/time/date rows per regulator) that Shiny suppresses → wrong sample counts, wrong breakdown, extra correlation sample-pairs, extra perturbation-tab rows. The fixture even bakes this in: `build_fixture.py:202-203` adds `h_3` (GEV/M, excluded from the analysis set) to `hackett_meta`, and the team pinned a test to the divergent behavior (`STATUS-C.md:339` "filtered callingcards ∩ unfiltered hackett").

**Severity re-scoped P0→P1 by the verifier:** the comparison-tab science (DTO + topn) *is* correctly analysis-set-filtered, so the headline numbers aren't broken; the breakage is confined to the perturbation tab + select-datasets metadata for the single hackett dataset. Prior audits caught only the narrower comparison `hackett_time_filter` skip (`queries.py:432`, now fixed) and **missed the view-level filter entirely**.

**Fix:** add a `_filter_hackett_views` equivalent in `data_prep` (materialize hackett/hackett_meta with the analysis-set WHERE) so every downstream query inherits it — matching Shiny's "filter once at init" model.

### SQL-2 · Comparison TopN has no execution-level numerical parity test (P1)
`topn_responsive_ratio` computes `n`, `n_responsive`, `responsive_ratio = SUM(is_responsive)::DOUBLE/COUNT(*)` over the top-N `RANK()`-selected binding targets, with the responsive CASE, the `regulator != target` exclusion, the CC target blacklist, the harbison `MIN(pvalue)` dedup, and the hackett `time=45` JOIN (`queries.py:284-332`) — driving the percent-responsive boxplot.

It is **untested numerically.** `comparison_topn_test.go:3-4` still says happy-path tests await "fixtures with production columns" — but those columns now **exist** (`build_fixture.py:64-178`: callingcards has `poisson_pval` + `callingcards_enrichment` + `sample_id`, hackett has `log2_shrunken_timecourses`), so a `callingcards×hackett` execution test is buildable. Every existing topn test is non-executing: placeholder-count invariants (`:86-109,202-224`), rendered-SQL substring checks (`:118-188,264-282`), `buildResponsiveExpr` string equality (`:229-262`), 400 rejections (`:47-63`). None call `buildTopNResponse`/`SelectContext` or assert a single `n`/`n_responsive`/`responsive_ratio`. By contrast the matrix + breakdown handlers **are** pinned with expected counts (`select_datasets_test.go:129-165,280-328`), and the 8 corr templates are pinned (`correlation_parity_test.go`). TopN — strictly more moving parts — is the one numerically load-bearing query with **zero value coverage.**

## P2

| # | Gap | Evidence |
|---|---|---|
| SQL-3 | Scatter path filters NULL/inf/nan Shiny keeps (Spearman ranks/r diverge) — full detail in [binding.md → B-1](binding.md#b-1--per-pair-scatter-sql-filters-nullinfnan-that-shiny-intentionally-keeps--spearman-ranksr--plotted-points-diverge) | `regulator_scatter_*.sql` vs `binding/queries.py:455-475` |
| SQL-4 | Numeric filters use bare `>=`/`<=` vs Shiny `TRY_CAST(... AS DOUBLE) BETWEEN` — only bites on a numeric filter over a VARCHAR-stored column | `binding.go:147-150`, `comparison_topn.go:377-378` vs `queries.py:111-115` etc. |
| SQL-5 | `regulator_display_names` uses `MIN(regulator_symbol)` in data_prep vs `FIRST(regulator_symbol)` in Shiny — label divergence only for a locus tag mapping to multiple distinct symbols | `materialize.py:68` vs `vdb_init.py:169` |
| SQL-6 | Scatter `r` computed two different ways (Go `pearsonR` single-pass vs Shiny `pandas.Series.corr`) with no value-parity test pinning them | `correlation.go:265` vs `workspace.py:569` |

**Highest-leverage parity action overall:** widen the fixture to ≥2 datasets per data_type with (a) a zero-variance regulator group, (b) a non-finite measurement value, (c) a hackett non-analysis-set row already present, and (d) a >1-regulator off-diagonal cell. That single change turns SQL-P0, SQL-1, SQL-2, SQL-3 and the Select-Datasets P0 into hard test failures instead of latent production bugs.
