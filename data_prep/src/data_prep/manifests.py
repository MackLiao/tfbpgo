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
