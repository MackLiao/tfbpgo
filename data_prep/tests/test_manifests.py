"""Tests for manifest table builders."""

from __future__ import annotations

import textwrap

import duckdb
import pytest
import yaml

from data_prep.manifests import (
    DATASET_MEASUREMENT_COLUMNS,
    EXPERIMENTAL_CONDITION_FIELDS,
    HIDDEN_FILTER_FIELDS,
    LEVEL_CACHE_THRESHOLD,
    SCHEMA_VERSION,
    write_artifact_manifest,
    write_dataset_manifest,
    write_field_manifest,
    write_filter_level_cache,
)


def test_schema_version_is_four() -> None:
    assert SCHEMA_VERSION == 4


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
        "SELECT db_name, data_type, assay, display_name, source_repo, "
        "sample_id_field, effect_col, pvalue_col, "
        "default_active, default_filters, condition_cols "
        "FROM dataset_manifest ORDER BY db_name"
    ).fetchall()

    # callingcards: in DEFAULT_ACTIVE_DATASETS, no DEFAULT_DATASET_FILTERS
    # entry, has CONDITION_COLS=['condition']. Its YAML sample_id.field is
    # `gm_id`, but write_dataset_manifest emits the *materialized* column
    # name `sample_id` (labretriever renames every source sample-id column
    # to `sample_id` in the VirtualDB view) — see
    # test_dataset_manifest_forces_materialized_sample_id below.
    # hackett:      in DEFAULT_ACTIVE_DATASETS, DEFAULT_DATASET_FILTERS
    # encodes {"time": {"type":"numeric","value":[45,45]}}, and
    # CONDITION_COLS=['mechanism','restriction','time'].
    assert rows == [
        (
            "callingcards", "binding", "CallingCards", "2026 Calling Cards",
            "BrentLab/callingcards", "sample_id",
            "callingcards_enrichment", "poisson_pval",
            True, "", "condition",
        ),
        (
            "hackett", "perturbation", "overexpression",
            "2020 Overexpression (Hackett)", "BrentLab/hackett_2020", "sample_id",
            "log2_shrunken_timecourses", "",
            True,
            '{"time":{"type":"numeric","value":[45,45]}}',
            "mechanism,restriction,time",
        ),
    ]


def test_dataset_manifest_forces_materialized_sample_id(
    fresh_duckdb: duckdb.DuckDBPyConnection,
) -> None:
    """write_dataset_manifest must emit the *materialized* sample-id column
    name `sample_id`, ignoring the YAML `sample_id.field` source name.

    labretriever renames every source-side sample-id column (e.g. `gm_id`
    for callingcards) to a uniform `sample_id` in the materialized VirtualDB
    view, so the runtime manifest must reflect that — not the YAML source.
    Regression guard for the BUG 3 fix (commit e10cfa4): the _SAMPLE_YAML
    above declares callingcards `sample_id.field: gm_id`, yet the emitted
    manifest value must be `sample_id`.
    """
    config = yaml.safe_load(_SAMPLE_YAML)
    write_dataset_manifest(fresh_duckdb, config)
    row = fresh_duckdb.execute(
        "SELECT sample_id_field FROM dataset_manifest WHERE db_name = 'callingcards'"
    ).fetchone()
    assert row[0] == "sample_id"  # NOT the YAML source name 'gm_id'


def test_dataset_manifest_columns_v4(
    fresh_duckdb: duckdb.DuckDBPyConnection,
) -> None:
    config = yaml.safe_load(_SAMPLE_YAML)
    write_dataset_manifest(fresh_duckdb, config)
    cols = {
        row[0]
        for row in fresh_duckdb.execute(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_name = 'dataset_manifest'"
        ).fetchall()
    }
    expected = {
        "db_name",
        "data_type",
        "assay",
        "display_name",
        "source_repo",
        "sample_id_field",
        "effect_col",
        "pvalue_col",
        # v4 additions
        "default_active",
        "default_filters",
        "condition_cols",
    }
    assert cols == expected


