"""Build a small synthetic DuckDB fixture used by all unit tests + parity.

The output fixture is a fully self-contained artifact-shape DuckDB file:

- VirtualDB-shape per-dataset tables (`callingcards`, `hackett`, etc.) plus
  their `_meta` companion tables — extended with the production-only
  columns the Go service references (`callingcards.poisson_pval`,
  `callingcards.callingcards_enrichment`, `callingcards.sample_id`,
  `hackett.log2_shrunken_timecourses`, etc.).
- §5.5 manifest tables: `artifact_manifest`, `dataset_manifest`,
  `field_manifest`, `filter_level_cache`.
- Derived tables: `hackett_analysis_set`, `regulator_display_names`,
  `dto_expanded`.
- An empty `harbison`/`harbison_meta` stub so the DTO query
  (which references `FROM harbison` even when no dto row is sourced from
  harbison) can be executed.

This module deliberately has no HF / labretriever dependency so the fixture
can be rebuilt offline in CI, and so the Go service can be booted directly
against it without an additional bootstrap step.

The fixture is deterministic: rebuilding it always produces the same row
content (built_at is pinned to a constant so the artifact_manifest is
byte-stable for snapshot tests).
"""

from __future__ import annotations

import argparse
from pathlib import Path

import duckdb

# Pinned constants for the artifact_manifest so the snapshot tests
# get byte-stable output across rebuilds.
_FIXTURE_ARTIFACT_VERSION = "test-fixture"
_FIXTURE_SCHEMA_VERSION = 3
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


def _linspace(lo: float, hi: float, n: int) -> list[float]:
    """Inclusive evenly-spaced floats — no numpy dependency."""
    if n <= 1:
        return [lo]
    step = (hi - lo) / (n - 1)
    return [lo + step * i for i in range(n)]


