"""Tests for view materialization and derived-table builders."""

from __future__ import annotations

import duckdb
import pytest

from data_prep.materialize import (
    build_hackett_analysis_set,
    build_regulator_display_names,
    filter_hackett_to_analysis_set,
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
    fresh_duckdb.execute("CREATE VIEW callingcards AS SELECT * FROM _callingcards_data")
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
    materialize_views_as_tables(
        db_with_views, view_names=["callingcards", "callingcards_meta"]
    )

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
    materialize_views_as_tables(
        db_with_views, view_names=["callingcards", "callingcards_meta"]
    )
    build_regulator_display_names(db_with_views, db_names=["callingcards"])

    row = db_with_views.execute(
        "SELECT regulator_symbol, display_name FROM regulator_display_names "
        "WHERE regulator_locus_tag = 'YBR289W'"
    ).fetchone()
    assert row == ("SNF5", "SNF5 (YBR289W)")


def test_build_regulator_display_names_is_deterministic_with_multiple_symbols() -> None:
    """When the same locus_tag has multiple distinct symbol values across
    rows, the chosen symbol must be deterministic (MIN, not arbitrary)."""
    conn = duckdb.connect(":memory:")
    try:
        # Two rows, same locus_tag, different symbols.
        conn.execute(
            "CREATE TABLE foo_meta (regulator_locus_tag VARCHAR, "
            "regulator_symbol VARCHAR)"
        )
        conn.execute(
            "INSERT INTO foo_meta VALUES "
            "('YBR289W', 'SNF5'), "
            "('YBR289W', 'AAA'), "
            "('YBR289W', 'ZZZ')"
        )
        build_regulator_display_names(conn, db_names=["foo"])
        sym = conn.execute(
            "SELECT regulator_symbol FROM regulator_display_names "
            "WHERE regulator_locus_tag = 'YBR289W'"
        ).fetchone()[0]
        # MIN of {'SNF5', 'AAA', 'ZZZ'} is 'AAA'.
        assert sym == "AAA"
    finally:
        conn.close()


def test_build_regulator_display_names_creates_empty_when_no_eligible() -> None:
    """When no supplied dataset has both regulator_locus_tag and
    regulator_symbol columns in its meta table, the function still
    creates an empty table to satisfy Phase 1's startup contract."""
    conn = duckdb.connect(":memory:")
    try:
        # Meta table without regulator_locus_tag — not eligible.
        conn.execute("CREATE TABLE foo_meta (sample_id VARCHAR, condition VARCHAR)")
        build_regulator_display_names(conn, db_names=["foo"])
        kind = conn.execute(
            "SELECT table_type FROM information_schema.tables "
            "WHERE table_name = 'regulator_display_names'"
        ).fetchone()[0]
        assert kind == "BASE TABLE"
        n = conn.execute("SELECT COUNT(*) FROM regulator_display_names").fetchone()[0]
        assert n == 0
        cols = {
            r[0]
            for r in conn.execute(
                "SELECT column_name FROM information_schema.columns "
                "WHERE table_name = 'regulator_display_names'"
            ).fetchall()
        }
        assert cols == {"regulator_locus_tag", "regulator_symbol", "display_name"}
    finally:
        conn.close()


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


def test_filter_hackett_to_analysis_set_drops_non_analysis_rows() -> None:
    """SQL-1: filter_hackett_to_analysis_set must restrict BOTH hackett and
    hackett_meta to analysis-set samples, mirroring Shiny's _filter_hackett_views.
    Without it, the non-analysis-set sample (h_extra) leaks into every hackett
    query (perturbation tab, select-datasets sample counts, breakdown)."""
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
        conn.execute(
            "CREATE TABLE hackett AS SELECT * FROM (VALUES "
            "('h_0', 'YBR289W', 'YAL001C', 1.0), "
            "('h_2', 'YGL073W', 'YAL001C', 2.0), "
            "('h_extra', 'YBR289W', 'YAL002W', 9.0) "
            ") AS t(sample_id, regulator_locus_tag, target_locus_tag, "
            "log2_shrunken_timecourses)"
        )
        build_hackett_analysis_set(conn)
        filter_hackett_to_analysis_set(conn)

        meta_ids = sorted(
            r[0] for r in conn.execute("SELECT sample_id FROM hackett_meta").fetchall()
        )
        data_ids = sorted(
            r[0] for r in conn.execute("SELECT sample_id FROM hackett").fetchall()
        )
        # h_extra (GEV/M for a tier-1 regulator) is excluded from the analysis
        # set and therefore from both materialized tables.
        assert meta_ids == ["h_0", "h_1", "h_2"]
        assert "h_extra" not in data_ids
        # The tables are still BASE TABLEs (filter uses a staging rename).
        kind = conn.execute(
            "SELECT table_type FROM information_schema.tables "
            "WHERE table_name = 'hackett_meta'"
        ).fetchone()[0]
        assert kind == "BASE TABLE"
    finally:
        conn.close()
