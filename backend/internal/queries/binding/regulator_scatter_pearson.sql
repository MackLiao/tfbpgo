-- binding/regulator_scatter_pearson.sql
-- Per-target (val_a, val_b) pairs for a single regulator — used to render
-- the regulator-level scatter plot in the comparison module. Mirrors
-- Shiny's regulator_scatter_sql(method="pearson") in
-- reference/tfbpshiny/modules/binding/queries.py.
--
-- The handler is responsible for stripping `regulator_locus_tag` from the
-- caller-supplied filter dict before rendering {{extra_where_*}}, matching
-- Shiny's workspace.py:536-540 strip-regulator-from-filter logic. The
-- regulator itself is bound twice via positional `?` (once per subquery).
--
-- Template placeholders:
--   {{table_a}} / {{table_b}}              — dataset table names
--   {{col_a}}   / {{col_b}}                — measurement column names
--   {{extra_where_a}} / {{extra_where_b}}  — " AND ..." filter clauses
--                                            (must NOT contain regulator_locus_tag)
--
-- Positional bind args (in order):
--   1) regulator (a side), 2) regulator (b side)
WITH
  a AS (
    SELECT regulator_locus_tag, target_locus_tag, sample_id, {{col_a}}
    FROM {{table_a}}
    WHERE regulator_locus_tag = ? {{extra_where_a}}
  ),
  b AS (
    SELECT regulator_locus_tag, target_locus_tag, sample_id, {{col_b}}
    FROM {{table_b}}
    WHERE regulator_locus_tag = ? {{extra_where_b}}
  )
SELECT
  a.target_locus_tag AS target_locus_tag,
  a.{{col_a}}        AS val_a,
  b.{{col_b}}        AS val_b
FROM a
INNER JOIN b
  ON a.target_locus_tag = b.target_locus_tag
