"""Build a small synthetic DuckDB fixture used by all unit tests + parity.

The output fixture is a fully self-contained artifact-shape DuckDB file:

- VirtualDB-shape per-dataset tables (`callingcards`, `hackett`, `harbison`,
  `kemmeren`) plus their `_meta` companion tables — extended with the
  production-only columns the Go service references, AND mirroring the real
  labretriever materialization where the experimental-condition metadata
  columns (`condition`/`time`) are replicated into BOTH `{db}` and `{db}_meta`.
- §5.5 manifest tables: `artifact_manifest`, `dataset_manifest`,
  `field_manifest`, `filter_level_cache`.
- Derived tables: `hackett_analysis_set`, `regulator_display_names`,
  `dto_expanded`.

This module deliberately has no HF / labretriever dependency, BUT it builds the
manifest tables by calling the SAME builders as the real artifact pipeline
(`data_prep.manifests` / `data_prep.materialize`). This is intentional: the
2026-05-28 parity re-audit found that hand-coding the fixture manifests let
them drift from real-artifact shape, which is exactly what masked P0-3/SD-3
(`field_manifest` over-/under-inclusion) and SQL-1 (unfiltered hackett). Driving
the fixture through the real builders means the synthetic fixture and the
production artifact derive their manifests identically — the fixture can only
mask a bug if the real builder would too.

Only `artifact_manifest` is written by hand, with a pinned `built_at` /
`duckdb_version`, so snapshot tests stay byte-stable across rebuilds.

The fixture is deterministic: every builder it calls produces sorted,
timestamp-free output.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import duckdb

from data_prep.manifests import (
    SCHEMA_VERSION,
    assert_default_filters_in_field_manifest,
    write_field_manifest,
    write_filter_level_cache,
)
from data_prep.materialize import (
    build_hackett_analysis_set,
    build_regulator_display_names,
    filter_hackett_to_analysis_set,
)
from data_prep.manifests import write_dataset_manifest

# Pinned constants for the artifact_manifest so the snapshot tests
# get byte-stable output across rebuilds.
_FIXTURE_ARTIFACT_VERSION = "test-fixture"
_FIXTURE_SCHEMA_VERSION = SCHEMA_VERSION  # always track the code's schema version
_FIXTURE_BUILT_AT = "2026-01-01 00:00:00"
_FIXTURE_SOURCE_YAML_SHA256 = (
    "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
)
_FIXTURE_DUCKDB_VERSION = "test"

# Three regulators × five targets gives a non-trivial pivot table without
# blowing up the fixture size. Two sample_ids per regulator in callingcards
# exercise sample_id-grouped paths (e.g. top-N per-binding-sample rankings).
_REGULATORS = [
    ("YBR289W", "SNF5"),
    ("YML007W", "YAP1"),
    ("YGL073W", "HSF1"),
]

_TARGETS = ["YAL001C", "YAL002W", "YAL003W", "YAL004W", "YAL005C"]


# Trimmed YAML-shaped config covering exactly the datasets the fixture builds.
# Passed to the real write_dataset_manifest so dataset_manifest is derived the
# same way as production (no hand-coded drift). Every db_name here must have an
# entry in manifests.DATASET_MEASUREMENT_COLUMNS. One dataset carries a
# `description` so the DM-2 path is exercised end-to-end in the fixture too.
_FIXTURE_CONFIG: dict = {
    "repositories": {
        "BrentLab/callingcards": {
            "dataset": {
                "cc": {
                    "tags": {
                        "data_type": "binding",
                        "assay": "CallingCards",
                        "display_name": "Calling Cards",
                    },
                    "db_name": "callingcards",
                    "sample_id": {"field": "gm_id"},
                    "description": "Synthetic calling-cards fixture dataset.",
                },
            },
        },
        "BrentLab/harbison_2004": {
            "dataset": {
                "harbison_2004": {
                    "tags": {
                        "data_type": "binding",
                        "assay": "ChIP-chip",
                        "display_name": "Harbison 2004",
                    },
                    "db_name": "harbison",
                    "sample_id": {"field": "sample_id"},
                },
            },
        },
        "BrentLab/hackett_2020": {
            "dataset": {
                "hackett_2020": {
                    "tags": {
                        "data_type": "perturbation",
                        "assay": "overexpression",
                        "display_name": "Hackett 2020",
                    },
                    "db_name": "hackett",
                    "sample_id": {"field": "sample_id"},
                },
            },
        },
        "BrentLab/kemmeren_2014": {
            "dataset": {
                "kemmeren_2014": {
                    "tags": {
                        "data_type": "perturbation",
                        "assay": "TFKO",
                        "display_name": "Kemmeren 2014",
                    },
                    "db_name": "kemmeren",
                    "sample_id": {"field": "sample_id"},
                },
            },
        },
    },
}


def _linspace(lo: float, hi: float, n: int) -> list[float]:
    """Inclusive evenly-spaced floats — no numpy dependency."""
    if n <= 1:
        return [lo]
    step = (hi - lo) / (n - 1)
    return [lo + step * i for i in range(n)]


def _create_callingcards(conn: duckdb.DuckDBPyConnection) -> None:
    """callingcards data + meta — mirrors real-artifact shape.

    The materialized real artifact renames the source sample-id column `gm_id`
    to `sample_id`. Crucially, real `callingcards_meta` has **no**
    experimental-condition column — its only condition-like columns are the
    Title-Case display duplicates `Carbon source` / `Temperature`, which the Go
    rewrite cannot expose (SafeIdentRE forbids spaces). So callingcards has no
    manifest-eligible filter field and no hover-condition column at all; its
    dataset_manifest.condition_cols is empty and field_manifest has no
    callingcards row.

    The fixture deliberately mirrors this: callingcards carries NO `condition`
    column in either table. (An earlier fixture fabricated one, which masked
    the real-data bug where dataset_manifest.condition_cols claimed `condition`
    but the meta table had none — 500ing the sample-conditions query. The
    condition-filter / hover mechanics are exercised on harbison instead, which
    genuinely has a `condition` column.)
    """
    conn.execute(
        """
        CREATE TABLE callingcards (
            gm_id VARCHAR,
            sample_id VARCHAR,
            regulator_locus_tag VARCHAR,
            target_locus_tag VARCHAR,
            score DOUBLE,
            poisson_pval DOUBLE,
            callingcards_enrichment DOUBLE
        )
        """
    )

    # 3 regulators × 5 targets × 2 sample_ids = 30 rows.
    total = len(_REGULATORS) * len(_TARGETS) * 2
    pvals = _linspace(1e-6, 0.05, total)
    enrich = _linspace(0.1, 5.0, total)

    rows: list[tuple] = []
    row_idx = 0
    for i, (loc, _sym) in enumerate(_REGULATORS):
        for sid_suffix in ("a", "b"):
            sample_id = f"cc_{i}_{sid_suffix}"
            gm_id = sample_id  # reuse same value; dedup logic handles it
            for j, tgt in enumerate(_TARGETS):
                rows.append(
                    (
                        gm_id,
                        sample_id,
                        loc,
                        tgt,
                        float(j + 1) * 0.1,
                        pvals[row_idx],
                        enrich[row_idx],
                    )
                )
                row_idx += 1
    conn.executemany("INSERT INTO callingcards VALUES (?, ?, ?, ?, ?, ?, ?)", rows)

    conn.execute(
        """
        CREATE TABLE callingcards_meta (
            sample_id VARCHAR,
            regulator_locus_tag VARCHAR,
            regulator_symbol VARCHAR
        )
        """
    )
    meta_rows: list[tuple] = []
    for i, (loc, sym) in enumerate(_REGULATORS):
        for sid_suffix in ("a", "b"):
            meta_rows.append((f"cc_{i}_{sid_suffix}", loc, sym))
    # Extra row to exercise dedup in regulator_display_names.
    meta_rows.append(("cc_extra", _REGULATORS[0][0], _REGULATORS[0][1]))
    conn.executemany("INSERT INTO callingcards_meta VALUES (?, ?, ?)", meta_rows)


def _create_hackett(conn: duckdb.DuckDBPyConnection) -> None:
    """hackett data + meta — extended with production columns.

    `time` is replicated into the DATA table (real-artifact shape) in addition
    to `_meta`. The non-analysis-set sample `h_3` (GEV/M for the tier-1
    regulator YBR289W) is created in both tables and then removed by
    filter_hackett_to_analysis_set during build_fixture — this is the SQL-1
    regression vehicle: before the filter existed, h_3 leaked into every
    hackett query (matrix sample counts, breakdown, perturbation tab).
    """
    conn.execute(
        """
        CREATE TABLE hackett (
            sample_id VARCHAR,
            regulator_locus_tag VARCHAR,
            target_locus_tag VARCHAR,
            effect DOUBLE,
            pvalue DOUBLE,
            log2_shrunken_timecourses DOUBLE,
            time INTEGER
        )
        """
    )
    # 3 analysis-set samples (h_0..h_2) + 1 non-analysis-set sample (h_3).
    total = (len(_REGULATORS) + 1) * len(_TARGETS)
    log2 = _linspace(-3.0, 3.0, total)
    pvals = _linspace(1e-6, 0.04, total)

    sample_for = ["h_0", "h_1", "h_2", "h_3"]
    reg_for = [
        _REGULATORS[0][0],
        _REGULATORS[1][0],
        _REGULATORS[2][0],
        _REGULATORS[0][0],  # h_3 reuses regulator 0 (tier-1) → excluded
    ]
    h_rows: list[tuple] = []
    row_idx = 0
    for s_idx, sample_id in enumerate(sample_for):
        loc = reg_for[s_idx]
        for tgt in _TARGETS:
            v = log2[row_idx]
            pv = pvals[row_idx]
            h_rows.append((sample_id, loc, tgt, v, pv, v, 45))
            row_idx += 1
    conn.executemany("INSERT INTO hackett VALUES (?, ?, ?, ?, ?, ?, ?)", h_rows)

    conn.execute(
        """
        CREATE TABLE hackett_meta (
            sample_id VARCHAR,
            regulator_locus_tag VARCHAR,
            regulator_symbol VARCHAR,
            mechanism VARCHAR,
            restriction VARCHAR,
            time INTEGER,
            date VARCHAR,
            strain VARCHAR
        )
        """
    )
    # One ZEV/P, one GEV/P, one GEV/M — required by build_hackett_analysis_set
    # tiers — plus h_3 (GEV/M for a tier-1 regulator → excluded from the set).
    meta_rows = [
        (
            "h_0",
            _REGULATORS[0][0],
            _REGULATORS[0][1],
            "ZEV",
            "P",
            45,
            "2020-01-01",
            "BY4741",
        ),
        (
            "h_1",
            _REGULATORS[1][0],
            _REGULATORS[1][1],
            "GEV",
            "P",
            45,
            "2020-01-01",
            "BY4741",
        ),
        (
            "h_2",
            _REGULATORS[2][0],
            _REGULATORS[2][1],
            "GEV",
            "M",
            45,
            "2020-01-01",
            "BY4741",
        ),
        (
            "h_3",
            _REGULATORS[0][0],
            _REGULATORS[0][1],
            "GEV",
            "M",
            45,
            "2020-01-02",
            "BY4741",
        ),
    ]
    conn.executemany(
        "INSERT INTO hackett_meta VALUES (?, ?, ?, ?, ?, ?, ?, ?)", meta_rows
    )


def _create_kemmeren(conn: duckdb.DuckDBPyConnection) -> None:
    """Second perturbation dataset — un-masks perturbation multi-pair flows.

    Before the 2026-05-28 re-audit the fixture had a SINGLE perturbation
    dataset (hackett), so the perturbation correlation collapsed to an empty
    pair-set and the multi-pair boxplot / default-regulator / scatter paths
    were never exercised. kemmeren shares _REGULATORS / _TARGETS with hackett so
    the (hackett, kemmeren) corr pair produces joinable shared-regulator groups.

    effect_col=Madj, pvalue_col=pval (matches manifests.DATASET_MEASUREMENT_COLUMNS).
    """
    conn.execute(
        """
        CREATE TABLE kemmeren (
            sample_id VARCHAR,
            regulator_locus_tag VARCHAR,
            target_locus_tag VARCHAR,
            Madj DOUBLE,
            pval DOUBLE
        )
        """
    )
    total = len(_REGULATORS) * len(_TARGETS)
    madj = _linspace(-2.0, 2.0, total)
    pvals = _linspace(1e-5, 0.03, total)
    k_rows: list[tuple] = []
    row_idx = 0
    for i, (loc, _sym) in enumerate(_REGULATORS):
        sample_id = f"k_{i}"
        for tgt in _TARGETS:
            k_rows.append((sample_id, loc, tgt, madj[row_idx], pvals[row_idx]))
            row_idx += 1
    conn.executemany("INSERT INTO kemmeren VALUES (?, ?, ?, ?, ?)", k_rows)

    conn.execute(
        """
        CREATE TABLE kemmeren_meta (
            sample_id VARCHAR,
            regulator_locus_tag VARCHAR,
            regulator_symbol VARCHAR
        )
        """
    )
    km_meta = [(f"k_{i}", loc, sym) for i, (loc, sym) in enumerate(_REGULATORS)]
    conn.executemany("INSERT INTO kemmeren_meta VALUES (?, ?, ?)", km_meta)


def _create_harbison(conn: duckdb.DuckDBPyConnection) -> None:
    """Populated harbison binding dataset — the real-data regression vehicle.

    - `effect` is held CONSTANT (1.0) per regulator so the per-(regulator,
      sample_a, sample_b) correlation group has zero variance and DuckDB's
      corr() returns NaN — the case the /binding/corr dropna guard must drop.
    - ONE `effect` value is IEEE NaN so /binding?datasets=harbison returns a
      NaN measurement that must serialize as null, not 500.
    - `end` (INTEGER) is a SQL reserved keyword present in BOTH tables; it must
      be double-quoted at every interpolation site.
    - `condition` lives in BOTH tables (real-artifact shape) and is harbison's
      experimental-condition filter (DEFAULT_DATASET_FILTERS seeds it). It is
      ALSO the fixture's condition-mechanics vehicle (now that callingcards has
      no condition column): the meta carries a `hb_extra` sample for YBR289W
      with condition `SC` (every other sample is `YPD`), so filtering
      condition=YPD drops exactly one sample, condition=SC keeps exactly that
      one, and the breakdown sees YBR289W with 2 distinct conditions. The extra
      sample (id 199) is meta-only (no data rows), exactly like callingcards'
      `cc_extra`, so it perturbs neither the NaN-value nor the NaN-correlation
      regression paths.
    - `sample_id` is INTEGER (real harbison ids are integers, e.g. 121/132/151),
      not VARCHAR like the other fixture datasets. This is the regression vehicle
      for the empty-condition-labels-on-real-data bug: the sample-conditions
      hover map keys must be the canonical decimal STRING ("100", "199", ...) so
      they match the correlation overlay's lookup key (the /binding|perturbation
      /corr response scans db_a_id = a.sample_id into a Go string). The handler
      CASTs sample_id AS VARCHAR; before that fix, MapScan returned int64, the
      `.(string)` scan skipped every row, and labels came back empty.

    Shares _REGULATORS / _TARGETS with callingcards so /binding/corr over the
    pair (callingcards, harbison) produces joinable groups.
    """
    conn.execute(
        """
        CREATE TABLE harbison (
            sample_id INTEGER,
            regulator_locus_tag VARCHAR,
            target_locus_tag VARCHAR,
            pvalue DOUBLE,
            effect DOUBLE,
            "end" INTEGER,
            condition VARCHAR
        )
        """
    )
    pvals = _linspace(1e-4, 0.04, len(_REGULATORS) * len(_TARGETS))
    h_rows: list[tuple] = []
    idx = 0
    for i, (loc, _sym) in enumerate(_REGULATORS):
        sample_id = 100 + i  # INTEGER ids: 100, 101, 102 (mirrors real harbison)
        for j, tgt in enumerate(_TARGETS):
            effect = float("nan") if (i == 0 and j == 0) else 1.0
            end_coord = 1000 + idx
            h_rows.append((sample_id, loc, tgt, pvals[idx], effect, end_coord, "YPD"))
            idx += 1
    conn.executemany("INSERT INTO harbison VALUES (?, ?, ?, ?, ?, ?, ?)", h_rows)

    conn.execute(
        """
        CREATE TABLE harbison_meta (
            sample_id INTEGER,
            regulator_locus_tag VARCHAR,
            regulator_symbol VARCHAR,
            condition VARCHAR,
            "end" INTEGER
        )
        """
    )
    meta_rows = []
    for i, (loc, sym) in enumerate(_REGULATORS):
        meta_rows.append((100 + i, loc, sym, "YPD", 1000 + i))
    # Condition-mechanics vehicle: a meta-only extra sample (id 199) for YBR289W
    # (_REGULATORS[0]) with condition `SC`. Gives YBR289W two distinct
    # conditions (YPD via id 100, SC via id 199) while every other regulator
    # stays single-condition. `end` reuses id 100's coord so `end` stays
    # single-valued per regulator (only `condition` varies). No data rows, so
    # the binding NaN-value / NaN-correlation regression paths are untouched.
    meta_rows.append((199, _REGULATORS[0][0], _REGULATORS[0][1], "SC", 1000))
    conn.executemany("INSERT INTO harbison_meta VALUES (?, ?, ?, ?, ?)", meta_rows)


def _create_dto_expanded(conn: duckdb.DuckDBPyConnection) -> None:
    """Synthetic dto_expanded wiring callingcards (binding) → hackett
    (perturbation) for two regulators, so the comparison/dto + TopN paths
    produce a small deterministic non-empty result."""
    conn.execute(
        """
        CREATE TABLE dto_expanded (
            binding_id_source VARCHAR,
            binding_id_id VARCHAR,
            perturbation_id_source VARCHAR,
            perturbation_id_id VARCHAR,
            pr_ranking_column VARCHAR,
            dto_empirical_pvalue DOUBLE,
            dto_fdr DOUBLE,
            binding_set_size BIGINT,
            perturbation_set_size BIGINT
        )
        """
    )
    rows = [
        ("callingcards", "cc_0_a", "hackett", "h_0", "log2fc", 0.001, 0.01, 100, 50),
        ("callingcards", "cc_1_a", "hackett", "h_1", "log2fc", 0.005, 0.03, 100, 50),
    ]
    conn.executemany(
        "INSERT INTO dto_expanded VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", rows
    )


def _write_pinned_artifact_manifest(conn: duckdb.DuckDBPyConnection) -> None:
    """artifact_manifest with pinned built_at / duckdb_version so snapshot
    tests stay byte-stable. (The real builder stamps CURRENT_TIMESTAMP +
    duckdb.__version__, which would make the fixture non-deterministic.)"""
    conn.execute("DROP TABLE IF EXISTS artifact_manifest")
    conn.execute(
        """
        CREATE TABLE artifact_manifest (
            artifact_version    VARCHAR NOT NULL,
            schema_version      INTEGER NOT NULL,
            built_at            TIMESTAMP NOT NULL,
            source_yaml_sha256  VARCHAR NOT NULL,
            duckdb_version      VARCHAR NOT NULL,
            parity_tests_passed BOOLEAN NOT NULL
        )
        """
    )
    conn.execute(
        "INSERT INTO artifact_manifest VALUES (?, ?, CAST(? AS TIMESTAMP), ?, ?, FALSE)",
        [
            _FIXTURE_ARTIFACT_VERSION,
            _FIXTURE_SCHEMA_VERSION,
            _FIXTURE_BUILT_AT,
            _FIXTURE_SOURCE_YAML_SHA256,
            _FIXTURE_DUCKDB_VERSION,
        ],
    )


def build_fixture(out_path: Path) -> None:
    """Create a small deterministic DuckDB at out_path. Overwrites if present.

    Manifest tables are built by the REAL production builders so the fixture
    cannot drift from real-artifact shape (only artifact_manifest is pinned for
    snapshot stability).
    """
    out_path = Path(out_path)
    if out_path.exists():
        out_path.unlink()
    out_path.parent.mkdir(parents=True, exist_ok=True)

    db_names = ["callingcards", "harbison", "hackett", "kemmeren"]

    conn = duckdb.connect(str(out_path))
    try:
        _create_callingcards(conn)
        _create_hackett(conn)
        _create_harbison(conn)
        _create_kemmeren(conn)
        _create_dto_expanded(conn)

        # Manifests via the real builders (zero drift with production).
        write_dataset_manifest(conn, _FIXTURE_CONFIG)
        build_hackett_analysis_set(conn)
        filter_hackett_to_analysis_set(conn)  # SQL-1: drops h_3 from both tables
        build_regulator_display_names(conn, db_names=db_names)
        write_field_manifest(conn)  # no labretriever metadata in the fixture
        write_filter_level_cache(conn)
        assert_default_filters_in_field_manifest(conn)
        _write_pinned_artifact_manifest(conn)

        conn.execute("CHECKPOINT")
    finally:
        conn.close()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    build_fixture(args.out)
    print(f"Wrote {args.out}")


if __name__ == "__main__":
    main()
