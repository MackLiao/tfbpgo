"""Shared pytest fixtures for data_prep tests."""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import duckdb
import pytest


@pytest.fixture
def fresh_duckdb(tmp_path: Path) -> Iterator[duckdb.DuckDBPyConnection]:
    """Yield a connection to a brand-new on-disk DuckDB file in tmp_path."""
    db_path = tmp_path / "scratch.duckdb"
    conn = duckdb.connect(str(db_path))
    try:
        yield conn
    finally:
        conn.close()


@pytest.fixture(scope="session")
def fixture_db_path() -> Path:
    """Path to the committed test fixture. Built by data_prep.build_fixture."""
    repo_root = Path(__file__).resolve().parents[2]
    return repo_root / "tests" / "fixtures" / "tfbp_test.duckdb"
