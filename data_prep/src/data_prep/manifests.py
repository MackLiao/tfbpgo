"""Builders for the four manifest tables consumed by the Go service.

See spec §5.5 for the contract. These are the *new* tables added by the
rewrite — separate from the VirtualDB compatibility layer (which is
materialized in materialize.py).
"""

from __future__ import annotations

import duckdb

# Bump when the set of §5.5 tables, or the meaning of their columns,
# changes. The Go binary embeds the compatible range and refuses to
# start against an artifact outside it.
SCHEMA_VERSION: int = 1


def write_artifact_manifest(
    conn: duckdb.DuckDBPyConnection,
    *,
    artifact_version: str,
    source_yaml_sha256: str,
    parity_tests_passed: bool,
) -> None:
    """Create or replace the single-row artifact_manifest table.

    duckdb_version is read from the running duckdb library; built_at is
    captured at write time. Idempotent: re-running replaces the row.
    """
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
        """
        INSERT INTO artifact_manifest VALUES (
            ?, ?, CURRENT_TIMESTAMP, ?, ?, ?
        )
        """,
        [
            artifact_version,
            SCHEMA_VERSION,
            source_yaml_sha256,
            duckdb.__version__,
            parity_tests_passed,
        ],
    )


def write_dataset_manifest(
    conn: duckdb.DuckDBPyConnection,
    config: dict,
) -> None:
    """Create or replace dataset_manifest from a parsed YAML config dict.

    Skips entries whose dataset block has no `tags` (e.g., the comparative
    `dto` entry). Those tables still exist in the artifact but are not
    user-selectable datasets.
    """
    rows: list[tuple[str, str, str, str, str]] = []
    for repo_id, repo_block in (config.get("repositories") or {}).items():
        datasets = (repo_block or {}).get("dataset") or {}
        for _ds_key, ds_cfg in datasets.items():
            tags = (ds_cfg or {}).get("tags")
            db_name = (ds_cfg or {}).get("db_name")
            if not tags or not db_name:
                continue
            rows.append(
                (
                    db_name,
                    tags.get("data_type", ""),
                    tags.get("assay", ""),
                    tags.get("display_name", ""),
                    repo_id,
                )
            )

    db_names = [r[0] for r in rows]
    if len(set(db_names)) != len(db_names):
        dupes = sorted({x for x in db_names if db_names.count(x) > 1})
        raise ValueError(f"duplicate db_name in YAML config: {dupes}")

    conn.execute("DROP TABLE IF EXISTS dataset_manifest")
    conn.execute(
        """
        CREATE TABLE dataset_manifest (
            db_name      VARCHAR PRIMARY KEY,
            data_type    VARCHAR NOT NULL,
            assay        VARCHAR NOT NULL,
            display_name VARCHAR NOT NULL,
            source_repo  VARCHAR NOT NULL
        )
        """
    )
    conn.executemany(
        "INSERT INTO dataset_manifest VALUES (?, ?, ?, ?, ?)", rows
    )
