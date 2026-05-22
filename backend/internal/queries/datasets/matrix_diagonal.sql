-- One per-dataset block of the selection-matrix diagonal query. The handler
-- concatenates one instance per active dataset with UNION ALL.
--
-- Mirrors reference/tfbpshiny/modules/select_datasets/queries.py:208-237
-- (matrix_diagonal_query).
--
-- Placeholders:
--   {{db_literal}}    — single-quoted db_name string literal (already
--                       escaped / SafeIdentRE-verified by the handler).
--   {{table}}         — meta table identifier (e.g. callingcards_meta).
--   {{sample_id_col}} — per-dataset sample_id field name (gm_id for
--                       callingcards, sample_id for the rest); sourced
--                       from dataset_manifest.sample_id_field.
--   {{where}}         — optional " WHERE ..." clause built from filters.
SELECT {{db_literal}} AS db_name,
       COUNT(DISTINCT regulator_locus_tag) AS n_regulators,
       COUNT(DISTINCT {{sample_id_col}}) AS n_samples
FROM {{table}}{{where}}