def test_dataset_manifest_raises_when_db_name_missing_from_measurement_map(
    fresh_duckdb: duckdb.DuckDBPyConnection,
) -> None:
    """A dataset in YAML but absent from DATASET_MEASUREMENT_COLUMNS must
    raise — the artifact would otherwise ship without the per-dataset
    effect/pvalue cols the Go service needs."""
    assert "future_assay_42" not in DATASET_MEASUREMENT_COLUMNS
    config = {
        "repositories": {
            "BrentLab/future": {
                "dataset": {
                    "future_v1": {
                        "tags": {
                            "data_type": "binding",
                            "assay": "Future",
                            "display_name": "Future",
                        },
                        "db_name": "future_assay_42",
                        "sample_id": {"field": "sample_id"},
                    },
                },
            },
        },
    }
    with pytest.raises(ValueError, match="DATASET_MEASUREMENT_COLUMNS"):
        write_dataset_manifest(fresh_duckdb, config)


def test_dataset_manifest_raises_when_sample_id_field_missing(
    fresh_duckdb: duckdb.DuckDBPyConnection,
) -> None:
    config = {
        "repositories": {
            "BrentLab/x": {
                "dataset": {
                    "x": {
                        "tags": {
                            "data_type": "binding",
                            "assay": "X",
                            "display_name": "X",
                        },
                        "db_name": "x",
                        # sample_id block missing
                    },
                },
            },
        },
    }
    with pytest.raises(ValueError, match="missing required sample_id.field"):
        write_dataset_manifest(fresh_duckdb, config)


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


def _seed_two_datasets(conn: duckdb.DuckDBPyConnection) -> None:
    conn.execute(
        "CREATE TABLE callingcards (gm_id VARCHAR, regulator_locus_tag VARCHAR, "
        "target_locus_tag VARCHAR, score DOUBLE)"
    )
    conn.execute(
        "CREATE TABLE callingcards_meta (gm_id VARCHAR, regulator_locus_tag "
        "VARCHAR, regulator_symbol VARCHAR, condition VARCHAR, "
        "background_total_hops INTEGER)"
    )
    conn.execute(
        "CREATE TABLE harbison (sample_id VARCHAR, regulator_locus_tag VARCHAR, "
        "target_locus_tag VARCHAR, score DOUBLE)"
    )
    conn.execute(
        "CREATE TABLE harbison_meta (sample_id VARCHAR, regulator_locus_tag "
        "VARCHAR, regulator_symbol VARCHAR, condition VARCHAR)"
    )
    conn.execute(
        "CREATE TABLE dataset_manifest (db_name VARCHAR PRIMARY KEY, "
        "data_type VARCHAR, assay VARCHAR, display_name VARCHAR, "
        "source_repo VARCHAR, sample_id_field VARCHAR, "
        "effect_col VARCHAR, pvalue_col VARCHAR)"
    )
    conn.execute(
        "INSERT INTO dataset_manifest VALUES "
        "('callingcards', 'binding', 'CallingCards', 'cc', "
        "'BrentLab/callingcards', 'gm_id', 'callingcards_enrichment', 'poisson_pval'), "
        "('harbison', 'binding', 'ChIP-chip', 'harbison', "
        "'BrentLab/harbison_2004', 'sample_id', 'effect', 'pvalue')"
    )


def test_field_manifest_one_row_per_legal_field(
    fresh_duckdb: duckdb.DuckDBPyConnection,
) -> None:
    _seed_two_datasets(fresh_duckdb)
    write_field_manifest(fresh_duckdb)

    cc_fields = {
        row[0]
        for row in fresh_duckdb.execute(
            "SELECT field FROM field_manifest WHERE db_name = 'callingcards'"
        ).fetchall()
    }
    # Allowed: target_locus_tag, score (data) + condition (meta)
    # Disallowed: regulator_locus_tag, regulator_symbol (global hidden);
    #             gm_id (sample_id alias — see Step 3 logic);
    #             background_total_hops (callingcards-specific hidden)
    assert cc_fields == {"target_locus_tag", "score", "condition"}


