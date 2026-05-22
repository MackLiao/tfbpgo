-- One per-pair block of the selection-matrix cross-dataset query. The
-- handler concatenates one instance per (dbA, dbB) pair with UNION ALL.
--
-- Mirrors reference/tfbpshiny/modules/select_datasets/queries.py:239-305
-- (matrix_cross_dataset_query). Common-regulator set is computed in SQL via
-- INTERSECT so no Go-side set ops are required.
--
-- Placeholders (all whitelisted by the handler):
--   {{pair_id_literal}}  — single-quoted "{dbA}__{dbB}".
--   {{table_a}}, {{table_b}} — meta-table identifiers.
--   {{sample_id_col_a}}, {{sample_id_col_b}} — per-dataset sample_id field
--           (gm_id for callingcards, etc.) sourced from
--           dataset_manifest.sample_id_field.
--   {{where_a}}, {{where_b}} — INTERSECT-arm WHERE clauses (filters applied).
--   {{where_sa}}, {{where_sb}} — sample-count WHERE clauses (filters applied)
--                                with the AND/WHERE common-regulator predicate
--                                already appended by the handler.
SELECT {{pair_id_literal}} AS pair_id,
       (SELECT COUNT(*) FROM (
            SELECT regulator_locus_tag FROM {{table_a}}{{where_a}}
            INTERSECT
            SELECT regulator_locus_tag FROM {{table_b}}{{where_b}}
        ) AS _c) AS n_common,
       (SELECT COUNT(DISTINCT {{sample_id_col_a}}) FROM {{table_a}}{{where_sa}}) AS samples_a,
       (SELECT COUNT(DISTINCT {{sample_id_col_b}}) FROM {{table_b}}{{where_sb}}) AS samples_b
