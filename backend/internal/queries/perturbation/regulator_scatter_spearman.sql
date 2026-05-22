-- perturbation/regulator_scatter_spearman.sql
-- Per-target rank pairs for a single regulator (perturbation side). Mirrors
-- the perturbation analogue of Shiny's regulator_scatter_sql(method="spearman")
-- in reference/tfbpshiny/modules/binding/queries.py.
--
-- The qualified aliases (val_a, val_b) are projected by the `joined` CTE
-- so the outer ORDER BY is unambiguous even when col_a == col_b (e.g.
-- both datasets use poisson_pval) — see Shiny note on
-- regulator_scatter_sql.
--
-- The caller chooses the ORDER BY direction:
--   {{order_a_expr}}: ABS(val_a) DESC  | val_a ASC
--   {{order_b_expr}}: ABS(val_b) DESC  | val_b ASC
-- per the is_pvalue check in Shiny (effect → ABS DESC, p-value → ASC).
--
-- Template placeholders:
--   {{table_a}} / {{table_b}}              — dataset table names
--   {{col_a}}   / {{col_b}}                — measurement column names
--   {{extra_where_a}} / {{extra_where_b}}  — " AND ..." filter clauses
--                                            (must NOT contain regulator_locus_tag)
--   {{order_a_expr}} / {{order_b_expr}}    — ORDER BY expression (whitelisted)
--
-- Positional bind args: 1) regulator (a side), 2) regulator (b side)
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
  ),
  joined AS (
    SELECT
      a.target_locus_tag AS target_locus_tag,
      a.{{col_a}}        AS val_a,
      b.{{col_b}}        AS val_b
    FROM a
    INNER JOIN b
      ON a.target_locus_tag = b.target_locus_tag
  )
SELECT
  target_locus_tag,
  RANK() OVER (ORDER BY {{order_a_expr}}) AS val_a,
  RANK() OVER (ORDER BY {{order_b_expr}}) AS val_b
FROM joined
