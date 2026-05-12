"""Orchestrator for the data-prep pipeline.

Two entry points:

- build_full(...)        — labretriever + HF; produces the runtime artifact
- build_from_fixture(...) — copies a fixture in and runs only the manifests;
                            used by tests and by Phase 1 bootstrap

Both end with a CHECKPOINT and a close, leaving a self-contained DuckDB
file at out_path.
"""

from __future__ import annotations

import argparse
import hashlib
import shutil
from pathlib import Path

import duckdb
import yaml

from data_prep.manifests import (
    write_artifact_manifest,
    write_dataset_manifest,
    write_field_manifest,
    write_filter_level_cache,
)
from data_prep.materialize import (
    build_hackett_analysis_set,
    build_regulator_display_names,
)


def _sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def _run_manifests(
    conn: duckdb.DuckDBPyConnection,
    *,
    yaml_config_path: Path,
    artifact_version: str,
    parity_tests_passed: bool,
) -> None:
    config = yaml.safe_load(yaml_config_path.read_text())
    write_dataset_manifest(conn, config)

    db_names = [
        r[0]
        for r in conn.execute(
            "SELECT db_name FROM dataset_manifest ORDER BY db_name"
        ).fetchall()
    ]
    if "hackett" in db_names:
        # Reference vdb_init also conditionally filters hackett views; in
        # the fixture path this is harmless because the fixture already
        # contains plain tables.
        build_hackett_analysis_set(conn)
    build_regulator_display_names(conn, db_names=db_names)

    write_field_manifest(conn)
    write_filter_level_cache(conn)
    write_artifact_manifest(
        conn,
        artifact_version=artifact_version,
        source_yaml_sha256=_sha256_of(yaml_config_path),
        parity_tests_passed=parity_tests_passed,
    )


def build_from_fixture(
    *,
    fixture_path: Path,
    yaml_config_path: Path,
    out_path: Path,
    artifact_version: str,
) -> None:
    """Bootstrap an artifact-shaped file from the synthetic fixture.

    Copies fixture_path → out_path, then runs the manifest builders against
    it. Used in tests and to bootstrap Phase 1 development without HF
    access. The result has the same table set as a real artifact (modulo
    the synthetic vs. real row content).
    """
    out_path = Path(out_path)
    if out_path.exists():
        out_path.unlink()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(fixture_path, out_path)

    conn = duckdb.connect(str(out_path))
    try:
        _run_manifests(
            conn,
            yaml_config_path=yaml_config_path,
            artifact_version=artifact_version,
            parity_tests_passed=False,
        )
        conn.execute("CHECKPOINT")
    finally:
        conn.close()


def build_full(
    *,
    yaml_config_path: Path,
    out_path: Path,
    artifact_version: str,
    hf_token: str | None,
) -> None:
    """Real pipeline: labretriever populates views from HF, then we
    materialize them and build manifests. Implemented in Task 9 alongside
    its integration test, to keep the labretriever import out of the unit
    test path."""
    raise NotImplementedError(
        "build_full is implemented in Task 9 (see test_build_duckdb_smoke.py)"
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument(
        "--from-fixture",
        type=Path,
        default=None,
        help="Copy this fixture and run manifests only (bypasses HF).",
    )
    parser.add_argument("--artifact-version", required=True)
    parser.add_argument(
        "--hf-token",
        default=None,
        help="HF token; falls back to HF_TOKEN env var.",
    )
    args = parser.parse_args()

    if args.from_fixture is not None:
        build_from_fixture(
            fixture_path=args.from_fixture,
            yaml_config_path=args.config,
            out_path=args.out,
            artifact_version=args.artifact_version,
        )
    else:
        import os

        token = args.hf_token or os.environ.get("HF_TOKEN")
        build_full(
            yaml_config_path=args.config,
            out_path=args.out,
            artifact_version=args.artifact_version,
            hf_token=token,
        )
    print(f"Wrote {args.out}")


if __name__ == "__main__":
    main()
