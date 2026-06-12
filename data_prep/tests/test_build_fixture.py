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


def test_fixture_dataset_manifest_v3_columns(built_fixture: Path) -> None:
    """v3: dataset_manifest carries effect_col/pvalue_col. callingcards has
    a real p-value column; hackett intentionally has none. (Retained at v4.)"""
    conn = duckdb.connect(str(built_fixture), read_only=True)
    try:
        rows = conn.execute(
            "SELECT db_name, effect_col, pvalue_col FROM dataset_manifest "
            "ORDER BY db_name"
        ).fetchall()
        sv = conn.execute("SELECT schema_version FROM artifact_manifest").fetchone()[0]
    finally:
        conn.close()
    assert sv == 6
    by_name = {db: (eff, pv) for (db, eff, pv) in rows}
    assert by_name["callingcards"] == ("callingcards_enrichment", "poisson_pval")
    assert by_name["hackett"] == ("log2_shrunken_timecourses", "")


def test_fixture_field_manifest_role_column(built_fixture: Path) -> None:
    """v3: field_manifest.role marks experimental_condition fields."""
    conn = duckdb.connect(str(built_fixture), read_only=True)
    try:
        rows = conn.execute(
            "SELECT db_name, field, role FROM field_manifest"
        ).fetchall()
    finally:
        conn.close()
    role_by_key = {(db, f): r for (db, f, r) in rows}
    assert role_by_key[("hackett", "time")] == "experimental_condition"
    # harbison.condition is also experimental_condition (kept despite being in
    # HIDDEN_FILTER_FIELDS — the exp-cond override).
    assert role_by_key[("harbison", "condition")] == "experimental_condition"
    # Sanity: a non-condition meta field is empty-role.
    assert role_by_key[("harbison", "end")] == ""
    # Real-data shape: callingcards has no condition column, so it has NO
    # field_manifest entry (the phantom that 500'd sample-conditions).
    assert ("callingcards", "condition") not in role_by_key
    # SD-3: data-only columns are not filter fields at all.
    assert ("callingcards", "target_locus_tag") not in role_by_key
    assert ("hackett", "log2_shrunken_timecourses") not in role_by_key


def test_fixture_dataset_manifest_v4_columns(built_fixture: Path) -> None:
    """v4: dataset_manifest gains default_active / default_filters /
    condition_cols. callingcards / hackett / kemmeren are default_active=TRUE;
    v6 drops harbison from DEFAULT_ACTIVE_DATASETS so harbison is now FALSE.
    hackett has a default_filters spec; condition_cols is derived (DM-1)."""
    conn = duckdb.connect(str(built_fixture), read_only=True)
    try:
        rows = conn.execute(
            "SELECT db_name, default_active, default_filters, condition_cols "
            "FROM dataset_manifest ORDER BY db_name"
        ).fetchall()
    finally:
        conn.close()
    by_name = {db: (active, df, cc) for (db, active, df, cc) in rows}
    # DM-5 / real-data shape: callingcards has no experimental-condition column
    # in {db}_meta, so condition_cols is derived to empty.
    assert by_name["callingcards"] == (True, "", "")
    # v6: harbison is no longer pre-selected (dropped from DEFAULT_ACTIVE_DATASETS).
    assert by_name["harbison"][0] is False
    assert by_name["hackett"] == (
        True,
        '{"time":{"type":"numeric","value":[45,45]}}',
        # DM-1: derived condition_cols is just `time` (mechanism/restriction
        # are hidden, so they no longer leak into the hover label).
        "time",
    )


def test_fixture_dataset_manifest_v6_columns(built_fixture: Path) -> None:
    """v6: dataset_manifest gains is_primary / log10p_col / neglog10p_col. All
    four fixture datasets (callingcards, harbison, hackett, kemmeren) are base
    datasets in PRIMARY_DATASETS, so is_primary=TRUE for all; none carry a
    log10p_col (only base rossi / chec_m2025 do, which the fixture omits)."""
    conn = duckdb.connect(str(built_fixture), read_only=True)
    try:
        rows = conn.execute(
            "SELECT db_name, is_primary, log10p_col, neglog10p_col "
            "FROM dataset_manifest ORDER BY db_name"
        ).fetchall()
        sv = conn.execute("SELECT schema_version FROM artifact_manifest").fetchone()[0]
    finally:
        conn.close()
    assert sv == 6
    by_name = {db: (bool(p), l10, nl10) for (db, p, l10, nl10) in rows}
    for db in ("callingcards", "harbison", "hackett", "kemmeren"):
        assert by_name[db] == (True, "", ""), db


def test_fixture_field_manifest_v4_columns(built_fixture: Path) -> None:
    """v4: field_manifest carries description / level_definitions /
    ui_kind_override / numeric_level_sort. hackett.time gets the
    categorical + numeric-sort override; everything else is empty."""
    conn = duckdb.connect(str(built_fixture), read_only=True)
    try:
        rows = conn.execute(
            "SELECT db_name, field, description, level_definitions, "
            "ui_kind_override, numeric_level_sort FROM field_manifest"
        ).fetchall()
    finally:
        conn.close()
    by_key = {
        (db, f): (desc, lvl_defs, ui_kind, lvl_sort)
        for (db, f, desc, lvl_defs, ui_kind, lvl_sort) in rows
    }
    # hackett.time: categorical + numeric level-sort.
    assert by_key[("hackett", "time")] == ("", "", "categorical", "numeric")
    # harbison.condition: no override; empty description/level_definitions
    # (the fixture supplies no labretriever column metadata).
    assert by_key[("harbison", "condition")] == ("", "", "", "")
    # harbison.end (reserved-keyword meta column): no override.
    assert by_key[("harbison", "end")] == ("", "", "", "")


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
