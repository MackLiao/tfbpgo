SELECT
    regulator_locus_tag AS locus_tag,
    regulator_symbol    AS symbol,
    display_name        AS display_name
FROM regulator_display_names
WHERE
    LOWER(regulator_locus_tag) LIKE LOWER(? || '%')
    OR LOWER(regulator_symbol) LIKE LOWER(? || '%')
ORDER BY regulator_locus_tag
LIMIT ?
