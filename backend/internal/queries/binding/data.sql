-- binding/data.sql
-- Template; the Go loader replaces {{table}}, {{col}}, {{extra_where}} with
-- whitelisted identifiers and Squirrel-built clauses, then binds ? for the
-- regulator filter.
SELECT
    regulator_locus_tag AS regulator_locus_tag,
    target_locus_tag    AS target_locus_tag,
    sample_id           AS sample_id,
    {{col}}             AS value
FROM {{table}}
WHERE regulator_locus_tag = ?
{{extra_where}}
