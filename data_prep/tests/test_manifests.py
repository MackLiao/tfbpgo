"""Tests for manifest table builders."""

from __future__ import annotations

import textwrap

import duckdb
import pytest
import yaml

from data_prep.manifests import (
    DATASET_MEASUREMENT_COLUMNS,
    DEFAULT_ACTIVE_DATASETS,
    EXPERIMENTAL_CONDITION_FIELDS,
    HIDDEN_FILTER_FIELDS,
    LEVEL_CACHE_THRESHOLD,
    PRIMARY_DATASETS,
    SCHEMA_VERSION,
    assert_default_filters_in_field_manifest,
    harvest_column_metadata,
    write_artifact_manifest,
    write_dataset_manifest,
    write_field_manifest,
    write_filter_level_cache,
)


def test_default_active_datasets_are_all_primary() -> None:
    """Every default-active dataset must be primary.

    The frontend selector shows only primary datasets (is_primary). A dataset
    that is both default_active and NOT primary would be pre-selected on first
    visit yet invisible in the selector — an active-but-hidden state the user
    cannot see or deselect. This invariant tripwire prevents that combination
    from ever shipping in the artifact.
    """
    offenders = DEFAULT_ACTIVE_DATASETS - PRIMARY_DATASETS
    assert not offenders, (
        "default-active datasets that are not primary (would be active but "
        f"hidden from the selector): {sorted(offenders)}"
    )


def test_schema_version_is_six() -> None:
    assert SCHEMA_VERSION == 6


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
    v = fresh_duckdb.execute(
        "SELECT artifact_version FROM artifact_manifest"
    ).fetchone()[0]
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
      BrentLab/rossi_2021:
        dataset:
          rossi_peaks:
            tags:
              data_type: binding
              assay: ChIP-exo
              display_name: "Rossi (peaks)"
            db_name: rossi_peaks
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
    # DM-5: condition_cols is derived by intersecting EXPERIMENTAL_CONDITION_FIELDS
    # with the columns that actually exist in {db}_meta (mirroring
    # write_field_manifest's role gating), so the meta tables must exist when
    # write_dataset_manifest runs — exactly as in the real build, where
    # materialize_views_as_tables precedes _run_manifests. Seed them with the
    # condition columns present so they survive the intersection.
    fresh_duckdb.execute(
        "CREATE TABLE callingcards_meta (sample_id VARCHAR, "
        "regulator_locus_tag VARCHAR, regulator_symbol VARCHAR, condition VARCHAR)"
    )
    fresh_duckdb.execute(
        "CREATE TABLE hackett_meta (sample_id VARCHAR, "
        "regulator_locus_tag VARCHAR, regulator_symbol VARCHAR, time INTEGER)"
    )
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
    # encodes {"time": {"type":"numeric","value":[45,45]}}, and condition_cols
    # is derived to ['time'] (DM-1: mechanism/restriction are hidden).
    assert rows == [
        (
            "callingcards",
            "binding",
            "CallingCards",
            "2026 Calling Cards",
            "BrentLab/callingcards",
            "sample_id",
            "callingcards_enrichment",
            "poisson_pval",
            True,
            "",
            "condition",
        ),
        (
            "hackett",
            "perturbation",
            "overexpression",
            "2020 Overexpression (Hackett)",
            "BrentLab/hackett_2020",
            "sample_id",
            "log2_shrunken_timecourses",
            "",
            True,
            '{"time":{"type":"numeric","value":[45,45]}}',
            # DM-1/DM-5: condition_cols is derived from EXPERIMENTAL_CONDITION_FIELDS
            # — the hidden, non-experimental-condition columns mechanism/restriction
            # are no longer included (they produced "ZEV / P / 45" hover labels).
            "time",
        ),
        (
            # v6: a promoter-set variant. NOT in PRIMARY_DATASETS (so the
            # selector hides it), NOT in DEFAULT_ACTIVE_DATASETS (default_active
            # False), has no default_filters/condition preset, and uses the
            # peak_score / empty-pvalue measurement pair. (is_primary is asserted
            # separately in test_dataset_manifest_is_primary.)
            "rossi_peaks",
            "binding",
            "ChIP-exo",
            "Rossi (peaks)",
            "BrentLab/rossi_2021",
            "sample_id",
            "peak_score",
            "",
            False,
            "",
            "",
        ),
    ]


