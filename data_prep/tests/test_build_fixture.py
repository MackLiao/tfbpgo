"""Tests for the synthetic fixture builder."""

from __future__ import annotations

from pathlib import Path

import duckdb
import pytest

from data_prep.build_fixture import build_fixture


@pytest.fixture
def built_fixture(tmp_path: Path) -> Path:
    out = tmp_path / "tfbp_test.duckdb"
    build_fixture(out)
    return out


def test_fixture_has_expected_tables(built_fixture: Path) -> None:
    conn = duckdb.connect(str(built_fixture), read_only=True)
    try:
        tables = {
            row[0]
            for row in conn.execute(
                "SELECT table_name FROM information_schema.tables "
                "WHERE table_schema = 'main'"
            ).fetchall()
        }
    finally:
        conn.close()
    expected = {
        "callingcards",
        "callingcards_meta",
        "hackett",
        "hackett_meta",
        # The widened fixture is self-contained: includes manifests + derived.
        "artifact_manifest",
        "dataset_manifest",
        "field_manifest",
        "filter_level_cache",
        "hackett_analysis_set",
        "regulator_display_names",
        "dto_expanded",
    }
    assert expected <= tables, f"missing: {expected - tables}"


def test_fixture_callingcards_row_count(built_fixture: Path) -> None:
    # 3 regulators × 5 targets × 2 sample_ids = 30 rows in the widened fixture.
    conn = duckdb.connect(str(built_fixture), read_only=True)
    try:
        n = conn.execute("SELECT COUNT(*) FROM callingcards").fetchone()[0]
    finally:
        conn.close()
    assert n == 30


def test_fixture_hackett_meta_includes_all_three_tiers(built_fixture: Path) -> None:
    """ensure_hackett_analysis_set in Task 4 needs at least one row per tier."""
    conn = duckdb.connect(str(built_fixture), read_only=True)
    try:
        rows = conn.execute(
            "SELECT mechanism, restriction FROM hackett_meta"
        ).fetchall()
    finally:
        conn.close()
    pairs = {(m, r) for m, r in rows}
    assert ("ZEV", "P") in pairs
    assert ("GEV", "P") in pairs
    assert ("GEV", "M") in pairs


def test_fixture_is_reproducible(tmp_path: Path) -> None:
    """Two invocations of build_fixture produce byte-identical files (modulo
    DuckDB internal metadata). Check via row hashes instead of file bytes."""
    a = tmp_path / "a.duckdb"
    b = tmp_path / "b.duckdb"
    build_fixture(a)
    build_fixture(b)

    def signature(p: Path) -> list[tuple]:
        conn = duckdb.connect(str(p), read_only=True)
        try:
            return conn.execute(
                "SELECT * FROM callingcards ORDER BY gm_id, target_locus_tag"
            ).fetchall()
        finally:
            conn.close()

    assert signature(a) == signature(b)
