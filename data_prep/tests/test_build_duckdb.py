"""Tests for the build_duckdb orchestrator (fixture mode only — labretriever
path is exercised by the integration test in test_build_duckdb_smoke.py)."""

from __future__ import annotations

from pathlib import Path

import duckdb
import pytest

from data_prep.build_duckdb import build_from_fixture
from data_prep.build_fixture import build_fixture


@pytest.fixture
def yaml_path(tmp_path: Path) -> Path:
    """Minimal YAML matching the fixture's two datasets."""
    p = tmp_path / "config.yaml"
    p.write_text(
        "repositories:\n"
        "  BrentLab/callingcards:\n"
        "    dataset:\n"
        "      cc:\n"
        "        tags:\n"
        "          data_type: binding\n"
        "          assay: CallingCards\n"
        "          display_name: Calling Cards\n"
        "        db_name: callingcards\n"
        "        sample_id:\n"
        "          field: gm_id\n"
        "  BrentLab/hackett_2020:\n"
        "    dataset:\n"
        "      hackett_2020:\n"
        "        tags:\n"
        "          data_type: perturbation\n"
        "          assay: overexpression\n"
        "          display_name: Hackett 2020\n"
        "        db_name: hackett\n"
        "        sample_id:\n"
        "          field: sample_id\n"
    )
    return p


@pytest.fixture
def fixture_db(tmp_path: Path) -> Path:
    p = tmp_path / "in.duckdb"
    build_fixture(p)
    return p


def test_build_from_fixture_creates_all_manifest_tables(
    tmp_path: Path, yaml_path: Path, fixture_db: Path
) -> None:
    out = tmp_path / "out.duckdb"
    build_from_fixture(
        fixture_path=fixture_db,
        yaml_config_path=yaml_path,
        out_path=out,
        artifact_version="2026-05-12-test",
    )

    conn = duckdb.connect(str(out), read_only=True)
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

    required = {
        "callingcards",
        "callingcards_meta",
        "hackett",
        "hackett_meta",
        "hackett_analysis_set",
        "regulator_display_names",
        "artifact_manifest",
        "dataset_manifest",
        "field_manifest",
        "filter_level_cache",
    }
    assert required <= tables, f"missing: {required - tables}"


def test_build_from_fixture_artifact_version_recorded(
    tmp_path: Path, yaml_path: Path, fixture_db: Path
) -> None:
    out = tmp_path / "out.duckdb"
    build_from_fixture(
        fixture_path=fixture_db,
        yaml_config_path=yaml_path,
        out_path=out,
        artifact_version="2026-05-12-test",
    )
    conn = duckdb.connect(str(out), read_only=True)
    try:
        v = conn.execute(
            "SELECT artifact_version FROM artifact_manifest"
        ).fetchone()[0]
    finally:
        conn.close()
    assert v == "2026-05-12-test"


def test_build_from_fixture_overwrites_existing_out(
    tmp_path: Path, yaml_path: Path, fixture_db: Path
) -> None:
    out = tmp_path / "out.duckdb"
    out.write_bytes(b"not a duckdb file")
    build_from_fixture(
        fixture_path=fixture_db,
        yaml_config_path=yaml_path,
        out_path=out,
        artifact_version="x",
    )
    # If overwrite worked, this should open as a valid DuckDB.
    conn = duckdb.connect(str(out), read_only=True)
    try:
        n = conn.execute(
            "SELECT COUNT(*) FROM artifact_manifest"
        ).fetchone()[0]
    finally:
        conn.close()
    assert n == 1