def test_field_manifest_excludes_globally_hidden(
    fresh_duckdb: duckdb.DuckDBPyConnection,
) -> None:
    _seed_two_datasets(fresh_duckdb)
    write_field_manifest(fresh_duckdb)
    forbidden = HIDDEN_FILTER_FIELDS["*"]
    rows = fresh_duckdb.execute(
        "SELECT field FROM field_manifest"
    ).fetchall()
    for (field,) in rows:
        assert field not in forbidden


def test_field_manifest_db_name_field_unique(
    fresh_duckdb: duckdb.DuckDBPyConnection,
) -> None:
    _seed_two_datasets(fresh_duckdb)
    write_field_manifest(fresh_duckdb)
    n = fresh_duckdb.execute("SELECT COUNT(*) FROM field_manifest").fetchone()[0]
    n_distinct = fresh_duckdb.execute(
        "SELECT COUNT(DISTINCT (db_name, field)) FROM field_manifest"
    ).fetchone()[0]
    assert n == n_distinct


def test_field_manifest_role_for_experimental_condition(
    fresh_duckdb: duckdb.DuckDBPyConnection,
) -> None:
    """v3: callingcards.condition is tagged role='experimental_condition'.
    All other fields keep role=''."""
    assert "condition" in EXPERIMENTAL_CONDITION_FIELDS["callingcards"]
    _seed_two_datasets(fresh_duckdb)
    write_field_manifest(fresh_duckdb)
    rows = fresh_duckdb.execute(
        "SELECT db_name, field, role FROM field_manifest "
        "ORDER BY db_name, field"
    ).fetchall()
    role_by_key = {(db, f): r for (db, f, r) in rows}
    assert role_by_key[("callingcards", "condition")] == "experimental_condition"
    # callingcards.target_locus_tag and harbison.target_locus_tag must be
    # role=''. (harbison.condition is hidden, so it never reaches the
    # field_manifest.)
    assert role_by_key[("callingcards", "target_locus_tag")] == ""
    assert role_by_key[("harbison", "target_locus_tag")] == ""


def test_field_manifest_v4_columns(
    fresh_duckdb: duckdb.DuckDBPyConnection,
) -> None:
    """v4: field_manifest gains description / level_definitions /
    ui_kind_override / numeric_level_sort columns."""
    _seed_two_datasets(fresh_duckdb)
    write_field_manifest(fresh_duckdb)
    cols = {
        row[0]
        for row in fresh_duckdb.execute(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_name = 'field_manifest'"
        ).fetchall()
    }
    expected = {
        "db_name",
        "field",
        "role",
        "description",
        "level_definitions",
        "ui_kind_override",
        "numeric_level_sort",
    }
    assert cols == expected


def test_field_manifest_v4_defaults_empty(
    fresh_duckdb: duckdb.DuckDBPyConnection,
) -> None:
    """For datasets without FIELD_TYPE_OVERRIDES entries, the new columns
    are all empty strings."""
    _seed_two_datasets(fresh_duckdb)
    write_field_manifest(fresh_duckdb)
    rows = fresh_duckdb.execute(
        "SELECT description, level_definitions, ui_kind_override, "
        "numeric_level_sort FROM field_manifest"
    ).fetchall()
    for desc, lvl_defs, ui_kind, lvl_sort in rows:
        assert desc == ""
        assert lvl_defs == ""
        assert ui_kind == ""
        assert lvl_sort == ""


def test_field_manifest_v4_hackett_time_override(
    fresh_duckdb: duckdb.DuckDBPyConnection,
) -> None:
    """Seed a hackett dataset and verify (hackett, time) picks up
    FIELD_TYPE_OVERRIDES → (categorical, numeric)."""
    fresh_duckdb.execute(
        "CREATE TABLE hackett (sample_id VARCHAR, regulator_locus_tag VARCHAR, "
        "target_locus_tag VARCHAR, score DOUBLE)"
    )
    fresh_duckdb.execute(
        "CREATE TABLE hackett_meta (sample_id VARCHAR, "
        "regulator_locus_tag VARCHAR, regulator_symbol VARCHAR, "
        "time INTEGER)"
    )
    fresh_duckdb.execute(
        "CREATE TABLE dataset_manifest (db_name VARCHAR PRIMARY KEY, "
        "data_type VARCHAR, assay VARCHAR, display_name VARCHAR, "
        "source_repo VARCHAR, sample_id_field VARCHAR, "
        "effect_col VARCHAR, pvalue_col VARCHAR)"
    )
    fresh_duckdb.execute(
        "INSERT INTO dataset_manifest VALUES "
        "('hackett', 'perturbation', 'overexpression', 'Hackett', "
        "'BrentLab/hackett_2020', 'sample_id', "
        "'log2_shrunken_timecourses', '')"
    )
    write_field_manifest(fresh_duckdb)
    row = fresh_duckdb.execute(
        "SELECT ui_kind_override, numeric_level_sort "
        "FROM field_manifest WHERE db_name='hackett' AND field='time'"
    ).fetchone()
    assert row == ("categorical", "numeric")