def _create_callingcards(conn: duckdb.DuckDBPyConnection) -> None:
    """callingcards data + meta — extended with production columns.

    Columns added vs. the early Phase-1 fixture:
    - sample_id   (used by the comparison/topn binding CTE)
    - poisson_pval (rank column for callingcards in topn)
    - callingcards_enrichment (measurement column in binding/data)

    `gm_id` is retained because dataset_manifest.sample_id_field still
    points at it for the join-key introspection in field_manifest.
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
    # poisson_pval: evenly spaced in [1e-6, 0.05] across the row index.
    # callingcards_enrichment: evenly spaced in [0.1, 5.0] across the row index.
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
                rows.append((
                    gm_id,
                    sample_id,
                    loc,
                    tgt,
                    float(j + 1) * 0.1,
                    pvals[row_idx],
                    enrich[row_idx],
                ))
                row_idx += 1
    conn.executemany(
        "INSERT INTO callingcards VALUES (?, ?, ?, ?, ?, ?, ?)", rows
    )

    conn.execute(
        """
        CREATE TABLE callingcards_meta (
            gm_id VARCHAR,
            regulator_locus_tag VARCHAR,
            regulator_symbol VARCHAR,
            condition VARCHAR
        )
        """
    )
    meta_rows: list[tuple] = []
    for i, (loc, sym) in enumerate(_REGULATORS):
        for sid_suffix in ("a", "b"):
            meta_rows.append((f"cc_{i}_{sid_suffix}", loc, sym, "YPD"))
    # Extra row to exercise dedup in regulator_display_names.
    meta_rows.append(("cc_extra", _REGULATORS[0][0], _REGULATORS[0][1], "SC"))
    conn.executemany(
        "INSERT INTO callingcards_meta VALUES (?, ?, ?, ?)", meta_rows
    )


def _create_hackett(conn: duckdb.DuckDBPyConnection) -> None:
    """hackett data + meta — extended with production columns.

    Columns added vs. the early Phase-1 fixture:
    - log2_shrunken_timecourses (measurement column in perturbation/data
      and ABS-thresholded in the topn responsive_expr)

    `effect` and `pvalue` are kept because field_manifest in the existing
    parity snapshot still surfaces them.
    """
    conn.execute(
        """
        CREATE TABLE hackett (
            sample_id VARCHAR,
            regulator_locus_tag VARCHAR,
            target_locus_tag VARCHAR,
            effect DOUBLE,
            pvalue DOUBLE,
            log2_shrunken_timecourses DOUBLE
        )
        """
    )
    # 3 regulators × 5 targets = 15 rows.
    # log2_shrunken_timecourses: evenly spaced in [-3.0, 3.0]; effect mirrors it.
    # pvalue: evenly spaced in [1e-6, 0.04].
    total = len(_REGULATORS) * len(_TARGETS)
    log2 = _linspace(-3.0, 3.0, total)
    pvals = _linspace(1e-6, 0.04, total)

    h_rows: list[tuple] = []
    row_idx = 0
    for i, (loc, _sym) in enumerate(_REGULATORS):
        sample_id = f"h_{i}"
        for _j, tgt in enumerate(_TARGETS):
            v = log2[row_idx]
            pv = pvals[row_idx]
            h_rows.append((sample_id, loc, tgt, v, pv, v))
            row_idx += 1
    conn.executemany(
        "INSERT INTO hackett VALUES (?, ?, ?, ?, ?, ?)", h_rows
    )

    # Time is INTEGER (45) here because the topn join filters on `has.time = 45`
    # (integer literal in Go-side SQL) and float-vs-int comparisons under
    # duckdb-go can be brittle.
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
    # One ZEV/P, one GEV/P, one GEV/M — required by ensure_hackett_analysis_set tiers
    meta_rows = [
        ("h_0", _REGULATORS[0][0], _REGULATORS[0][1], "ZEV", "P", 45, "2020-01-01", "BY4741"),
        ("h_1", _REGULATORS[1][0], _REGULATORS[1][1], "GEV", "P", 45, "2020-01-01", "BY4741"),
        ("h_2", _REGULATORS[2][0], _REGULATORS[2][1], "GEV", "M", 45, "2020-01-01", "BY4741"),
        # Add an extra row that should be filtered out by the tier logic
        ("h_3", _REGULATORS[0][0], _REGULATORS[0][1], "GEV", "M", 45, "2020-01-02", "BY4741"),
    ]
    conn.executemany(
        "INSERT INTO hackett_meta VALUES (?, ?, ?, ?, ?, ?, ?, ?)", meta_rows
    )


def _create_harbison_stub(conn: duckdb.DuckDBPyConnection) -> None:
    """Empty harbison/harbison_meta stub.

    The DTO query references `FROM harbison` unconditionally inside a LEFT
    JOIN, so the table must exist even when no fixture dto row originates
    from harbison. Keeping it empty keeps the dto output deterministic.
    """
    conn.execute(
        """
        CREATE TABLE harbison (
            sample_id VARCHAR,
            regulator_locus_tag VARCHAR,
            target_locus_tag VARCHAR,
            pvalue DOUBLE,
            effect DOUBLE,
            condition VARCHAR
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE harbison_meta (
            sample_id VARCHAR,
            regulator_locus_tag VARCHAR,
            regulator_symbol VARCHAR,
            condition VARCHAR
        )
        """
    )


def _create_dto_expanded(conn: duckdb.DuckDBPyConnection) -> None:
    """Synthetic dto_expanded with two rows.

    Columns mirror the production schema referenced by
    backend/internal/queries/comparison/dto.sql. Two rows wire callingcards
    (binding side) to hackett (perturbation side) for two of the three
    regulators, so the comparison/dto golden URL produces a small,
    deterministic, non-empty result.
    """
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
        # (b_src, b_id, p_src, p_id, pr_col, emp_pval, fdr, b_size, p_size)
        ("callingcards", "cc_0_a", "hackett", "h_0", "log2fc", 0.001, 0.01, 100, 50),
        ("callingcards", "cc_1_a", "hackett", "h_1", "log2fc", 0.005, 0.03, 100, 50),
    ]
    conn.executemany(
        "INSERT INTO dto_expanded VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", rows
    )


def _create_manifests(conn: duckdb.DuckDBPyConnection) -> None:
    """Create the §5.5 manifest tables with deterministic content.

    Mirrors the schema in data_prep.manifests but does so inline so the
    fixture is self-contained and can be rebuilt without invoking the
    HuggingFace-bound pipeline.
    """
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

    conn.execute(
        """
        CREATE TABLE dataset_manifest (
            db_name         VARCHAR PRIMARY KEY,
            data_type       VARCHAR NOT NULL,
            assay           VARCHAR NOT NULL,
            display_name    VARCHAR NOT NULL,
            source_repo     VARCHAR NOT NULL,
            sample_id_field VARCHAR NOT NULL,
            effect_col      VARCHAR NOT NULL,
            pvalue_col      VARCHAR NOT NULL
        )
        """
    )
    conn.executemany(
        "INSERT INTO dataset_manifest VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [
            (
                "callingcards",
                "binding",
                "CallingCards",
                "Calling Cards",
                "BrentLab/callingcards",
                "gm_id",
                "callingcards_enrichment",
                "poisson_pval",
            ),
            (
                "hackett",
                "perturbation",
                "overexpression",
                "Hackett 2020",
                "BrentLab/hackett_2020",
                "sample_id",
                "log2_shrunken_timecourses",
                # Intentionally empty: existing buildResponsiveExpr semantics
                # do not gate hackett on a p-value column.
                "",
            ),
        ],
    )

    conn.execute(
        """
        CREATE TABLE field_manifest (
            db_name VARCHAR NOT NULL,
            field   VARCHAR NOT NULL,
            role    VARCHAR NOT NULL,
            PRIMARY KEY (db_name, field)
        )
        """
    )
    # Mirror the introspection rule in manifests.write_field_manifest:
    # union data + meta columns, drop join keys + hidden + structural columns.
    # callingcards: keep score, poisson_pval, callingcards_enrichment,
    #   target_locus_tag (regulator_* hidden, gm_id is join key, sample_id
    #   structural, condition meta is fine).
    # hackett: keep effect, pvalue, log2_shrunken_timecourses,
    #   target_locus_tag (regulator_* hidden, date/mechanism/restriction/strain
    #   hidden, time is allowed).
    # role='experimental_condition' for (callingcards, condition) and
    # (hackett, time); '' otherwise.
    conn.executemany(
        "INSERT INTO field_manifest VALUES (?, ?, ?)",
        [
            ("callingcards", "target_locus_tag", ""),
            ("callingcards", "score", ""),
            ("callingcards", "poisson_pval", ""),
            ("callingcards", "callingcards_enrichment", ""),
            ("callingcards", "condition", "experimental_condition"),
            ("hackett", "target_locus_tag", ""),
            ("hackett", "effect", ""),
            ("hackett", "pvalue", ""),
            ("hackett", "log2_shrunken_timecourses", ""),
            ("hackett", "time", "experimental_condition"),
        ],
    )

    conn.execute(
        """
        CREATE TABLE filter_level_cache (
            db_name VARCHAR NOT NULL,
            field   VARCHAR NOT NULL,
            level   VARCHAR NOT NULL
        )
        """
    )
    # Only the categorical-ish low-cardinality fields warrant level caching.
    conn.executemany(
        "INSERT INTO filter_level_cache VALUES (?, ?, ?)",
        [
            ("callingcards", "condition", "SC"),
            ("callingcards", "condition", "YPD"),
            ("hackett", "time", "45"),
        ],
    )


def _create_hackett_analysis_set(conn: duckdb.DuckDBPyConnection) -> None:
    """hackett_analysis_set — the Phase-0 derived table.

    Computed from hackett_meta by the same tiered selection rule as
    data_prep.materialize._HACKETT_ANALYSIS_SET_SQL, inlined here to keep
    the fixture builder import-free.
    """
    conn.execute(
        """
        CREATE TABLE hackett_analysis_set AS
        WITH regulator_tiers AS (
            SELECT
                regulator_locus_tag,
                CASE
                    WHEN BOOL_OR(mechanism = 'ZEV' AND restriction = 'P') THEN 1
                    WHEN BOOL_OR(mechanism = 'GEV' AND restriction = 'P') THEN 2
                    ELSE 3
                END AS tier
            FROM hackett_meta
            GROUP BY regulator_locus_tag
        ),
        tier_filtered AS (
            SELECT
                h.sample_id,
                h.regulator_locus_tag,
                h.regulator_symbol,
                h.mechanism,
                h.restriction,
                h.time,
                h.date,
                h.strain,
                t.tier
            FROM hackett_meta h
            JOIN regulator_tiers t USING (regulator_locus_tag)
            WHERE
                (t.tier = 1 AND h.mechanism = 'ZEV' AND h.restriction = 'P')
                OR (t.tier = 2 AND h.mechanism = 'GEV' AND h.restriction = 'P')
                OR (t.tier = 3 AND h.mechanism = 'GEV' AND h.restriction = 'M')
        )
        SELECT DISTINCT
            sample_id,
            regulator_locus_tag,
            regulator_symbol,
            mechanism,
            restriction,
            time,
            date,
            strain
        FROM tier_filtered
        WHERE regulator_symbol NOT IN ('GCN4', 'RDS2', 'SWI1', 'MAC1')
        """
    )


def _create_regulator_display_names(conn: duckdb.DuckDBPyConnection) -> None:
    """regulator_display_names — union of dataset meta tables.

    Inlines the union over the two fixture datasets. The Phase-0
    materializer is dynamic over `dataset_manifest`; here we know the
    exact set and write it directly so the fixture has no transitive
    dependency on the manifest builders.
    """
    conn.execute(
        """
        CREATE TABLE regulator_display_names AS
        SELECT
            regulator_locus_tag,
            MIN(regulator_symbol) AS regulator_symbol,
            CASE
                WHEN MIN(regulator_symbol) IS NOT NULL
                     AND MIN(regulator_symbol) != ''
                     AND MIN(regulator_symbol) != regulator_locus_tag
                THEN MIN(regulator_symbol) || ' (' || regulator_locus_tag || ')'
                ELSE regulator_locus_tag
            END AS display_name
        FROM (
            SELECT DISTINCT regulator_locus_tag, regulator_symbol
            FROM callingcards_meta
            UNION ALL
            SELECT DISTINCT regulator_locus_tag, regulator_symbol
            FROM hackett_meta
        ) __all
        GROUP BY regulator_locus_tag
        ORDER BY regulator_locus_tag
        """
    )


def build_fixture(out_path: Path) -> None:
    """Create a small deterministic DuckDB at out_path. Overwrites if present."""
    out_path = Path(out_path)
    if out_path.exists():
        out_path.unlink()
    out_path.parent.mkdir(parents=True, exist_ok=True)

    conn = duckdb.connect(str(out_path))
    try:
        _create_callingcards(conn)
        _create_hackett(conn)
        _create_harbison_stub(conn)
        _create_dto_expanded(conn)
        _create_manifests(conn)
        _create_hackett_analysis_set(conn)
        _create_regulator_display_names(conn)
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
