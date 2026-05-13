SELECT
    d.binding_id_source,
    d.perturbation_id_source,
    d.dto_empirical_pvalue,
    d.dto_fdr,
    d.binding_set_size,
    d.perturbation_set_size,
    CAST(d.binding_id_id   AS VARCHAR)    AS binding_sample_id,
    CAST(d.perturbation_id_id AS VARCHAR) AS pert_sample_id,
    COALESCE(CAST(h.time AS VARCHAR), 'standard') AS time
FROM dto_expanded d
LEFT JOIN hackett_analysis_set h
    ON  d.perturbation_id_source = 'hackett'
    AND CAST(d.perturbation_id_id AS VARCHAR) = CAST(h.sample_id AS VARCHAR)
LEFT JOIN (
    SELECT DISTINCT sample_id FROM callingcards
) cc
    ON  d.binding_id_source = 'callingcards'
    AND CAST(d.binding_id_id AS VARCHAR) = CAST(cc.sample_id AS VARCHAR)
LEFT JOIN (
    SELECT DISTINCT sample_id FROM harbison WHERE condition = 'YPD'
) harb
    ON  d.binding_id_source = 'harbison'
    AND CAST(d.binding_id_id AS VARCHAR) = CAST(harb.sample_id AS VARCHAR)
WHERE
    d.pr_ranking_column = 'log2fc'
    AND (d.perturbation_id_source != 'hackett'      OR h.sample_id IS NOT NULL)
    AND (d.binding_id_source      != 'callingcards' OR cc.sample_id IS NOT NULL)
    AND (d.binding_id_source      != 'harbison'     OR harb.sample_id IS NOT NULL)
