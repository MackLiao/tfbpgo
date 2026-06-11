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
-- Parity: Shiny's _DTO_SQL (comparison/queries.py:48-49) joins
-- `hackett_meta WHERE time = 45`. The v5 artifact restricts hackett_meta to
-- analysis-set samples at build time (SQL-1), so hackett_analysis_set carries
-- the identical (sample_id, time) pairs; the time = 45 filter below is what
-- makes the row sets match — without it, hackett samples observed only at
-- other timepoints would survive the h.sample_id IS NOT NULL gate. Mirrors
-- the topn path's `has.time = 45` join (comparison_topn.go).
LEFT JOIN (
    SELECT DISTINCT sample_id, time FROM hackett_analysis_set WHERE time = 45
) h
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
-- Deterministic total order → reproducible cache bytes. With the time = 45
-- join filter each hackett sample matches at most one row, but keep `time` as
-- the final tie-breaker so the ordering stays total if that ever changes.
ORDER BY
    d.binding_id_source,
    d.perturbation_id_source,
    CAST(d.binding_id_id AS VARCHAR),
    CAST(d.perturbation_id_id AS VARCHAR),
    COALESCE(CAST(h.time AS VARCHAR), 'standard')
