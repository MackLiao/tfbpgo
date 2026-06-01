-- comparison/topn.sql
-- Per-pair template. See backend/internal/api/comparison_topn.go for the
-- list of substitution placeholders (intentionally not named here — they
-- would otherwise be replaced by strings.NewReplacer, which would spill
-- multi-line CTE bodies into the comment block and produce invalid SQL).
-- Bind parameters are passed positionally and assembled by Squirrel.

WITH binding AS (
    {{binding_cte_body}}
),
binding_ranked AS (
    SELECT
        binding_sample_id,
        regulator_locus_tag,
        target_locus_tag,
        {{rank_col}},
        RANK() OVER (
            PARTITION BY binding_sample_id
            ORDER BY {{rank_col}} {{rank_dir}}
        ) AS rnk
    FROM binding
    WHERE regulator_locus_tag != target_locus_tag
),
top_n_binding AS (
    SELECT binding_sample_id, regulator_locus_tag, target_locus_tag
    FROM binding_ranked
    WHERE rnk <= ?
),
perturbation AS (
    SELECT
        CAST(p.sample_id AS VARCHAR) AS perturbation_sample_id,
        p.regulator_locus_tag,
        p.target_locus_tag,
        {{responsive_expr}} AS is_responsive
    FROM {{perturbation_view}} p
    {{pert_join}}
    {{pert_filter_where}}
)
SELECT
    '{{pair_key}}'                                  AS pair_key,
    b.binding_sample_id                             AS binding_sample_id,
    b.regulator_locus_tag                           AS regulator_locus_tag,
    rdn.display_name                                AS regulator_display_name,
    pert.perturbation_sample_id                     AS perturbation_sample_id,
    COUNT(*)                                        AS n,
    SUM(pert.is_responsive)::INTEGER                AS n_responsive,
    SUM(pert.is_responsive)::DOUBLE / COUNT(*)      AS responsive_ratio
FROM top_n_binding b
JOIN perturbation pert
    ON  b.regulator_locus_tag = pert.regulator_locus_tag
    AND b.target_locus_tag    = pert.target_locus_tag
LEFT JOIN regulator_display_names rdn
    ON  rdn.regulator_locus_tag = b.regulator_locus_tag
GROUP BY b.binding_sample_id, b.regulator_locus_tag, rdn.display_name, pert.perturbation_sample_id
-- NOTE: no ORDER BY here — per-pair segments are combined with a UNION in
-- comparison_topn.go, which appends a single trailing ORDER BY to the assembled
-- query (an ORDER BY inside a UNION branch is a syntax error).