def _seed_low_cardinality(conn: duckdb.DuckDBPyConnection) -> None:
    """Tables where condition has 2 distinct values, score has many."""
    conn.execute(
        "CREATE TABLE callingcards (gm_id VARCHAR, target_locus_tag VARCHAR, "
        "score DOUBLE)"
    )
    conn.execute(
        "CREATE TABLE callingcards_meta (gm_id VARCHAR, "
        "regulator_locus_tag VARCHAR, condition VARCHAR)"
    )
    conn.execute(
        "INSERT INTO callingcards_meta VALUES "
        "('cc_0', 'YBR289W', 'YPD'), "
        "('cc_1', 'YML007W', 'SC'), "
        "('cc_2', 'YGL073W', 'YPD')"
    )
    # field_manifest must exist; populate with the legal fields.
    conn.execute(
        "CREATE TABLE field_manifest (db_name VARCHAR, field VARCHAR, "
        "PRIMARY KEY (db_name, field))"
    )
    conn.execute(
        "INSERT INTO field_manifest VALUES "
        "('callingcards', 'condition'), "
        "('callingcards', 'target_locus_tag'), "
        "('callingcards', 'score')"
    )


def test_filter_level_cache_includes_low_cardinality_field(
    fresh_duckdb: duckdb.DuckDBPyConnection,
) -> None:
    _seed_low_cardinality(fresh_duckdb)
    write_filter_level_cache(fresh_duckdb)

    levels = sorted(
        row[0]
        for row in fresh_duckdb.execute(
            "SELECT level FROM filter_level_cache "
            "WHERE db_name = 'callingcards' AND field = 'condition' "
            "ORDER BY level"
        ).fetchall()
    )
    assert levels == ["SC", "YPD"]


def test_filter_level_cache_excludes_high_cardinality(
    fresh_duckdb: duckdb.DuckDBPyConnection,
) -> None:
    """target_locus_tag will have one distinct value per row inserted via
    the test seed; in real data it has thousands. We verify the threshold
    is applied by inserting > LEVEL_CACHE_THRESHOLD rows and checking the
    field is omitted."""
    _seed_low_cardinality(fresh_duckdb)
    # Add many distinct target rows so target_locus_tag exceeds the threshold
    targets = [(f"cc_t_{i}", f"YAL{i:03d}C", 0.1) for i in range(LEVEL_CACHE_THRESHOLD + 5)]
    fresh_duckdb.executemany(
        "INSERT INTO callingcards VALUES (?, ?, ?)", targets
    )
    write_filter_level_cache(fresh_duckdb)
    n = fresh_duckdb.execute(
        "SELECT COUNT(*) FROM filter_level_cache "
        "WHERE db_name = 'callingcards' AND field = 'target_locus_tag'"
    ).fetchone()[0]
    assert n == 0


def test_filter_level_cache_only_caches_field_manifest_entries(
    fresh_duckdb: duckdb.DuckDBPyConnection,
) -> None:
    """A column present in the data but absent from field_manifest (e.g.,
    regulator_locus_tag, which is hidden) must not appear in the cache."""
    _seed_low_cardinality(fresh_duckdb)
    write_filter_level_cache(fresh_duckdb)
    n = fresh_duckdb.execute(
        "SELECT COUNT(*) FROM filter_level_cache "
        "WHERE field = 'regulator_locus_tag'"
    ).fetchone()[0]
    assert n == 0
