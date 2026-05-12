"""Tests for shared SQL helpers."""

from __future__ import annotations

import duckdb
import pytest

from data_prep._sql import columns_of, validate_identifier


@pytest.mark.parametrize(
    "name",
    [
        "foo",
        "_foo",
        "Foo123",
        "foo_bar_baz",
        "F",
        "_",
        "_x_",
    ],
)
def test_validate_identifier_accepts_safe(name: str) -> None:
    assert validate_identifier(name) == name


@pytest.mark.parametrize(
    "name",
    [
        "",
        "1abc",
        "foo bar",
        "foo;DROP",
        "foo-bar",
        'foo"bar',
        "foo\nbar",
        "foo\n",       # trailing newline edge case (re.match + $ would let this through)
        "foo\x00bar",  # NUL
        "café",        # non-ASCII
        " foo",        # leading space
        "foo ",        # trailing space
    ],
)
def test_validate_identifier_rejects_unsafe(name: str) -> None:
    with pytest.raises(ValueError, match="unsafe SQL identifier"):
        validate_identifier(name)


def test_columns_of_returns_columns_in_ordinal_order() -> None:
    conn = duckdb.connect(":memory:")
    try:
        conn.execute("CREATE TABLE foo (a INT, b VARCHAR, c DOUBLE)")
        assert columns_of(conn, "foo") == ["a", "b", "c"]
    finally:
        conn.close()


def test_columns_of_returns_empty_for_missing_table() -> None:
    conn = duckdb.connect(":memory:")
    try:
        assert columns_of(conn, "nonexistent_table") == []
    finally:
        conn.close()
