"""Shared SQL helpers used by manifests.py and materialize.py.

Centralizes identifier validation so every raw-identifier interpolation
across the package goes through the same regex check.
"""

from __future__ import annotations

import re

import duckdb

_IDENTIFIER_RE = re.compile(r"\A[A-Za-z_][A-Za-z0-9_]*\Z")


def validate_identifier(name: str) -> str:
    """Return name unchanged if it is a safe SQL identifier; raise ValueError otherwise.

    Defense-in-depth: identifiers eventually flow into f-string SQL via
    double-quoting, which is safe for ASCII identifier-shaped values but
    not for arbitrary strings. Use this on every raw interpolation —
    even when the source is trusted (YAML config, information_schema
    lookups) — so future contributors can't accidentally introduce a
    vector by widening the source set.

    Uses re.fullmatch-equivalent anchors (\\A and \\Z) to reject trailing
    newlines that re.match + $ would let through.
    """
    if not _IDENTIFIER_RE.match(name):
        raise ValueError(f"unsafe SQL identifier: {name!r}")
    return name


def columns_of(conn: duckdb.DuckDBPyConnection, table: str) -> list[str]:
    """Return column names of `table` in schema `main`, ordered by ordinal_position.
    Returns empty list if the table does not exist."""
    rows = conn.execute(
        "SELECT column_name FROM information_schema.columns "
        "WHERE table_schema = 'main' AND table_name = ? "
        "ORDER BY ordinal_position",
        [table],
    ).fetchall()
    return [r[0] for r in rows]