def test_dataset_manifest_drops_condition_col_absent_from_meta(
    fresh_duckdb: duckdb.DuckDBPyConnection,
) -> None:
    """DM-5 regression: a dataset listed in EXPERIMENTAL_CONDITION_FIELDS whose
    condition column is ABSENT from {db}_meta must NOT get a phantom
    condition_cols entry.

    This is the real-data callingcards bug class: EXPERIMENTAL_CONDITION_FIELDS
    claims callingcards→`condition`, but the materialized callingcards_meta has
    no such column (only the Title-Case `Carbon source`/`Temperature` display
    duplicates). Before condition_cols was intersected with the actual
    {db}_meta columns, this wrote condition_cols='condition', and the
    sample-conditions query then 500'd with "Column condition referenced ...
    cannot be referenced before it is defined".
    """
    config = yaml.safe_load(_SAMPLE_YAML)
    # callingcards_meta WITHOUT a `condition` column (mirrors real data); hackett
    # keeps `time` so it stays a control that the intersection does NOT over-drop.
    fresh_duckdb.execute(
        "CREATE TABLE callingcards_meta (sample_id VARCHAR, "
        "regulator_locus_tag VARCHAR, regulator_symbol VARCHAR)"
    )
    fresh_duckdb.execute(
        "CREATE TABLE hackett_meta (sample_id VARCHAR, "
        "regulator_locus_tag VARCHAR, regulator_symbol VARCHAR, time INTEGER)"
    )
    write_dataset_manifest(fresh_duckdb, config)

    cc = fresh_duckdb.execute(
        "SELECT condition_cols FROM dataset_manifest WHERE db_name='callingcards'"
    ).fetchone()[0]
    assert cc == "", "phantom condition col must be dropped when absent from {db}_meta"
    hk = fresh_duckdb.execute(
        "SELECT condition_cols FROM dataset_manifest WHERE db_name='hackett'"
    ).fetchone()[0]
    assert hk == "time", "a condition col present in {db}_meta must survive"


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


def test_dataset_manifest_columns_v6(
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
        # v5 additions
        "upstream_cols",
        "description",
        # v6 additions
        "is_primary",
        "log10p_col",
        "neglog10p_col",
    }
    assert cols == expected


def test_dataset_manifest_is_primary(
    fresh_duckdb: duckdb.DuckDBPyConnection,
) -> None:
    """v6: is_primary mirrors PRIMARY_DATASETS — base datasets are True; the
    promoter-set variants are False (so the frontend selector hides them).
    _SAMPLE_YAML carries two base datasets (callingcards, hackett) and one
    variant (rossi_peaks), so this drives both branches end-to-end through
    write_dataset_manifest → dataset_manifest."""
    config = yaml.safe_load(_SAMPLE_YAML)
    write_dataset_manifest(fresh_duckdb, config)
    by_name = {
        db: bool(is_primary)
        for db, is_primary in fresh_duckdb.execute(
            "SELECT db_name, is_primary FROM dataset_manifest"
        ).fetchall()
    }
    # callingcards + hackett are base datasets in PRIMARY_DATASETS.
    assert by_name["callingcards"] is True
    assert by_name["hackett"] is True
    # rossi_peaks is a promoter-set variant → NOT primary (hidden from selector).
    assert by_name["rossi_peaks"] is False


def test_dataset_manifest_log10p_cols(
    fresh_duckdb: duckdb.DuckDBPyConnection,
) -> None:
    """v6: pvalue_col / log10p_col / neglog10p_col are carried from
    DATASET_MEASUREMENT_COLUMNS. callingcards / hackett both have '' for log10p
    (only base rossi / chec_m2025 carry a log10p_col). rossi_peaks is the
    variant + peak_score path: its pvalue_col AND log10p_col/neglog10p_col are
    all '' even though its parent (rossi) carries a log10p_col — variants keep
    '' as a deliberate local decision (see DATASET_MEASUREMENT_COLUMNS note)."""
    config = yaml.safe_load(_SAMPLE_YAML)
    write_dataset_manifest(fresh_duckdb, config)
    rows = fresh_duckdb.execute(
        "SELECT db_name, pvalue_col, log10p_col, neglog10p_col "
        "FROM dataset_manifest ORDER BY db_name"
    ).fetchall()
    by_name = {db: (pv, l10, nl10) for (db, pv, l10, nl10) in rows}
    assert by_name["callingcards"] == ("poisson_pval", "", "")
    assert by_name["hackett"] == ("", "", "")
    # rossi_peaks: peak_score binding score, no p-value, no log10p columns.
    assert by_name["rossi_peaks"] == ("", "", "")


