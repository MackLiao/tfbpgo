"""Record reference Python query output for parity testing.

Run once whenever ``tests/parity/golden_urls.json`` or the test fixture
DuckDB changes. Output JSON files land in ``tests/parity/fixtures/``,
keyed by the golden entry's ``name`` field.

Recording requires the reference Python Shiny app (via the ``reference/``
symlink) and a labretriever / HuggingFace credential bundle. On a fresh
checkout this script exits with a clear message instructing the operator
to set the environment up; the Go-side parity tests skip cleanly until
fixtures appear.
"""
from __future__ import annotations

import argparse
import datetime
import json
import sys
from pathlib import Path
from typing import Any

import duckdb


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--fixture", required=True, type=Path,
                        help="Path to tests/fixtures/tfbp_test.duckdb")
    parser.add_argument("--golden", required=True, type=Path,
                        help="Path to tests/parity/golden_urls.json")
    parser.add_argument("--out", required=True, type=Path,
                        help="Directory to write recorded JSON fixtures")
    args = parser.parse_args()

    args.out.mkdir(parents=True, exist_ok=True)
    golden = json.loads(args.golden.read_text())
    if not isinstance(golden, list):
        print("golden_urls.json must be a JSON array", file=sys.stderr)
        return 2

    con = duckdb.connect(str(args.fixture), read_only=True)

    for entry in golden:
        name = entry["name"]
        url = entry["url"]
        out_file = args.out / f"{name}.json"
        try:
            rows = run_reference(con, name, url)
        except NotImplementedError as exc:
            print(f"SKIP {name}: {exc}", file=sys.stderr)
            continue
        out_file.write_text(json.dumps(rows, default=_json_default, indent=2))
        print(f"recorded {out_file}")
    return 0


def run_reference(con: duckdb.DuckDBPyConnection, name: str, url: str) -> Any:
    """Execute the equivalent Python reference query and return rows as dicts.

    Mirror the dispatch table from ``backend/internal/api/`` against the
    reference SQL builders at ``reference/tfbpshiny/modules/*/queries.py``.
    Implemented when the reference symlink and the labretriever poetry env
    are both available on the recording host.
    """
    raise NotImplementedError(
        "Implement against reference/tfbpshiny/modules/{binding,perturbation,"
        "comparison,select_datasets}/queries.py once the reference symlink and "
        "labretriever env are in place."
    )


def _json_default(o: Any) -> Any:
    if isinstance(o, datetime.datetime):
        return o.isoformat()
    return str(o)


if __name__ == "__main__":
    sys.exit(main())
