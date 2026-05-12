"""View materialization and derived-table builders.

Converts labretriever-registered views into real DuckDB tables so the
runtime artifact is fully self-contained (no parquet/HF dependency at
serve time). Also ports the two derived tables previously built at app
startup in reference/tfbpshiny/utils/vdb_init.py.
"""

from __future__ import annotations

import duckdb

from data_prep._sql import validate_identifier


# Verbatim port of _HACKETT_ANALYSIS_SET_SQL from
# reference/tfbpshiny/utils/vdb_init.py:75-117. Update both together if
# the tier logic changes; parity tests in Phase 1 will catch divergence.
_HACKETT_ANALYSIS_SET_SQL = """
CREATE OR REPLACE TABLE hackett_analysis_set AS
WITH regulator_tiers AS (
    SELECT
        regulator_locus_tag,
        CASE
            WHEN BOOL_OR(mechanism = 'ZEV' AND restriction = 'P') THEN 1
            WHEN BOOL_OR(mechanism = 'GEV' AND restriction = 'P') THEN 2
            ELSE 3
        END AS tier
    FROM hackett_meta
    GROUP BY regulator_locus_tag
),
tier_filtered AS (
    SELECT
        h.sample_id,
        h.regulator_locus_tag,
        h.regulator_symbol,
        h.mechanism,
        h.restriction,
        h.time,
        h.date,
        h.strain,
        t.tier
    FROM hackett_meta h
    JOIN regulator_tiers t USING (regulator_locus_tag)
    WHERE
        (t.tier = 1 AND h.mechanism = 'ZEV' AND h.restriction = 'P')
        OR (t.tier = 2 AND h.mechanism = 'GEV' AND h.restriction = 'P')
        OR (t.tier = 3 AND h.mechanism = 'GEV' AND h.restriction = 'M')
)
SELECT DISTINCT
    sample_id,
    regulator_locus_tag,
    regulator_symbol,
    mechanism,
    restriction,
    time,
    date,
    strain
FROM tier_filtered
WHERE regulator_symbol NOT IN ('GCN4', 'RDS2', 'SWI1', 'MAC1')
"""


_DISPLAY_NAMES_SQL = """
CREATE OR REPLACE TABLE regulator_display_names AS
SELECT
    regulator_locus_tag,
    MIN(regulator_symbol) AS regulator_symbol,
    CASE
        WHEN MIN(regulator_symbol) IS NOT NULL
             AND MIN(regulator_symbol) != ''
             AND MIN(regulator_symbol) != regulator_locus_tag
        THEN MIN(regulator_symbol) || ' (' || regulator_locus_tag || ')'
        ELSE regulator_locus_tag
    END AS display_name
FROM ({union_sql}) __all
GROUP BY regulator_locus_tag
ORDER BY regulator_locus_tag
"""


def materialize_views_as_tables(
    conn: duckdb.DuckDBPyConnection,
    *,
    view_names: list[str],
) -> None:
    """For each view name, replace the view with a CTAS table containing the
    same rows. Caller is responsible for the list of views to materialize
    (typically: every dataset's `{db_name}` and `{db_name}_meta`, plus
    `{db_name}_expanded` for comparative datasets like dto)."""
    for view in view_names:
        safe_view = validate_identifier(view)
        # Capture rows into a temp staging table to avoid the view referring
        # to itself during DROP/CREATE.
        staging = f"_materialize_stage_{safe_view}"
        conn.execute(f'CREATE TABLE "{staging}" AS SELECT * FROM "{safe_view}"')
        conn.execute(f'DROP VIEW "{safe_view}"')
        conn.execute(f'ALTER TABLE "{staging}" RENAME TO "{safe_view}"')


def build_hackett_analysis_set(conn: duckdb.DuckDBPyConnection) -> None:
    """Create or replace hackett_analysis_set. Requires hackett_meta to exist."""
    conn.execute(_HACKETT_ANALYSIS_SET_SQL)


def build_regulator_display_names(
    conn: duckdb.DuckDBPyConnection,
    *,
    db_names: list[str],
) -> None:
    """Create or replace regulator_display_names by unioning regulator
    columns across the supplied dataset meta tables. Datasets whose meta
    table lacks `regulator_locus_tag` are skipped silently."""
    eligible: list[str] = []
    for db in db_names:
        validate_identifier(db)  # raise on unsafe input
        cols = {
            r[0]
            for r in conn.execute(
                "SELECT column_name FROM information_schema.columns "
                "WHERE table_schema = 'main' AND table_name = ?",
                [f"{db}_meta"],
            ).fetchall()
        }
        if "regulator_locus_tag" in cols and "regulator_symbol" in cols:
            eligible.append(db)
    if not eligible:
        # Still create the table empty so the Go service's startup contract
        # (table presence) is satisfied.
        conn.execute(
            "CREATE OR REPLACE TABLE regulator_display_names ("
            "regulator_locus_tag VARCHAR, "
            "regulator_symbol VARCHAR, "
            "display_name VARCHAR)"
        )
        return

    union_sql = " UNION ALL ".join(
        f"SELECT DISTINCT regulator_locus_tag, regulator_symbol "
        f'FROM "{db}_meta"'
        for db in eligible
    )
    conn.execute(_DISPLAY_NAMES_SQL.format(union_sql=union_sql))