def test_dataset_measurement_columns_log10p_parity() -> None:
    """v6: only base rossi / chec_m2025 carry log10p_col=log_poisson_pval;
    every other dataset (incl. all promoter-set variants) is ''. neglog10p_col
    is '' for every dataset. Guards the reference DATASET_COLUMNS mapping."""
    log10p_nonempty = {
        db
        for db, (_eff, _pv, l10, _nl10) in DATASET_MEASUREMENT_COLUMNS.items()
        if l10 != ""
    }
    assert log10p_nonempty == {"rossi", "chec_m2025"}
    assert DATASET_MEASUREMENT_COLUMNS["rossi"][2] == "log_poisson_pval"
    assert DATASET_MEASUREMENT_COLUMNS["chec_m2025"][2] == "log_poisson_pval"
    # All promoter-set variants keep log10p_col='' even though their parent
    # carries one.
    for variant in (
        "rossi_mindel",
        "rossi_500bp",
        "rossi_intergenic",
        "rossi_peaks",
        "chec_m2025_mindel",
        "chec_m2025_500bp",
        "chec_m2025_intergenic",
        "chec_m2025_peaks",
    ):
        assert DATASET_MEASUREMENT_COLUMNS[variant][2] == "", variant
    # neglog10p_col is universally empty.
    for db, cols in DATASET_MEASUREMENT_COLUMNS.items():
        assert cols[3] == "", db


def test_dataset_manifest_carries_description(
    fresh_duckdb: duckdb.DuckDBPyConnection,
) -> None:
    """DM-2: the per-dataset YAML description is read into
    dataset_manifest.description, with folded-scalar whitespace normalized to a
    single clean line."""
    config = {
        "repositories": {
            "BrentLab/callingcards": {
                "dataset": {
                    "cc": {
                        "tags": {
                            "data_type": "binding",
                            "assay": "CallingCards",
                            "display_name": "CC",
                        },
                        "db_name": "callingcards",
                        "sample_id": {"field": "gm_id"},
                        "description": "Data generated\n  with calling cards,\n  near TF sites.",
                    },
                },
            },
        },
    }
    write_dataset_manifest(fresh_duckdb, config)
    desc = fresh_duckdb.execute(
        "SELECT description FROM dataset_manifest WHERE db_name='callingcards'"
    ).fetchone()[0]
    assert desc == "Data generated with calling cards, near TF sites."
    # A dataset without a YAML description gets the empty default.
    config["repositories"]["BrentLab/callingcards"]["dataset"]["cc"].pop("description")
    write_dataset_manifest(fresh_duckdb, config)
    desc2 = fresh_duckdb.execute(
        "SELECT description FROM dataset_manifest WHERE db_name='callingcards'"
    ).fetchone()[0]
    assert desc2 == ""


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
    n_total = fresh_duckdb.execute("SELECT COUNT(*) FROM dataset_manifest").fetchone()[
        0
    ]
    assert n_distinct == n_total


