"""Tests for manifest table builders."""

from __future__ import annotations

import duckdb

from data_prep.manifests import (
    SCHEMA_VERSION,
    write_artifact_manifest,
)


def test_artifact_manifest_has_exactly_one_row(
    fresh_duckdb: duckdb.DuckDBPyConnection,
) -> None:
    write_artifact_manifest(
        fresh_duckdb,
        artifact_version="2026-05-12",
        source_yaml_sha256="a" * 64,
        parity_tests_passed=False,
    )
    n = fresh_duckdb.execute("SELECT COUNT(*) FROM artifact_manifest").fetchone()[0]
    assert n == 1


def test_artifact_manifest_columns(
    fresh_duckdb: duckdb.DuckDBPyConnection,
) -> None:
    write_artifact_manifest(
        fresh_duckdb,
        artifact_version="2026-05-12",
        source_yaml_sha256="a" * 64,
        parity_tests_passed=False,
    )
    cols = {
        row[0]
        for row in fresh_duckdb.execute(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_name = 'artifact_manifest'"
        ).fetchall()
    }
    expected = {
        "artifact_version",
        "schema_version",
        "built_at",
        "source_yaml_sha256",
        "duckdb_version",
        "parity_tests_passed",
    }
    assert cols == expected


def test_artifact_manifest_records_runtime_duckdb_version(
    fresh_duckdb: duckdb.DuckDBPyConnection,
) -> None:
    write_artifact_manifest(
        fresh_duckdb,
        artifact_version="2026-05-12",
        source_yaml_sha256="a" * 64,
        parity_tests_passed=True,
    )
    row = fresh_duckdb.execute(
        "SELECT artifact_version, schema_version, source_yaml_sha256, "
        "duckdb_version, parity_tests_passed FROM artifact_manifest"
    ).fetchone()
    assert row[0] == "2026-05-12"
    assert row[1] == SCHEMA_VERSION
    assert row[2] == "a" * 64
    assert row[3]  # non-empty string from duckdb.__version__
    assert row[4] is True


def test_artifact_manifest_overwrite(
    fresh_duckdb: duckdb.DuckDBPyConnection,
) -> None:
    """Re-running the builder must produce one row, not append."""
    for v in ("2026-05-12", "2026-05-13"):
        write_artifact_manifest(
            fresh_duckdb,
            artifact_version=v,
            source_yaml_sha256="a" * 64,
            parity_tests_passed=False,
        )
    n = fresh_duckdb.execute("SELECT COUNT(*) FROM artifact_manifest").fetchone()[0]
    assert n == 1
    v = fresh_duckdb.execute("SELECT artifact_version FROM artifact_manifest").fetchone()[0]
    assert v == "2026-05-13"
