"""Build a small synthetic DuckDB fixture used by all unit tests.

This module deliberately has no HF / labretriever dependency so the fixture
can be rebuilt offline in CI, and so unit tests of manifests.py and
materialize.py have a known-shape substrate to run against.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import duckdb

# Three regulators, two datasets, deterministic content.
_REGULATORS = [
    ("YBR289W", "SNF5"),
    ("YML007W", "YAP1"),
    ("YGL073W", "HSF1"),
]

_TARGETS = ["YAL001C", "YAL002W", "YAL003W", "YAL004W"]


def _create_callingcards(conn: duckdb.DuckDBPyConnection) -> None:
    conn.execute(
        """
        CREATE TABLE callingcards (
            gm_id VARCHAR,
            regulator_locus_tag VARCHAR,
            target_locus_tag VARCHAR,
            score DOUBLE
        )
        """
    )
    rows = []
    for i, (loc, _sym) in enumerate(_REGULATORS):
        gm_id = f"cc_{i}"
        for j, tgt in enumerate(_TARGETS):
            rows.append((gm_id, loc, tgt, float(j + 1) * 0.1))
    conn.executemany(
        "INSERT INTO callingcards VALUES (?, ?, ?, ?)", rows
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
    meta_rows = [
        (f"cc_{i}", loc, sym, "YPD")
        for i, (loc, sym) in enumerate(_REGULATORS)
    ]
    # Add one extra meta row to exercise dedup behavior in regulator_display_names
    meta_rows.append(("cc_extra", _REGULATORS[0][0], _REGULATORS[0][1], "SC"))
    conn.executemany(
        "INSERT INTO callingcards_meta VALUES (?, ?, ?, ?)", meta_rows
    )


def _create_hackett(conn: duckdb.DuckDBPyConnection) -> None:
    conn.execute(
        """
        CREATE TABLE hackett (
            sample_id VARCHAR,
            regulator_locus_tag VARCHAR,
            target_locus_tag VARCHAR,
            effect DOUBLE,
            pvalue DOUBLE
        )
        """
    )
    h_rows = []
    for i, (loc, _sym) in enumerate(_REGULATORS):
        sample_id = f"h_{i}"
        for j, tgt in enumerate(_TARGETS):
            h_rows.append((sample_id, loc, tgt, float(i - j) * 0.5, 0.01 * (j + 1)))
    conn.executemany(
        "INSERT INTO hackett VALUES (?, ?, ?, ?, ?)", h_rows
    )

    conn.execute(
        """
        CREATE TABLE hackett_meta (
            sample_id VARCHAR,
            regulator_locus_tag VARCHAR,
            regulator_symbol VARCHAR,
            mechanism VARCHAR,
            restriction VARCHAR,
            time DOUBLE,
            date VARCHAR,
            strain VARCHAR
        )
        """
    )
    # One ZEV/P, one GEV/P, one GEV/M — required by ensure_hackett_analysis_set tiers
    meta_rows = [
        ("h_0", _REGULATORS[0][0], _REGULATORS[0][1], "ZEV", "P", 45.0, "2020-01-01", "BY4741"),
        ("h_1", _REGULATORS[1][0], _REGULATORS[1][1], "GEV", "P", 45.0, "2020-01-01", "BY4741"),
        ("h_2", _REGULATORS[2][0], _REGULATORS[2][1], "GEV", "M", 45.0, "2020-01-01", "BY4741"),
        # Add an extra row that should be filtered out by the tier logic
        ("h_3", _REGULATORS[0][0], _REGULATORS[0][1], "GEV", "M", 45.0, "2020-01-02", "BY4741"),
    ]
    conn.executemany(
        "INSERT INTO hackett_meta VALUES (?, ?, ?, ?, ?, ?, ?, ?)", meta_rows
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
