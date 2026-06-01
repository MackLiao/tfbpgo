-- perturbation/corr_pair_spearman.sql
-- Per-regulator Spearman correlation between two perturbation datasets.
-- Mirrors Shiny's shared _corr_pair_sql_impl(method="spearman") called via
-- perturbation_data_query in
-- reference/tfbpshiny/modules/perturbation/queries.py.
--
-- Spearman = Pearson on RANK() of each side's values, partitioned by
-- (regulator, db_a_id, db_b_id). The ORDER BY direction depends on whether
-- the column is an effect (rank by ABS(value) DESC — largest magnitude wins)
-- or a p-value (rank by value ASC — smallest p-value wins). Because the
-- template cannot inspect the column name at SQL-render time, the caller
-- supplies the full ORDER BY expression via {{order_a_expr}} /
-- {{order_b_expr}}; valid forms are exactly:
--   ABS(val_a) DESC | val_a ASC
--   ABS(val_b) DESC | val_b ASC
-- (The Go handler picks based on `is_pvalue := strings.Contains(strings.ToLower(col), "pval")`,
-- matching Shiny's choice in _corr_pair_sql_impl.)
--
-- Template placeholders:
--   {{table_a}} / {{table_b}}              — dataset table names
--   {{col_a}}   / {{col_b}}                — measurement column names
--   {{db_a_literal}} / {{db_b_literal}}    — db_name string label in output
--   {{extra_where_a}} / {{extra_where_b}}  — " AND ..." filter clauses
--   {{order_a_expr}} / {{order_b_expr}}    — ORDER BY expression (whitelisted)
--
-- Semantics (must match Shiny exactly):
--   - INNER JOIN on (regulator_locus_tag, target_locus_tag).
--   - NULL / Inf / NaN excluded in the `joined` CTE before ranking.
--   - RANK() partitioned by (regulator, db_a_id, db_b_id).
--   - HAVING COUNT(*) >= 3 floor on the post-rank grouping.
WITH
  a_raw AS (
    SELECT regulator_locus_tag, target_locus_tag, sample_id, {{col_a}}
    FROM {{table_a}}
    WHERE 1=1 {{extra_where_a}}
  ),
  b_raw AS (
    SELECT regulator_locus_tag, target_locus_tag, sample_id, {{col_b}}
    FROM {{table_b}}
    WHERE 1=1 {{extra_where_b}}
  ),
  shared_regs AS (
    SELECT DISTINCT regulator_locus_tag FROM a_raw
    INTERSECT
    SELECT DISTINCT regulator_locus_tag FROM b_raw
  ),
  a AS (
    SELECT * FROM a_raw
    WHERE regulator_locus_tag IN (SELECT regulator_locus_tag FROM shared_regs)
  ),
  b AS (
    SELECT * FROM b_raw
    WHERE regulator_locus_tag IN (SELECT regulator_locus_tag FROM shared_regs)
  ),
  joined AS (
    SELECT
      a.regulator_locus_tag,
      a.sample_id  AS db_a_id,
      b.sample_id  AS db_b_id,
      a.{{col_a}}  AS val_a,
      b.{{col_b}}  AS val_b
    FROM a
    INNER JOIN b
      ON a.regulator_locus_tag = b.regulator_locus_tag
     AND a.target_locus_tag    = b.target_locus_tag
    WHERE a.{{col_a}} IS NOT NULL
      AND b.{{col_b}} IS NOT NULL
      AND NOT isinf(a.{{col_a}})
      AND NOT isinf(b.{{col_b}})
      AND NOT isnan(a.{{col_a}})
      AND NOT isnan(b.{{col_b}})
  ),
  ranked AS (
    SELECT
      regulator_locus_tag,
      db_a_id,
      db_b_id,
      RANK() OVER (
        PARTITION BY regulator_locus_tag, db_a_id, db_b_id
        ORDER BY {{order_a_expr}}
      ) AS rank_a,
      RANK() OVER (
        PARTITION BY regulator_locus_tag, db_a_id, db_b_id
        ORDER BY {{order_b_expr}}
      ) AS rank_b
    FROM joined
  )
SELECT
  '{{db_a_literal}}'    AS db_a,
  db_a_id,
  '{{db_b_literal}}'    AS db_b,
  db_b_id,
  regulator_locus_tag,
  corr(rank_a, rank_b)  AS correlation
FROM ranked
GROUP BY regulator_locus_tag, db_a_id, db_b_id
HAVING COUNT(*) >= 3
-- NOTE: no ORDER BY here — per-pair segments are combined with a UNION in
-- renderCorrUnionAllSQL, which appends one trailing ORDER BY to the assembled
-- query (an ORDER BY inside a UNION branch is a syntax error).
