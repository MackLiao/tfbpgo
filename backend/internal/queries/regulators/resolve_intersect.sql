-- Returns regulator locus tags present in ALL of the joined `{db_name}_meta`
-- tables. Identifiers are interpolated by the handler AFTER whitelist
-- verification against dataset_manifest. Limit is one more than the
-- documented cap so the handler can detect truncation.
SELECT DISTINCT regulator_locus_tag AS tag
FROM {{first_table}}_meta
{{intersect_chain}}
ORDER BY tag
LIMIT 1001;