def _seed_two_datasets(conn: duckdb.DuckDBPyConnection) -> None:
    conn.execute(
        "CREATE TABLE callingcards (gm_id VARCHAR, regulator_locus_tag VARCHAR, "
        "target_locus_tag VARCHAR, score DOUBLE)"
    )
    # Mirrors real callingcards_meta: NO experimental-condition column (only the
    # sample-id join key, hidden regulator identifiers, and the hidden
    # background_total_hops). The condition-bearing binding dataset is harbison
    # below. (`condition` is exercised on harbison, which genuinely has it.)
    conn.execute(
        "CREATE TABLE callingcards_meta (gm_id VARCHAR, regulator_locus_tag "
        "VARCHAR, regulator_symbol VARCHAR, background_total_hops INTEGER)"
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


def _seed_shared_condition(conn: duckdb.DuckDBPyConnection) -> None:
    """Mirror the REAL labretriever artifact: metadata columns are replicated
    into BOTH ``{db}`` and ``{db}_meta``. The experimental-condition column
    ``condition`` lives in both tables (so the old ``data_cols ∩ meta_cols``
    join-key heuristic over-excluded it → P0-3), while the measurement columns
    ``effect``/``pvalue`` live only in the data table (so they must NOT become
    filter fields → SD-3)."""
    conn.execute(
        "CREATE TABLE harbison (sample_id VARCHAR, regulator_locus_tag VARCHAR, "
        "target_locus_tag VARCHAR, effect DOUBLE, pvalue DOUBLE, condition VARCHAR)"
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
        "('harbison', 'binding', 'ChIP-chip', 'harbison', "
        "'BrentLab/harbison_2004', 'sample_id', 'effect', 'pvalue')"
    )


def test_field_manifest_meta_only_keeps_shared_condition(
    fresh_duckdb: duckdb.DuckDBPyConnection,
) -> None:
    """P0-3 / SD-3 regression: field_manifest must derive from ``{db}_meta``
    only, keep the experimental-condition column even when it is also
    replicated into the data table (and even though it is in
    HIDDEN_FILTER_FIELDS), and exclude data-only measurement columns."""
    _seed_shared_condition(fresh_duckdb)
    write_field_manifest(fresh_duckdb)
    fields = {
        row[0]
        for row in fresh_duckdb.execute(
            "SELECT field FROM field_manifest WHERE db_name = 'harbison'"
        ).fetchall()
    }
    # condition: experimental-condition meta column shared into the data table
    # — must survive (P0-3, even though hidden in Shiny's Title-Case UI).
    assert "condition" in fields
    # effect/pvalue/target_locus_tag: data-only — never filter fields (SD-3).
    assert "effect" not in fields
    assert "pvalue" not in fields
    assert "target_locus_tag" not in fields
    role = fresh_duckdb.execute(
        "SELECT role FROM field_manifest "
        "WHERE db_name='harbison' AND field='condition'"
    ).fetchone()[0]
    assert role == "experimental_condition"


def test_field_manifest_one_row_per_legal_field(
    fresh_duckdb: duckdb.DuckDBPyConnection,
) -> None:
    _seed_two_datasets(fresh_duckdb)
    write_field_manifest(fresh_duckdb)

    by_db = {}
    for db, field in fresh_duckdb.execute(
        "SELECT db_name, field FROM field_manifest"
    ).fetchall():
        by_db.setdefault(db, set()).add(field)
    cc_fields = by_db.get("callingcards", set())
    hb_fields = by_db.get("harbison", set())
    # field_manifest derives from {db}_meta ONLY (SD-3): the data-only columns
    # target_locus_tag / score are NOT filter fields. callingcards_meta carries
    # {gm_id (=sample_id join key), regulator_locus_tag, regulator_symbol,
    # background_total_hops}; the join key + globally/locally hidden fields are
    # all excluded and callingcards has no experimental-condition column, so it
    # contributes NO filter fields (mirrors real data).
    assert cc_fields == set()
    # harbison_meta carries the experimental-condition `condition`, which
    # survives even though it is in HIDDEN_FILTER_FIELDS (the exp-cond override).
    assert hb_fields == {"condition"}


def test_field_manifest_excludes_globally_hidden(
    fresh_duckdb: duckdb.DuckDBPyConnection,
) -> None:
    _seed_two_datasets(fresh_duckdb)
    write_field_manifest(fresh_duckdb)
    forbidden = HIDDEN_FILTER_FIELDS["*"]
    rows = fresh_duckdb.execute("SELECT field FROM field_manifest").fetchall()
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
    """harbison.condition is tagged role='experimental_condition' and survives
    even though it is in HIDDEN_FILTER_FIELDS (the exp-cond override; Shiny
    shows the Title-Case "Experimental condition", the rewrite uses the
    lowercase machine column). callingcards is LISTED in
    EXPERIMENTAL_CONDITION_FIELDS but its meta table has no `condition` column,
    so the intersection in write_field_manifest yields no row — exercising the
    real-data condition-absence path."""
    assert "condition" in EXPERIMENTAL_CONDITION_FIELDS["callingcards"]
    assert "condition" in EXPERIMENTAL_CONDITION_FIELDS["harbison"]
    _seed_two_datasets(fresh_duckdb)
    write_field_manifest(fresh_duckdb)
    rows = fresh_duckdb.execute(
        "SELECT db_name, field, role FROM field_manifest " "ORDER BY db_name, field"
    ).fetchall()
    role_by_key = {(db, f): r for (db, f, r) in rows}
    # harbison.condition is in HIDDEN_FILTER_FIELDS["harbison"] but is an
    # experimental-condition field, so it is kept with the role set.
    assert role_by_key[("harbison", "condition")] == "experimental_condition"
    # callingcards lists `condition` in EXPERIMENTAL_CONDITION_FIELDS but its
    # meta table lacks the column, so it is correctly intersected away — no
    # phantom field_manifest row (the bug class this fix closes).
    assert ("callingcards", "condition") not in role_by_key


def test_condition_cols_is_single_source_of_truth() -> None:
    """DM-1/DM-5: CONDITION_COLS is derived from EXPERIMENTAL_CONDITION_FIELDS
    (the single source of truth), so the two can never silently disagree, and
    hidden non-experimental-condition columns (e.g. hackett mechanism/restriction)
    never appear in condition_cols."""
    from data_prep.manifests import CONDITION_COLS

    for db, cols in CONDITION_COLS.items():
        assert set(cols) == set(EXPERIMENTAL_CONDITION_FIELDS[db]), db
    # hackett's hover label must be driven by `time` alone, not the hidden
    # mechanism/restriction columns.
    assert CONDITION_COLS["hackett"] == ["time"]
    # all five filterable datasets are present and consistent.
    assert set(EXPERIMENTAL_CONDITION_FIELDS) >= {
        "callingcards",
        "harbison",
        "rossi",
        "chec_m2025",
        "hackett",
    }


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
    """Tables where condition has 2 distinct values, score has many. Uses
    harbison — the binding dataset with a real `condition` column (callingcards
    has none on real data)."""
    conn.execute(
        "CREATE TABLE harbison (sample_id VARCHAR, target_locus_tag VARCHAR, "
        "score DOUBLE)"
    )
    conn.execute(
        "CREATE TABLE harbison_meta (sample_id VARCHAR, "
        "regulator_locus_tag VARCHAR, condition VARCHAR)"
    )
    conn.execute(
        "INSERT INTO harbison_meta VALUES "
        "('hb_0', 'YBR289W', 'YPD'), "
        "('hb_1', 'YML007W', 'SC'), "
        "('hb_2', 'YGL073W', 'YPD')"
    )
    # field_manifest must exist; populate with the legal fields.
    conn.execute(
        "CREATE TABLE field_manifest (db_name VARCHAR, field VARCHAR, "
        "PRIMARY KEY (db_name, field))"
    )
    conn.execute(
        "INSERT INTO field_manifest VALUES "
        "('harbison', 'condition'), "
        "('harbison', 'target_locus_tag'), "
        "('harbison', 'score')"
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
            "WHERE db_name = 'harbison' AND field = 'condition' "
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
    targets = [
        (f"hb_t_{i}", f"YAL{i:03d}C", 0.1) for i in range(LEVEL_CACHE_THRESHOLD + 5)
    ]
    fresh_duckdb.executemany("INSERT INTO harbison VALUES (?, ?, ?)", targets)
    write_filter_level_cache(fresh_duckdb)
    n = fresh_duckdb.execute(
        "SELECT COUNT(*) FROM filter_level_cache "
        "WHERE db_name = 'harbison' AND field = 'target_locus_tag'"
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
        "SELECT COUNT(*) FROM filter_level_cache " "WHERE field = 'regulator_locus_tag'"
    ).fetchone()[0]
    assert n == 0


# ---------------------------------------------------------------------------
# A6: default_filters ⊆ field_manifest tripwire (P0-3 regression guard)
# ---------------------------------------------------------------------------


def _seed_hackett_for_assertion(
    conn: duckdb.DuckDBPyConnection, *, with_time: bool
) -> None:
    meta_cols = (
        "sample_id VARCHAR, regulator_locus_tag VARCHAR, regulator_symbol VARCHAR"
    )
    if with_time:
        meta_cols += ", time INTEGER"
    conn.execute(f"CREATE TABLE hackett_meta ({meta_cols})")
    conn.execute(
        "CREATE TABLE hackett (sample_id VARCHAR, regulator_locus_tag VARCHAR, "
        "target_locus_tag VARCHAR)"
    )
    conn.execute(
        "CREATE TABLE callingcards_meta (sample_id VARCHAR, "
        "regulator_locus_tag VARCHAR, regulator_symbol VARCHAR)"
    )
    write_dataset_manifest(conn, yaml.safe_load(_SAMPLE_YAML))


def test_assert_default_filters_present_passes(
    fresh_duckdb: duckdb.DuckDBPyConnection,
) -> None:
    _seed_hackett_for_assertion(fresh_duckdb, with_time=True)
    write_field_manifest(fresh_duckdb)
    # hackett.time (a seeded default filter) is present → no raise.
    assert_default_filters_in_field_manifest(fresh_duckdb)


def test_assert_default_filters_missing_raises(
    fresh_duckdb: duckdb.DuckDBPyConnection,
) -> None:
    _seed_hackett_for_assertion(fresh_duckdb, with_time=False)
    write_field_manifest(fresh_duckdb)
    with pytest.raises(ValueError, match="field_manifest"):
        assert_default_filters_in_field_manifest(fresh_duckdb)


# ---------------------------------------------------------------------------
# DM-4: best-effort labretriever description / level_definitions harvest
# ---------------------------------------------------------------------------


class _FakeMeta:
    def __init__(self, *, role=None, level_definitions=None, description=""):
        self.role = role
        self.level_definitions = level_definitions
        self.description = description


class _FakeVDB:
    def __init__(self, data):
        self._data = data

    def get_column_metadata(self, db):
        return self._data.get(db)


class _BoomVDB:
    def get_column_metadata(self, db):  # noqa: ARG002
        raise RuntimeError("metadata extraction failed")


def test_harvest_column_metadata_collects_desc_and_levels() -> None:
    vdb = _FakeVDB(
        {
            "harbison": {
                "condition": _FakeMeta(
                    role="experimental_condition",
                    level_definitions={"YPD": "rich medium", "SM": "starvation"},
                    description="  Environmental condition  ",
                ),
                "regulator_locus_tag": _FakeMeta(role="regulator_identifier"),
            }
        }
    )
    out = harvest_column_metadata(vdb, ["harbison", "not_in_vdb"])
    assert out["harbison"]["condition"].description == "Environmental condition"
    import json as _json

    assert _json.loads(out["harbison"]["condition"].level_definitions) == {
        "SM": "starvation",
        "YPD": "rich medium",
    }
    # A column with neither description nor level_definitions is omitted.
    assert "regulator_locus_tag" not in out["harbison"]
    # A dataset absent from the vdb is omitted.
    assert "not_in_vdb" not in out


def test_harvest_column_metadata_is_best_effort() -> None:
    # A vdb whose metadata extraction raises must degrade to {}, never fail
    # the build.
    assert harvest_column_metadata(_BoomVDB(), ["harbison"]) == {}
    # A vdb without the method at all also degrades.
    assert harvest_column_metadata(object(), ["harbison"]) == {}
    # A malformed PER-COLUMN shape (level_definitions is a list, not a mapping;
    # description is a non-string) must also degrade that dataset to {} rather
    # than raising — the per-column parse is inside the try/except.
    bad = _FakeVDB(
        {
            "harbison": {
                "condition": _FakeMeta(level_definitions=["not", "a", "mapping"]),
                "other": _FakeMeta(description=12345),  # non-string
            }
        }
    )
    assert harvest_column_metadata(bad, ["harbison"]) == {}


def test_field_manifest_uses_harvested_metadata(
    fresh_duckdb: duckdb.DuckDBPyConnection,
) -> None:
    """When column_metadata is supplied, field_manifest.description /
    level_definitions are populated from it (DM-4)."""
    _seed_two_datasets(fresh_duckdb)
    cm = {
        "harbison": {
            "condition": harvest_column_metadata(
                _FakeVDB(
                    {
                        "harbison": {
                            "condition": _FakeMeta(
                                level_definitions={"YPD": "rich"},
                                description="growth condition",
                            )
                        }
                    }
                ),
                ["harbison"],
            )["harbison"]["condition"]
        }
    }
    write_field_manifest(fresh_duckdb, cm)
    desc, lvl = fresh_duckdb.execute(
        "SELECT description, level_definitions FROM field_manifest "
        "WHERE db_name='harbison' AND field='condition'"
    ).fetchone()
    assert desc == "growth condition"
    assert lvl == '{"YPD":"rich"}'
