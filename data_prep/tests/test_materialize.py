"""Tests for view materialization and derived-table builders."""

from __future__ import annotations

import duckdb
import pytest

from data_prep.materialize import (
    build_hackett_analysis_set,
    build_regulator_display_names,
    materialize_views_as_tables,
)


@pytest.fixture
def db_with_views(fresh_duckdb: duckdb.DuckDBPyConnection) -> duckdb.DuckDBPyConnection:
    """A DuckDB connection that simulates the post-labretriever state:
    `{db_name}` and `{db_name}_meta` are VIEWs, not tables."""
    fresh_duckdb.execute(
        "CREATE TABLE _callingcards_data AS "
        "SELECT gm_id, regulator_locus_tag, target_locus_tag, "
        "CAST(score AS DOUBLE) AS score FROM (VALUES "
        "('cc_0', 'YBR289W', 'YAL001C', 0.1), "
        "('cc_0', 'YBR289W', 'YAL002W', 0.2)) "
        "AS t(gm_id, regulator_locus_tag, target_locus_tag, score)"
    )
    fresh_duckdb.execute(
        "CREATE VIEW callingcards AS SELECT * FROM _callingcards_data"
    )
    fresh_duckdb.execute(
        "CREATE TABLE _callingcards_meta_data AS "
        "SELECT * FROM (VALUES "
        "('cc_0', 'YBR289W', 'SNF5', 'YPD')) "
        "AS t(gm_id, regulator_locus_tag, regulator_symbol, condition)"
    )
    fresh_duckdb.execute(
        "CREATE VIEW callingcards_meta AS SELECT * FROM _callingcards_meta_data"
    )
    return fresh_duckdb


def test_materialize_converts_views_to_tables(
    db_with_views: duckdb.DuckDBPyConnection,
) -> None:
    materialize_views_as_tables(db_with_views, view_names=["callingcards", "callingcards_meta"])

    kinds = {
        row[0]: row[1]
        for row in db_with_views.execute(
            "SELECT table_name, table_type FROM information_schema.tables "
            "WHERE table_name IN ('callingcards', 'callingcards_meta')"
        ).fetchall()
    }
    assert kinds == {
        "callingcards": "BASE TABLE",
        "callingcards_meta": "BASE TABLE",
    }


def test_materialize_preserves_row_data(
    db_with_views: duckdb.DuckDBPyConnection,
) -> None:
    materialize_views_as_tables(db_with_views, view_names=["callingcards"])
    rows = db_with_views.execute(
        "SELECT regulator_locus_tag, target_locus_tag, score FROM callingcards "
        "ORDER BY target_locus_tag"
    ).fetchall()
    assert rows == [("YBR289W", "YAL001C", 0.1), ("YBR289W", "YAL002W", 0.2)]


def test_build_regulator_display_names_uses_symbol_when_present(
    db_with_views: duckdb.DuckDBPyConnection,
) -> None:
    materialize_views_as_tables(db_with_views, view_names=["callingcards", "callingcards_meta"])
    build_regulator_display_names(db_with_views, db_names=["callingcards"])

    row = db_with_views.execute(
        "SELECT regulator_symbol, display_name FROM regulator_display_names "
        "WHERE regulator_locus_tag = 'YBR289W'"
    ).fetchone()
    assert row == ("SNF5", "SNF5 (YBR289W)")


def test_build_hackett_analysis_set_filters_by_tier() -> None:
    """Use a fresh in-memory DB seeded just for this test (the build_hackett
    function expects a `hackett_meta` table, not the callingcards fixture)."""
    conn = duckdb.connect(":memory:")
    try:
        conn.execute(
            "CREATE TABLE hackett_meta AS SELECT * FROM (VALUES "
            "('h_0', 'YBR289W', 'SNF5', 'ZEV', 'P', 45.0, '2020-01-01', 'BY4741'), "
            "('h_1', 'YML007W', 'YAP1', 'GEV', 'P', 45.0, '2020-01-01', 'BY4741'), "
            "('h_2', 'YGL073W', 'HSF1', 'GEV', 'M', 45.0, '2020-01-01', 'BY4741'), "
            "('h_extra', 'YBR289W', 'SNF5', 'GEV', 'M', 45.0, '2020-01-02', 'BY4741') "
            ") AS t(sample_id, regulator_locus_tag, regulator_symbol, mechanism, "
            "restriction, time, date, strain)"
        )
        build_hackett_analysis_set(conn)

        sample_ids = sorted(
            row[0]
            for row in conn.execute(
                "SELECT sample_id FROM hackett_analysis_set"
            ).fetchall()
        )
        # h_0: tier 1 (ZEV/P present); h_1: tier 2 (no ZEV/P, GEV/P present);
        # h_2: tier 3 (no ZEV/P, no GEV/P, takes GEV/M).
        # h_extra is filtered: YBR289W is tier 1 (ZEV/P), so only ZEV/P rows kept.
        assert sample_ids == ["h_0", "h_1", "h_2"]
    finally:
        conn.close()
