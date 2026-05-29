-- Returns regulator locus tags present in ALL of the joined `{db_name}_meta`
-- tables, with each arm restricted to that dataset's active filters (SD-1:
-- filter-aware resolve, so the modal's common set matches the filter-aware
-- matrix cell). Identifiers are interpolated by the handler AFTER whitelist
-- verification against dataset_manifest; filter WHERE clauses come from
-- buildSquirrelWhere (parameterized values, double-quoted identifiers). The
-- regulator_locus_tag filter itself is stripped before this query (it would
-- be circular — we are computing the regulator set). No LIMIT: Shiny writes
-- the full sorted intersection with no cap (SD-2).
SELECT DISTINCT regulator_locus_tag AS tag
FROM {{first_table}}_meta{{first_where}}
{{intersect_chain}}
ORDER BY tag;
