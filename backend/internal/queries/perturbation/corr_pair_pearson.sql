-- perturbation/corr_pair_pearson.sql
-- Per-regulator Pearson correlation between two perturbation datasets,
-- grouped on (regulator, sample_a, sample_b). Mirrors Shiny's shared
-- _corr_pair_sql_impl(method="pearson") called via perturbation_data_query
-- in reference/tfbpshiny/modules/perturbation/queries.py.
--
-- Template placeholders (filled in by the Go handler with whitelisted
-- identifiers + Squirrel-built filter clauses; string literals SQL-escaped):
--   {{table_a}} / {{table_b}}              — dataset table names
--   {{col_a}}   / {{col_b}}                — measurement column names
--   {{db_a_literal}} / {{db_b_literal}}    — db_name string label in output
--   {{extra_where_a}} / {{extra_where_b}}  — " AND ..." filter clauses,
--                                            empty string when no filters
--
-- Semantics (must match Shiny exactly):
--   - Inner sub-SELECTs project (regulator_locus_tag, target_locus_tag,
--     sample_id, {{col_X}}), matching binding_data_query.
--   - Shared-regulator intersect prunes work before the join.
--   - INNER JOIN on (regulator_locus_tag, target_locus_tag).
--   - NULL / Inf / NaN explicitly excluded — DuckDB corr() raises
--     OutOfRangeException on non-finite values
--     (see https://github.com/duckdb/duckdb/issues/14373).
--   - HAVING COUNT(*) >= 3 floor so corr() has at least 3 paired observations.
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
  )
SELECT
  '{{db_a_literal}}'                AS db_a,
  a.sample_id                       AS db_a_id,
  '{{db_b_literal}}'                AS db_b,
  b.sample_id                       AS db_b_id,
  a.regulator_locus_tag             AS regulator_locus_tag,
  corr(a.{{col_a}}, b.{{col_b}})    AS correlation
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
GROUP BY a.regulator_locus_tag, a.sample_id, b.sample_id
HAVING COUNT(*) >= 3
-- NOTE: no ORDER BY here — per-pair segments are combined with a UNION in
-- renderCorrUnionAllSQL, which appends one trailing ORDER BY to the assembled
-- query (an ORDER BY inside a UNION branch is a syntax error).
