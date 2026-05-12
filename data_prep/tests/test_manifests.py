"""Tests for manifest table builders."""

from __future__ import annotations

import textwrap

import duckdb
import yaml

from data_prep.manifests import (
    SCHEMA_VERSION,
    write_artifact_manifest,
    write_dataset_manifest,
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


_SAMPLE_YAML = textwrap.dedent(
    """\
    repositories:
      BrentLab/callingcards:
        dataset:
          2026_analysis_set:
            tags:
              data_type: binding
              assay: CallingCards
              display_name: "2026 Calling Cards"
            db_name: callingcards
            sample_id:
              field: gm_id
      BrentLab/hackett_2020:
        dataset:
          hackett_2020:
            tags:
              data_type: perturbation
              assay: overexpression
              display_name: "2020 Overexpression (Hackett)"
            db_name: hackett
            sample_id:
              field: sample_id
      BrentLab/yeast_comparative_analysis:
        dataset:
          dto:
            db_name: dto
            sample_id:
              field: sample_id
    """
)


def test_dataset_manifest_emits_one_row_per_tagged_dataset(
    fresh_duckdb: duckdb.DuckDBPyConnection,
) -> None:
    config = yaml.safe_load(_SAMPLE_YAML)
    write_dataset_manifest(fresh_duckdb, config)

    rows = fresh_duckdb.execute(
        "SELECT db_name, data_type, assay, display_name, source_repo "
        "FROM dataset_manifest ORDER BY db_name"
    ).fetchall()

    assert rows == [
        ("callingcards", "binding", "CallingCards", "2026 Calling Cards",
         "BrentLab/callingcards"),
        ("hackett", "perturbation", "overexpression",
         "2020 Overexpression (Hackett)", "BrentLab/hackett_2020"),
    ]


def test_dataset_manifest_skips_untagged_dto_entry(
    fresh_duckdb: duckdb.DuckDBPyConnection,
) -> None:
    """The dto dataset has no tags block; it must not appear in the manifest
    of selectable datasets, but the table itself still exists in the artifact."""
    config = yaml.safe_load(_SAMPLE_YAML)
    write_dataset_manifest(fresh_duckdb, config)
    db_names = {
        row[0]
        for row in fresh_duckdb.execute(
            "SELECT db_name FROM dataset_manifest"
        ).fetchall()
    }
    assert "dto" not in db_names


def test_dataset_manifest_db_name_unique(
    fresh_duckdb: duckdb.DuckDBPyConnection,
) -> None:
    config = yaml.safe_load(_SAMPLE_YAML)
    write_dataset_manifest(fresh_duckdb, config)
    n_distinct = fresh_duckdb.execute(
        "SELECT COUNT(DISTINCT db_name) FROM dataset_manifest"
    ).fetchone()[0]
    n_total = fresh_duckdb.execute(
        "SELECT COUNT(*) FROM dataset_manifest"
    ).fetchone()[0]
    assert n_distinct == n_total
