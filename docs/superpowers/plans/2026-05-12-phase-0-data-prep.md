# Phase 0 — Data Prep Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Externalize TFBPShiny's runtime data initialization into a build-time Python pipeline that produces a single immutable `tfbp.duckdb` artifact (consumed read-only by the Phase 1 Go service) plus a small committed `tests/fixtures/tfbp_test.duckdb` used by all downstream tests.

**Architecture:** A new top-level `data_prep/` directory holds a Python package that (a) drives `labretriever` against `brentlab_yeast_collection.yaml` to populate a fresh DuckDB file with the same `{db_name}` and `{db_name}_meta` views the current Shiny app builds in memory, (b) materializes those views and the existing derived tables (`hackett_analysis_set`, `regulator_display_names`, `dto_expanded`) as real tables, and (c) writes four new manifest tables (`artifact_manifest`, `dataset_manifest`, `field_manifest`, `filter_level_cache`) consumed at startup by the Go service. A separate `build_fixture.py` produces a tiny synthetic file with no HF dependency so tests run in milliseconds.

**Tech Stack:** Python 3.11, Poetry, DuckDB (Python bindings), labretriever (existing), PyYAML, pytest. No Go, no React in this phase.

**Spec sections this plan implements:** §5 (entire Data pipeline section), §11.2 Phase 0, §10.2 (fixture), §6.4 step 2 (manifest tables consumed by Go service).

**What this plan does NOT do:** Phase 1 (Go backend), Phase 2 (React), Phase 3 (deployment), S3 upload automation. S3 upload is a one-line `aws s3 cp` invoked manually from the Makefile after `data-build` succeeds; automating publish/CI is deferred to a follow-up plan after Phase 1 has consumed the artifact at least once.

---

## File structure

Created in this phase (paths relative to repo root):

```
data_prep/
├── pyproject.toml                # Poetry env, separate from any runtime
├── README.md                     # How to run build / fixture commands
├── brentlab_yeast_collection.yaml   # Copied from reference/tfbpshiny/
├── src/
│   └── data_prep/
│       ├── __init__.py
│       ├── manifests.py          # Pure builders for the 4 manifest tables
│       ├── materialize.py        # View → table conversion + derived tables
│       ├── build_fixture.py      # Synthetic small DuckDB (no HF)
│       └── build_duckdb.py       # Full pipeline (HF + YAML → tfbp.duckdb)
└── tests/
    ├── conftest.py               # pytest fixtures: fresh DuckDB, fixture file
    ├── test_manifests.py         # Unit tests for each manifest builder
    ├── test_materialize.py       # Unit tests for view materialization
    ├── test_build_fixture.py     # Verifies the fixture file shape
    └── test_build_duckdb_smoke.py    # Marked @pytest.mark.integration; needs HF_TOKEN

tests/
├── fixtures/
│   └── tfbp_test.duckdb          # Committed binary, ~hundreds of KB
└── parity/
    └── README.md                 # Placeholder; populated in Phase 1

Makefile                          # data-build, data-fixture, test targets
.gitignore                        # Adds tfbp.duckdb, .venv, __pycache__, etc.
```

**Responsibility split:**
- `manifests.py` is pure: takes an open DuckDB connection + parsed YAML, executes `CREATE TABLE` + `INSERT` statements. No HF, no labretriever. Testable against the synthetic fixture.
- `materialize.py` converts labretriever views to real tables and runs the existing `ensure_hackett_analysis_set` / `_build_regulator_display_names` logic against the file connection. Also testable against the fixture by stubbing labretriever entirely.
- `build_fixture.py` constructs the fixture from raw `INSERT` statements — no HF, no labretriever. This is the load-bearing test substrate; it must not depend on anything that needs the network.
- `build_duckdb.py` is the orchestrator. The only file in this package that imports `labretriever` and reads `HF_TOKEN`.

---

## Task 1: Repo scaffolding + Poetry env

**Files:**
- Create: `data_prep/pyproject.toml`
- Create: `data_prep/src/data_prep/__init__.py`
- Create: `data_prep/tests/__init__.py`
- Create: `data_prep/tests/conftest.py`
- Create: `data_prep/README.md`
- Create: `Makefile`
- Modify: `.gitignore`

- [ ] **Step 1: Create `data_prep/pyproject.toml`**

```toml
[tool.poetry]
name = "tfbp-data-prep"
version = "0.1.0"
description = "Build-time pipeline that produces tfbp.duckdb from HuggingFace datasets"
authors = ["BrentLab"]
packages = [{ include = "data_prep", from = "src" }]

[tool.poetry.dependencies]
python = "^3.11"
duckdb = "^1.0"
pyyaml = "^6.0"
pandas = "^2.2"
labretriever = { git = "https://github.com/BrentLab/labretriever.git", branch = "main" }

[tool.poetry.group.dev.dependencies]
pytest = "^8.0"
pytest-cov = "^5.0"
ruff = "^0.6"
black = "^24.0"
mypy = "^1.10"

[tool.poetry.scripts]
build-duckdb = "data_prep.build_duckdb:main"
build-fixture = "data_prep.build_fixture:main"

[tool.pytest.ini_options]
markers = ["integration: requires network/HF_TOKEN"]
addopts = "-m 'not integration'"
testpaths = ["tests"]

[build-system]
requires = ["poetry-core"]
build-backend = "poetry.core.masonry.api"
```

- [ ] **Step 2: Create empty package + tests init files**

```bash
mkdir -p data_prep/src/data_prep data_prep/tests tests/fixtures tests/parity
touch data_prep/src/data_prep/__init__.py data_prep/tests/__init__.py
```

- [ ] **Step 3: Create `data_prep/tests/conftest.py`** with the fresh-DuckDB fixture used by all unit tests

```python
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
```

- [ ] **Step 4: Create `data_prep/README.md`**

```markdown
# data_prep

Build-time pipeline. Produces `tfbp.duckdb` (the runtime artifact) and `tests/fixtures/tfbp_test.duckdb` (the committed test fixture).

## Setup

```bash
cd data_prep
poetry install
```

## Commands

| Goal | Command |
|------|---------|
| Build the test fixture | `poetry run build-fixture --out ../tests/fixtures/tfbp_test.duckdb` |
| Build the runtime artifact (needs HF_TOKEN) | `poetry run build-duckdb --config brentlab_yeast_collection.yaml --out ../tfbp.duckdb` |
| Run unit tests | `poetry run pytest` |
| Run integration tests (needs HF_TOKEN) | `poetry run pytest -m integration` |
```

- [ ] **Step 5: Create top-level `Makefile`**

```makefile
.PHONY: data-fixture data-build data-pull test test-data-prep

data-fixture:
	cd data_prep && poetry run build-fixture --out ../tests/fixtures/tfbp_test.duckdb

data-build:
	cd data_prep && poetry run build-duckdb \
	    --config brentlab_yeast_collection.yaml \
	    --out ../tfbp.duckdb

data-pull:
	@echo "Not implemented in Phase 0; see future plan for S3 publish/pull."
	@exit 1

test-data-prep:
	cd data_prep && poetry run pytest

test: test-data-prep
```

- [ ] **Step 6: Update `.gitignore`** — replace existing single-line content

```gitignore
# Reference symlink to the original Python project
/reference

# Runtime artifact (built by data_prep, never committed)
/tfbp.duckdb
/tfbp.duckdb.wal

# Python
__pycache__/
*.py[cod]
.venv/
.pytest_cache/
.mypy_cache/
.ruff_cache/
*.egg-info/

# Secrets
.env
.env.local

# OS
.DS_Store
```

- [ ] **Step 7: Install and verify**

```bash
cd data_prep && poetry install
poetry run pytest -q
```

Expected: `no tests ran in ...` (collected 0 tests, exit 0). If poetry install fails on `labretriever`, that is acceptable — the dependency is only used by `build_duckdb.py` and integration tests; subsequent unit tasks do not touch it. Note the failure and continue.

- [ ] **Step 8: Commit**

```bash
git add data_prep/ Makefile .gitignore tests/
git commit -m "chore: scaffold data_prep package and repo Makefile"
```

---

## Task 2: build_fixture.py — synthetic test DuckDB

This task produces the committed `tests/fixtures/tfbp_test.duckdb` from raw `INSERT` statements (no HF, no labretriever). The fixture is the substrate for every other unit test in this phase and for parity tests in Phase 1.

**Shape of the fixture** (kept tiny on purpose — 2 datasets, 3 regulators, ~12 binding rows, ~12 perturbation rows):

| Table | Columns | Rows |
|-------|---------|------|
| `callingcards` | `gm_id`, `regulator_locus_tag`, `target_locus_tag`, `score` | 12 |
| `callingcards_meta` | `gm_id`, `regulator_locus_tag`, `regulator_symbol`, `condition` | 4 |
| `hackett` | `sample_id`, `regulator_locus_tag`, `target_locus_tag`, `effect`, `pvalue` | 12 |
| `hackett_meta` | `sample_id`, `regulator_locus_tag`, `regulator_symbol`, `mechanism`, `restriction`, `time`, `date`, `strain` | 8 |

The existing `ensure_hackett_analysis_set` SQL needs `hackett_meta` rows for at least one ZEV/P, one GEV/P, and one GEV/M sample so the tier logic produces output. The fixture must include those.

**Files:**
- Create: `data_prep/src/data_prep/build_fixture.py`
- Create: `data_prep/tests/test_build_fixture.py`

- [ ] **Step 1: Write the failing test**

`data_prep/tests/test_build_fixture.py`:

```python
"""Tests for the synthetic fixture builder."""

from __future__ import annotations

from pathlib import Path

import duckdb
import pytest

from data_prep.build_fixture import build_fixture


@pytest.fixture
def built_fixture(tmp_path: Path) -> Path:
    out = tmp_path / "tfbp_test.duckdb"
    build_fixture(out)
    return out


def test_fixture_has_expected_tables(built_fixture: Path) -> None:
    conn = duckdb.connect(str(built_fixture), read_only=True)
    try:
        tables = {
            row[0]
            for row in conn.execute(
                "SELECT table_name FROM information_schema.tables "
                "WHERE table_schema = 'main'"
            ).fetchall()
        }
    finally:
        conn.close()
    expected = {
        "callingcards",
        "callingcards_meta",
        "hackett",
        "hackett_meta",
    }
    assert expected <= tables, f"missing: {expected - tables}"


def test_fixture_callingcards_row_count(built_fixture: Path) -> None:
    conn = duckdb.connect(str(built_fixture), read_only=True)
    try:
        n = conn.execute("SELECT COUNT(*) FROM callingcards").fetchone()[0]
    finally:
        conn.close()
    assert n == 12


def test_fixture_hackett_meta_includes_all_three_tiers(built_fixture: Path) -> None:
    """ensure_hackett_analysis_set in Task 4 needs at least one row per tier."""
    conn = duckdb.connect(str(built_fixture), read_only=True)
    try:
        rows = conn.execute(
            "SELECT mechanism, restriction FROM hackett_meta"
        ).fetchall()
    finally:
        conn.close()
    pairs = {(m, r) for m, r in rows}
    assert ("ZEV", "P") in pairs
    assert ("GEV", "P") in pairs
    assert ("GEV", "M") in pairs


def test_fixture_is_reproducible(tmp_path: Path) -> None:
    """Two invocations of build_fixture produce byte-identical files (modulo
    DuckDB internal metadata). Check via row hashes instead of file bytes."""
    a = tmp_path / "a.duckdb"
    b = tmp_path / "b.duckdb"
    build_fixture(a)
    build_fixture(b)

    def signature(p: Path) -> list[tuple]:
        conn = duckdb.connect(str(p), read_only=True)
        try:
            return conn.execute(
                "SELECT * FROM callingcards ORDER BY gm_id, target_locus_tag"
            ).fetchall()
        finally:
            conn.close()

    assert signature(a) == signature(b)
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd data_prep && poetry run pytest tests/test_build_fixture.py -v
```

Expected: `ImportError: cannot import name 'build_fixture' from 'data_prep.build_fixture'`.

- [ ] **Step 3: Write `data_prep/src/data_prep/build_fixture.py`**

```python
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
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd data_prep && poetry run pytest tests/test_build_fixture.py -v
```

Expected: 4 passed.

- [ ] **Step 5: Build and commit the fixture file**

```bash
cd data_prep && poetry run build-fixture --out ../tests/fixtures/tfbp_test.duckdb
cd .. && ls -la tests/fixtures/tfbp_test.duckdb
```

Expected: file exists, size in tens to hundreds of KB.

- [ ] **Step 6: Commit**

```bash
git add data_prep/src/data_prep/build_fixture.py \
        data_prep/tests/test_build_fixture.py \
        tests/fixtures/tfbp_test.duckdb
git commit -m "feat(data_prep): add synthetic test fixture builder"
```

---

## Task 3: manifests.py — artifact_manifest builder

**Spec §5.5:** `artifact_manifest` is a single-row table with columns `artifact_version` (string), `schema_version` (int), `built_at` (timestamp), `source_yaml_sha256` (string), `duckdb_version` (string), `parity_tests_passed` (bool). Used by the Go service for fail-fast startup (§9.5) and for cache-key invalidation. Schema version is bumped manually when the §5.5 table set changes.

**Files:**
- Create: `data_prep/src/data_prep/manifests.py`
- Create: `data_prep/tests/test_manifests.py`

- [ ] **Step 1: Write the failing test**

`data_prep/tests/test_manifests.py`:

```python
"""Tests for manifest table builders."""

from __future__ import annotations

import hashlib
from pathlib import Path

import duckdb
import pytest

from data_prep.manifests import (
    SCHEMA_VERSION,
    write_artifact_manifest,
)


def test_artifact_manifest_has_exactly_one_row(
    fresh_duckdb: duckdb.DuckDBPyConnection,
) -> None:
    write_artifact_manifest(
        fresh_duckdb,
        artifact_version="2026-05-12",
        source_yaml_sha256="a" * 64,
        parity_tests_passed=False,
    )
    n = fresh_duckdb.execute("SELECT COUNT(*) FROM artifact_manifest").fetchone()[0]
    assert n == 1


def test_artifact_manifest_columns(
    fresh_duckdb: duckdb.DuckDBPyConnection,
) -> None:
    write_artifact_manifest(
        fresh_duckdb,
        artifact_version="2026-05-12",
        source_yaml_sha256="a" * 64,
        parity_tests_passed=False,
    )
    cols = {
        row[0]
        for row in fresh_duckdb.execute(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_name = 'artifact_manifest'"
        ).fetchall()
    }
    expected = {
        "artifact_version",
        "schema_version",
        "built_at",
        "source_yaml_sha256",
        "duckdb_version",
        "parity_tests_passed",
    }
    assert cols == expected


def test_artifact_manifest_records_runtime_duckdb_version(
    fresh_duckdb: duckdb.DuckDBPyConnection,
) -> None:
    write_artifact_manifest(
        fresh_duckdb,
        artifact_version="2026-05-12",
        source_yaml_sha256="a" * 64,
        parity_tests_passed=True,
    )
    row = fresh_duckdb.execute(
        "SELECT artifact_version, schema_version, source_yaml_sha256, "
        "duckdb_version, parity_tests_passed FROM artifact_manifest"
    ).fetchone()
    assert row[0] == "2026-05-12"
    assert row[1] == SCHEMA_VERSION
    assert row[2] == "a" * 64
    assert row[3]  # non-empty string from duckdb.__version__
    assert row[4] is True


def test_artifact_manifest_overwrite(
    fresh_duckdb: duckdb.DuckDBPyConnection,
) -> None:
    """Re-running the builder must produce one row, not append."""
    for v in ("2026-05-12", "2026-05-13"):
        write_artifact_manifest(
            fresh_duckdb,
            artifact_version=v,
            source_yaml_sha256="a" * 64,
            parity_tests_passed=False,
        )
    n = fresh_duckdb.execute("SELECT COUNT(*) FROM artifact_manifest").fetchone()[0]
    assert n == 1
    v = fresh_duckdb.execute("SELECT artifact_version FROM artifact_manifest").fetchone()[0]
    assert v == "2026-05-13"
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd data_prep && poetry run pytest tests/test_manifests.py -v
```

Expected: `ImportError: cannot import name 'write_artifact_manifest' from 'data_prep.manifests'`.

- [ ] **Step 3: Create `data_prep/src/data_prep/manifests.py`** with the artifact_manifest builder

```python
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
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd data_prep && poetry run pytest tests/test_manifests.py -v
```

Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add data_prep/src/data_prep/manifests.py data_prep/tests/test_manifests.py
git commit -m "feat(data_prep): add artifact_manifest builder"
```

---

## Task 4: manifests.py — dataset_manifest builder

**Spec §5.5:** One row per dataset: `db_name`, `data_type` (binding/perturbation), `assay`, `display_name`, `source_repo`. Used by the Go service to whitelist dataset identifiers in dynamic SQL. Source: the `tags` block under each dataset entry in `brentlab_yeast_collection.yaml`.

**Files:**
- Modify: `data_prep/src/data_prep/manifests.py`
- Modify: `data_prep/tests/test_manifests.py`

- [ ] **Step 1: Add the failing test** to `data_prep/tests/test_manifests.py` (append at end)

```python
import textwrap

import yaml

from data_prep.manifests import (
    write_dataset_manifest,
)


_SAMPLE_YAML = textwrap.dedent(
    """\
    repositories:
      BrentLab/callingcards:
        dataset:
          2026_analysis_set:
            tags:
              data_type: binding
              assay: CallingCards
              display_name: "2026 Calling Cards"
            db_name: callingcards
            sample_id:
              field: gm_id
      BrentLab/hackett_2020:
        dataset:
          hackett_2020:
            tags:
              data_type: perturbation
              assay: overexpression
              display_name: "2020 Overexpression (Hackett)"
            db_name: hackett
            sample_id:
              field: sample_id
      BrentLab/yeast_comparative_analysis:
        dataset:
          dto:
            db_name: dto
            sample_id:
              field: sample_id
    """
)


def test_dataset_manifest_emits_one_row_per_tagged_dataset(
    fresh_duckdb: duckdb.DuckDBPyConnection,
) -> None:
    config = yaml.safe_load(_SAMPLE_YAML)
    write_dataset_manifest(fresh_duckdb, config)

    rows = fresh_duckdb.execute(
        "SELECT db_name, data_type, assay, display_name, source_repo "
        "FROM dataset_manifest ORDER BY db_name"
    ).fetchall()

    assert rows == [
        ("callingcards", "binding", "CallingCards", "2026 Calling Cards",
         "BrentLab/callingcards"),
        ("hackett", "perturbation", "overexpression",
         "2020 Overexpression (Hackett)", "BrentLab/hackett_2020"),
    ]


def test_dataset_manifest_skips_untagged_dto_entry(
    fresh_duckdb: duckdb.DuckDBPyConnection,
) -> None:
    """The dto dataset has no tags block; it must not appear in the manifest
    of selectable datasets, but the table itself still exists in the artifact."""
    config = yaml.safe_load(_SAMPLE_YAML)
    write_dataset_manifest(fresh_duckdb, config)
    db_names = {
        row[0]
        for row in fresh_duckdb.execute(
            "SELECT db_name FROM dataset_manifest"
        ).fetchall()
    }
    assert "dto" not in db_names


def test_dataset_manifest_db_name_unique(
    fresh_duckdb: duckdb.DuckDBPyConnection,
) -> None:
    config = yaml.safe_load(_SAMPLE_YAML)
    write_dataset_manifest(fresh_duckdb, config)
    n_distinct = fresh_duckdb.execute(
        "SELECT COUNT(DISTINCT db_name) FROM dataset_manifest"
    ).fetchone()[0]
    n_total = fresh_duckdb.execute(
        "SELECT COUNT(*) FROM dataset_manifest"
    ).fetchone()[0]
    assert n_distinct == n_total
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd data_prep && poetry run pytest tests/test_manifests.py -v
```

Expected: `ImportError: cannot import name 'write_dataset_manifest'`.

- [ ] **Step 3: Append `write_dataset_manifest` to `data_prep/src/data_prep/manifests.py`**

```python
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
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd data_prep && poetry run pytest tests/test_manifests.py -v
```

Expected: 7 passed (4 from Task 3 + 3 new).

- [ ] **Step 5: Commit**

```bash
git add data_prep/src/data_prep/manifests.py data_prep/tests/test_manifests.py
git commit -m "feat(data_prep): add dataset_manifest builder"
```

---

## Task 5: manifests.py — field_manifest builder

**Spec §5.5:** One row per (`db_name`, `field`): legal field names per dataset for filters and sorts. Used by the Go service to whitelist column identifiers before interpolating them into SQL. Derived by introspecting each `{db_name}` and `{db_name}_meta` table that already exists in the connection.

**HIDDEN_FILTER_FIELDS** (from `reference/tfbpshiny/utils/vdb_init.py:20-36`) defines fields that the current Shiny app suppresses from filter UIs. The field_manifest must record *only* fields that are legal as filter or sort targets — i.e., the union of all columns across `{db_name}` and `{db_name}_meta` for that dataset, **minus** the global hidden set, **minus** the dataset-specific hidden set, **minus** `sample_id` (always present, never a filter).

**Files:**
- Modify: `data_prep/src/data_prep/manifests.py`
- Modify: `data_prep/tests/test_manifests.py`

- [ ] **Step 1: Add failing tests** to `data_prep/tests/test_manifests.py`

```python
from data_prep.manifests import (
    HIDDEN_FILTER_FIELDS,
    write_field_manifest,
)


def _seed_two_datasets(conn: duckdb.DuckDBPyConnection) -> None:
    conn.execute(
        "CREATE TABLE callingcards (gm_id VARCHAR, regulator_locus_tag VARCHAR, "
        "target_locus_tag VARCHAR, score DOUBLE)"
    )
    conn.execute(
        "CREATE TABLE callingcards_meta (gm_id VARCHAR, regulator_locus_tag "
        "VARCHAR, regulator_symbol VARCHAR, condition VARCHAR, "
        "background_total_hops INTEGER)"
    )
    conn.execute(
        "CREATE TABLE harbison (sample_id VARCHAR, regulator_locus_tag VARCHAR, "
        "target_locus_tag VARCHAR, score DOUBLE)"
    )
    conn.execute(
        "CREATE TABLE harbison_meta (sample_id VARCHAR, regulator_locus_tag "
        "VARCHAR, regulator_symbol VARCHAR, condition VARCHAR)"
    )
    conn.execute(
        "CREATE TABLE dataset_manifest (db_name VARCHAR PRIMARY KEY, "
        "data_type VARCHAR, assay VARCHAR, display_name VARCHAR, "
        "source_repo VARCHAR)"
    )
    conn.execute(
        "INSERT INTO dataset_manifest VALUES "
        "('callingcards', 'binding', 'CallingCards', 'cc', 'BrentLab/callingcards'), "
        "('harbison', 'binding', 'ChIP-chip', 'harbison', 'BrentLab/harbison_2004')"
    )


def test_field_manifest_one_row_per_legal_field(
    fresh_duckdb: duckdb.DuckDBPyConnection,
) -> None:
    _seed_two_datasets(fresh_duckdb)
    write_field_manifest(fresh_duckdb)

    cc_fields = {
        row[0]
        for row in fresh_duckdb.execute(
            "SELECT field FROM field_manifest WHERE db_name = 'callingcards'"
        ).fetchall()
    }
    # Allowed: target_locus_tag, score (data) + condition (meta)
    # Disallowed: regulator_locus_tag, regulator_symbol (global hidden);
    #             gm_id (sample_id alias — see Step 3 logic);
    #             background_total_hops (callingcards-specific hidden)
    assert cc_fields == {"target_locus_tag", "score", "condition"}


def test_field_manifest_excludes_globally_hidden(
    fresh_duckdb: duckdb.DuckDBPyConnection,
) -> None:
    _seed_two_datasets(fresh_duckdb)
    write_field_manifest(fresh_duckdb)
    forbidden = HIDDEN_FILTER_FIELDS["*"]
    rows = fresh_duckdb.execute(
        "SELECT field FROM field_manifest"
    ).fetchall()
    for (field,) in rows:
        assert field not in forbidden


def test_field_manifest_db_name_field_unique(
    fresh_duckdb: duckdb.DuckDBPyConnection,
) -> None:
    _seed_two_datasets(fresh_duckdb)
    write_field_manifest(fresh_duckdb)
    n = fresh_duckdb.execute("SELECT COUNT(*) FROM field_manifest").fetchone()[0]
    n_distinct = fresh_duckdb.execute(
        "SELECT COUNT(DISTINCT (db_name, field)) FROM field_manifest"
    ).fetchone()[0]
    assert n == n_distinct
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd data_prep && poetry run pytest tests/test_manifests.py -v
```

Expected: `ImportError: cannot import name 'HIDDEN_FILTER_FIELDS'` (or `write_field_manifest`).

- [ ] **Step 3: Append `HIDDEN_FILTER_FIELDS` and `write_field_manifest` to `data_prep/src/data_prep/manifests.py`**

```python
# Mirrors HIDDEN_FILTER_FIELDS from
# reference/tfbpshiny/utils/vdb_init.py:20-36. Update both together if
# this set changes; the runtime Go service consults field_manifest, not
# this constant, so the table is the source of truth at runtime.
HIDDEN_FILTER_FIELDS: dict[str, frozenset[str]] = {
    "*": frozenset({
        "regulator_locus_tag",
        "regulator_symbol",
        "Regulator locus tag",
        "Regulator symbol",
    }),
    "callingcards": frozenset({"background_total_hops", "experiment_total_hops"}),
    "harbison": frozenset({"condition"}),
    "chec_m2025": frozenset({"condition", "mahendrawada_symbol"}),
    "degron": frozenset({"env_condition", "timepoint"}),
    "rossi": frozenset({"antibody", "growth_media"}),
    "hackett": frozenset({"date", "mechanism", "restriction", "strain"}),
    "hu_reimand": frozenset({"average_od_of_replicates", "heat_shock"}),
    "hughes_overexpression": frozenset({"del_passed_qc", "sgd_description"}),
    "hughes_knockout": frozenset({"oe_passed_qc", "sgd_description"}),
}

# Always-excluded structural columns (not user-selectable filters/sorts).
# Note: per-dataset sample_id field names (gm_id for callingcards, etc.)
# are also excluded by the introspection rule below — any column named
# `sample_id` OR appearing in both the data table and the meta table as
# the join key is treated as structural.
_STRUCTURAL_FIELDS: frozenset[str] = frozenset({"sample_id"})


def _hidden_for(db_name: str) -> frozenset[str]:
    return HIDDEN_FILTER_FIELDS.get("*", frozenset()) | HIDDEN_FILTER_FIELDS.get(
        db_name, frozenset()
    )


def _columns_of(conn: duckdb.DuckDBPyConnection, table: str) -> list[str]:
    rows = conn.execute(
        "SELECT column_name FROM information_schema.columns "
        "WHERE table_schema = 'main' AND table_name = ? "
        "ORDER BY ordinal_position",
        [table],
    ).fetchall()
    return [r[0] for r in rows]


def write_field_manifest(conn: duckdb.DuckDBPyConnection) -> None:
    """Create or replace field_manifest by introspecting per-dataset tables.

    Requires dataset_manifest to exist. For each db_name in dataset_manifest,
    union the columns of `{db_name}` and `{db_name}_meta`, subtract the
    hidden fields and structural columns, and emit one row per remaining
    field.

    The shared join key between `{db_name}` and `{db_name}_meta` (whatever
    its actual name — `sample_id`, `gm_id`, etc.) is treated as structural
    and excluded.
    """
    db_names = [
        r[0]
        for r in conn.execute(
            "SELECT db_name FROM dataset_manifest ORDER BY db_name"
        ).fetchall()
    ]

    rows: list[tuple[str, str]] = []
    for db_name in db_names:
        data_cols = _columns_of(conn, db_name)
        meta_cols = _columns_of(conn, f"{db_name}_meta")
        if not data_cols and not meta_cols:
            continue

        join_keys = set(data_cols) & set(meta_cols)
        excluded = _hidden_for(db_name) | _STRUCTURAL_FIELDS | join_keys

        seen: set[str] = set()
        for col in [*data_cols, *meta_cols]:
            if col in excluded or col in seen:
                continue
            seen.add(col)
            rows.append((db_name, col))

    conn.execute("DROP TABLE IF EXISTS field_manifest")
    conn.execute(
        """
        CREATE TABLE field_manifest (
            db_name VARCHAR NOT NULL,
            field   VARCHAR NOT NULL,
            PRIMARY KEY (db_name, field)
        )
        """
    )
    if rows:
        conn.executemany(
            "INSERT INTO field_manifest VALUES (?, ?)", rows
        )
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd data_prep && poetry run pytest tests/test_manifests.py -v
```

Expected: 10 passed.

- [ ] **Step 5: Commit**

```bash
git add data_prep/src/data_prep/manifests.py data_prep/tests/test_manifests.py
git commit -m "feat(data_prep): add field_manifest builder with hidden-field exclusion"
```

---

## Task 6: manifests.py — filter_level_cache builder

**Spec §5.5:** Precomputed distinct-value sets for low-cardinality filter fields (e.g., carbon source, temperature). Avoids runtime `SELECT DISTINCT` for sidebar filter dropdowns. The cache contains, for each (`db_name`, `field`) pair where the meta-table column has fewer than `LEVEL_CACHE_THRESHOLD` distinct values, one row per (`db_name`, `field`, `level`).

**Files:**
- Modify: `data_prep/src/data_prep/manifests.py`
- Modify: `data_prep/tests/test_manifests.py`

- [ ] **Step 1: Add failing tests** to `data_prep/tests/test_manifests.py`

```python
from data_prep.manifests import (
    LEVEL_CACHE_THRESHOLD,
    write_filter_level_cache,
)


def _seed_low_cardinality(conn: duckdb.DuckDBPyConnection) -> None:
    """Tables where condition has 2 distinct values, score has many."""
    conn.execute(
        "CREATE TABLE callingcards (gm_id VARCHAR, target_locus_tag VARCHAR, "
        "score DOUBLE)"
    )
    conn.execute(
        "CREATE TABLE callingcards_meta (gm_id VARCHAR, "
        "regulator_locus_tag VARCHAR, condition VARCHAR)"
    )
    conn.execute(
        "INSERT INTO callingcards_meta VALUES "
        "('cc_0', 'YBR289W', 'YPD'), "
        "('cc_1', 'YML007W', 'SC'), "
        "('cc_2', 'YGL073W', 'YPD')"
    )
    # field_manifest must exist; populate with the legal fields.
    conn.execute(
        "CREATE TABLE field_manifest (db_name VARCHAR, field VARCHAR, "
        "PRIMARY KEY (db_name, field))"
    )
    conn.execute(
        "INSERT INTO field_manifest VALUES "
        "('callingcards', 'condition'), "
        "('callingcards', 'target_locus_tag'), "
        "('callingcards', 'score')"
    )


def test_filter_level_cache_includes_low_cardinality_field(
    fresh_duckdb: duckdb.DuckDBPyConnection,
) -> None:
    _seed_low_cardinality(fresh_duckdb)
    write_filter_level_cache(fresh_duckdb)

    levels = sorted(
        row[0]
        for row in fresh_duckdb.execute(
            "SELECT level FROM filter_level_cache "
            "WHERE db_name = 'callingcards' AND field = 'condition' "
            "ORDER BY level"
        ).fetchall()
    )
    assert levels == ["SC", "YPD"]


def test_filter_level_cache_excludes_high_cardinality(
    fresh_duckdb: duckdb.DuckDBPyConnection,
) -> None:
    """target_locus_tag will have one distinct value per row inserted via
    the test seed; in real data it has thousands. We verify the threshold
    is applied by inserting > LEVEL_CACHE_THRESHOLD rows and checking the
    field is omitted."""
    _seed_low_cardinality(fresh_duckdb)
    # Add many distinct target rows so target_locus_tag exceeds the threshold
    targets = [(f"cc_t_{i}", f"YAL{i:03d}C", 0.1) for i in range(LEVEL_CACHE_THRESHOLD + 5)]
    fresh_duckdb.executemany(
        "INSERT INTO callingcards VALUES (?, ?, ?)", targets
    )
    write_filter_level_cache(fresh_duckdb)
    n = fresh_duckdb.execute(
        "SELECT COUNT(*) FROM filter_level_cache "
        "WHERE db_name = 'callingcards' AND field = 'target_locus_tag'"
    ).fetchone()[0]
    assert n == 0


def test_filter_level_cache_only_caches_field_manifest_entries(
    fresh_duckdb: duckdb.DuckDBPyConnection,
) -> None:
    """A column present in the data but absent from field_manifest (e.g.,
    regulator_locus_tag, which is hidden) must not appear in the cache."""
    _seed_low_cardinality(fresh_duckdb)
    write_filter_level_cache(fresh_duckdb)
    n = fresh_duckdb.execute(
        "SELECT COUNT(*) FROM filter_level_cache "
        "WHERE field = 'regulator_locus_tag'"
    ).fetchone()[0]
    assert n == 0
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd data_prep && poetry run pytest tests/test_manifests.py -v
```

Expected: `ImportError: cannot import name 'LEVEL_CACHE_THRESHOLD'`.

- [ ] **Step 3: Append `LEVEL_CACHE_THRESHOLD` and `write_filter_level_cache` to `data_prep/src/data_prep/manifests.py`**

```python
# Maximum distinct values for a field to be cached. Above this, the field
# is treated as high-cardinality (e.g., target_locus_tag has ~6k distinct
# values) and the runtime falls back to per-request DISTINCT or to a
# different UI affordance (autocomplete instead of dropdown).
LEVEL_CACHE_THRESHOLD: int = 50


def write_filter_level_cache(conn: duckdb.DuckDBPyConnection) -> None:
    """Create or replace filter_level_cache.

    For each (db_name, field) in field_manifest where the column lives in
    `{db_name}_meta` (or `{db_name}` if absent from meta) and has at most
    LEVEL_CACHE_THRESHOLD distinct non-null values, insert one row per
    distinct value.
    """
    pairs = conn.execute(
        "SELECT db_name, field FROM field_manifest ORDER BY db_name, field"
    ).fetchall()

    conn.execute("DROP TABLE IF EXISTS filter_level_cache")
    conn.execute(
        """
        CREATE TABLE filter_level_cache (
            db_name VARCHAR NOT NULL,
            field   VARCHAR NOT NULL,
            level   VARCHAR NOT NULL
        )
        """
    )

    for db_name, field in pairs:
        # Prefer meta table; fall back to data table.
        candidate_tables = [f"{db_name}_meta", db_name]
        source_table: str | None = None
        for t in candidate_tables:
            cols = _columns_of(conn, t)
            if field in cols:
                source_table = t
                break
        if source_table is None:
            continue

        n_distinct = conn.execute(
            f'SELECT COUNT(DISTINCT "{field}") FROM "{source_table}" '
            f'WHERE "{field}" IS NOT NULL'
        ).fetchone()[0]
        if n_distinct == 0 or n_distinct > LEVEL_CACHE_THRESHOLD:
            continue

        conn.execute(
            f"""
            INSERT INTO filter_level_cache
            SELECT
                ?::VARCHAR AS db_name,
                ?::VARCHAR AS field,
                CAST("{field}" AS VARCHAR) AS level
            FROM "{source_table}"
            WHERE "{field}" IS NOT NULL
            GROUP BY "{field}"
            """,
            [db_name, field],
        )
```

The double-quoted identifier in the f-string is safe because `field` and `source_table` come from `field_manifest` and `dataset_manifest`, both of which are populated from trusted YAML config — not user input. The Go service applies the additional whitelist check at request time.

- [ ] **Step 4: Run test to verify it passes**

```bash
cd data_prep && poetry run pytest tests/test_manifests.py -v
```

Expected: 13 passed.

- [ ] **Step 5: Commit**

```bash
git add data_prep/src/data_prep/manifests.py data_prep/tests/test_manifests.py
git commit -m "feat(data_prep): add filter_level_cache builder"
```

---

## Task 7: materialize.py — view-to-table conversion + derived tables

**Background:** `labretriever` registers `{db_name}` and `{db_name}_meta` as DuckDB *views* over remote parquet files. For an immutable runtime artifact, those views must become real tables (so the Go service has zero HF dependency at runtime). The same applies to comparative-dataset views like `dto_expanded` (registered by `labretriever.virtual_db._register_comparative_expanded_view`).

The two derived tables (`hackett_analysis_set`, `regulator_display_names`) are already defined as functions in `reference/tfbpshiny/utils/vdb_init.py`. This task ports those two SQL strings verbatim into `materialize.py` so the data_prep package has no runtime import dependency on the `tfbpshiny` package.

**Files:**
- Create: `data_prep/src/data_prep/materialize.py`
- Create: `data_prep/tests/test_materialize.py`

- [ ] **Step 1: Write the failing test**

`data_prep/tests/test_materialize.py`:

```python
"""Tests for view materialization and derived-table builders."""

from __future__ import annotations

import duckdb
import pytest

from data_prep.materialize import (
    build_hackett_analysis_set,
    build_regulator_display_names,
    materialize_views_as_tables,
)


@pytest.fixture
def db_with_views(fresh_duckdb: duckdb.DuckDBPyConnection) -> duckdb.DuckDBPyConnection:
    """A DuckDB connection that simulates the post-labretriever state:
    `{db_name}` and `{db_name}_meta` are VIEWs, not tables."""
    fresh_duckdb.execute(
        "CREATE TABLE _callingcards_data AS "
        "SELECT * FROM (VALUES "
        "('cc_0', 'YBR289W', 'YAL001C', 0.1), "
        "('cc_0', 'YBR289W', 'YAL002W', 0.2)) "
        "AS t(gm_id, regulator_locus_tag, target_locus_tag, score)"
    )
    fresh_duckdb.execute(
        "CREATE VIEW callingcards AS SELECT * FROM _callingcards_data"
    )
    fresh_duckdb.execute(
        "CREATE TABLE _callingcards_meta_data AS "
        "SELECT * FROM (VALUES "
        "('cc_0', 'YBR289W', 'SNF5', 'YPD')) "
        "AS t(gm_id, regulator_locus_tag, regulator_symbol, condition)"
    )
    fresh_duckdb.execute(
        "CREATE VIEW callingcards_meta AS SELECT * FROM _callingcards_meta_data"
    )
    return fresh_duckdb


def test_materialize_converts_views_to_tables(
    db_with_views: duckdb.DuckDBPyConnection,
) -> None:
    materialize_views_as_tables(db_with_views, view_names=["callingcards", "callingcards_meta"])

    kinds = {
        row[0]: row[1]
        for row in db_with_views.execute(
            "SELECT table_name, table_type FROM information_schema.tables "
            "WHERE table_name IN ('callingcards', 'callingcards_meta')"
        ).fetchall()
    }
    assert kinds == {
        "callingcards": "BASE TABLE",
        "callingcards_meta": "BASE TABLE",
    }


def test_materialize_preserves_row_data(
    db_with_views: duckdb.DuckDBPyConnection,
) -> None:
    materialize_views_as_tables(db_with_views, view_names=["callingcards"])
    rows = db_with_views.execute(
        "SELECT regulator_locus_tag, target_locus_tag, score FROM callingcards "
        "ORDER BY target_locus_tag"
    ).fetchall()
    assert rows == [("YBR289W", "YAL001C", 0.1), ("YBR289W", "YAL002W", 0.2)]


def test_build_regulator_display_names_uses_symbol_when_present(
    db_with_views: duckdb.DuckDBPyConnection,
) -> None:
    materialize_views_as_tables(db_with_views, view_names=["callingcards", "callingcards_meta"])
    build_regulator_display_names(db_with_views, db_names=["callingcards"])

    row = db_with_views.execute(
        "SELECT regulator_symbol, display_name FROM regulator_display_names "
        "WHERE regulator_locus_tag = 'YBR289W'"
    ).fetchone()
    assert row == ("SNF5", "SNF5 (YBR289W)")


def test_build_hackett_analysis_set_filters_by_tier() -> None:
    """Use a fresh in-memory DB seeded just for this test (the build_hackett
    function expects a `hackett_meta` table, not the callingcards fixture)."""
    conn = duckdb.connect(":memory:")
    try:
        conn.execute(
            "CREATE TABLE hackett_meta AS SELECT * FROM (VALUES "
            "('h_0', 'YBR289W', 'SNF5', 'ZEV', 'P', 45.0, '2020-01-01', 'BY4741'), "
            "('h_1', 'YML007W', 'YAP1', 'GEV', 'P', 45.0, '2020-01-01', 'BY4741'), "
            "('h_2', 'YGL073W', 'HSF1', 'GEV', 'M', 45.0, '2020-01-01', 'BY4741'), "
            "('h_extra', 'YBR289W', 'SNF5', 'GEV', 'M', 45.0, '2020-01-02', 'BY4741') "
            ") AS t(sample_id, regulator_locus_tag, regulator_symbol, mechanism, "
            "restriction, time, date, strain)"
        )
        build_hackett_analysis_set(conn)

        sample_ids = sorted(
            row[0]
            for row in conn.execute(
                "SELECT sample_id FROM hackett_analysis_set"
            ).fetchall()
        )
        # h_0: tier 1 (ZEV/P present); h_1: tier 2 (no ZEV/P, GEV/P present);
        # h_2: tier 3 (no ZEV/P, no GEV/P, takes GEV/M).
        # h_extra is filtered: YBR289W is tier 1 (ZEV/P), so only ZEV/P rows kept.
        assert sample_ids == ["h_0", "h_1", "h_2"]
    finally:
        conn.close()
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd data_prep && poetry run pytest tests/test_materialize.py -v
```

Expected: `ImportError: cannot import name 'materialize_views_as_tables'`.

- [ ] **Step 3: Create `data_prep/src/data_prep/materialize.py`**

```python
"""View materialization and derived-table builders.

Converts labretriever-registered views into real DuckDB tables so the
runtime artifact is fully self-contained (no parquet/HF dependency at
serve time). Also ports the two derived tables previously built at app
startup in reference/tfbpshiny/utils/vdb_init.py.
"""

from __future__ import annotations

import duckdb


# Verbatim port of _HACKETT_ANALYSIS_SET_SQL from
# reference/tfbpshiny/utils/vdb_init.py:75-117. Update both together if
# the tier logic changes; parity tests in Phase 1 will catch divergence.
_HACKETT_ANALYSIS_SET_SQL = """
CREATE OR REPLACE TABLE hackett_analysis_set AS
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


_DISPLAY_NAMES_SQL = """
CREATE OR REPLACE TABLE regulator_display_names AS
SELECT
    regulator_locus_tag,
    FIRST(regulator_symbol) AS regulator_symbol,
    CASE
        WHEN FIRST(regulator_symbol) IS NOT NULL
             AND FIRST(regulator_symbol) != ''
             AND FIRST(regulator_symbol) != FIRST(regulator_locus_tag)
        THEN FIRST(regulator_symbol) || ' (' || regulator_locus_tag || ')'
        ELSE regulator_locus_tag
    END AS display_name
FROM ({union_sql}) __all
GROUP BY regulator_locus_tag
ORDER BY regulator_locus_tag
"""


def materialize_views_as_tables(
    conn: duckdb.DuckDBPyConnection,
    *,
    view_names: list[str],
) -> None:
    """For each view name, replace the view with a CTAS table containing the
    same rows. Caller is responsible for the list of views to materialize
    (typically: every dataset's `{db_name}` and `{db_name}_meta`, plus
    `{db_name}_expanded` for comparative datasets like dto)."""
    for view in view_names:
        # Capture rows into a temp staging table to avoid the view referring
        # to itself during DROP/CREATE.
        staging = f"_materialize_stage_{view}"
        conn.execute(f'CREATE TABLE "{staging}" AS SELECT * FROM "{view}"')
        conn.execute(f'DROP VIEW "{view}"')
        conn.execute(f'ALTER TABLE "{staging}" RENAME TO "{view}"')


def build_hackett_analysis_set(conn: duckdb.DuckDBPyConnection) -> None:
    """Create or replace hackett_analysis_set. Requires hackett_meta to exist."""
    conn.execute(_HACKETT_ANALYSIS_SET_SQL)


def build_regulator_display_names(
    conn: duckdb.DuckDBPyConnection,
    *,
    db_names: list[str],
) -> None:
    """Create or replace regulator_display_names by unioning regulator
    columns across the supplied dataset meta tables. Datasets whose meta
    table lacks `regulator_locus_tag` are skipped silently."""
    eligible: list[str] = []
    for db in db_names:
        cols = {
            r[0]
            for r in conn.execute(
                "SELECT column_name FROM information_schema.columns "
                "WHERE table_schema = 'main' AND table_name = ?",
                [f"{db}_meta"],
            ).fetchall()
        }
        if "regulator_locus_tag" in cols and "regulator_symbol" in cols:
            eligible.append(db)
    if not eligible:
        # Still create the table empty so the Go service's startup contract
        # (table presence) is satisfied.
        conn.execute(
            "CREATE OR REPLACE TABLE regulator_display_names ("
            "regulator_locus_tag VARCHAR, "
            "regulator_symbol VARCHAR, "
            "display_name VARCHAR)"
        )
        return

    union_sql = " UNION ALL ".join(
        f"SELECT DISTINCT regulator_locus_tag, regulator_symbol "
        f'FROM "{db}_meta"'
        for db in eligible
    )
    conn.execute(_DISPLAY_NAMES_SQL.format(union_sql=union_sql))
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd data_prep && poetry run pytest tests/test_materialize.py -v
```

Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add data_prep/src/data_prep/materialize.py data_prep/tests/test_materialize.py
git commit -m "feat(data_prep): add view materialization and derived-table builders"
```

---

## Task 8: build_duckdb.py — orchestrator (no labretriever path tested with fixture)

The orchestrator wires Tasks 3–7 into a single command. It has two modes:

1. **Real mode (default):** opens the YAML config, instantiates `labretriever.VirtualDB(yaml, duckdb_connection=conn)`, runs labretriever's view registration, materializes everything, builds manifests, CHECKPOINTs, closes. Requires `HF_TOKEN`.
2. **Fixture mode (`--from-fixture <path>`):** copies the supplied fixture into `--out` and runs only the manifest builders against it. Used by Phase 1 to bootstrap a known-shape artifact for parity testing without HF access.

This task implements **fixture mode first** (testable without HF) and stubs the labretriever path with a clear NotImplementedError pointing at the integration test (Task 9) where it's exercised.

**Files:**
- Create: `data_prep/src/data_prep/build_duckdb.py`
- Create: `data_prep/tests/test_build_duckdb.py`

- [ ] **Step 1: Write the failing test**

`data_prep/tests/test_build_duckdb.py`:

```python
"""Tests for the build_duckdb orchestrator (fixture mode only — labretriever
path is exercised by the integration test in test_build_duckdb_smoke.py)."""

from __future__ import annotations

from pathlib import Path

import duckdb
import pytest

from data_prep.build_duckdb import build_from_fixture
from data_prep.build_fixture import build_fixture


@pytest.fixture
def yaml_path(tmp_path: Path) -> Path:
    """Minimal YAML matching the fixture's two datasets."""
    p = tmp_path / "config.yaml"
    p.write_text(
        "repositories:\n"
        "  BrentLab/callingcards:\n"
        "    dataset:\n"
        "      cc:\n"
        "        tags:\n"
        "          data_type: binding\n"
        "          assay: CallingCards\n"
        "          display_name: Calling Cards\n"
        "        db_name: callingcards\n"
        "        sample_id:\n"
        "          field: gm_id\n"
        "  BrentLab/hackett_2020:\n"
        "    dataset:\n"
        "      hackett_2020:\n"
        "        tags:\n"
        "          data_type: perturbation\n"
        "          assay: overexpression\n"
        "          display_name: Hackett 2020\n"
        "        db_name: hackett\n"
        "        sample_id:\n"
        "          field: sample_id\n"
    )
    return p


@pytest.fixture
def fixture_db(tmp_path: Path) -> Path:
    p = tmp_path / "in.duckdb"
    build_fixture(p)
    return p


def test_build_from_fixture_creates_all_manifest_tables(
    tmp_path: Path, yaml_path: Path, fixture_db: Path
) -> None:
    out = tmp_path / "out.duckdb"
    build_from_fixture(
        fixture_path=fixture_db,
        yaml_config_path=yaml_path,
        out_path=out,
        artifact_version="2026-05-12-test",
    )

    conn = duckdb.connect(str(out), read_only=True)
    try:
        tables = {
            row[0]
            for row in conn.execute(
                "SELECT table_name FROM information_schema.tables "
                "WHERE table_schema = 'main'"
            ).fetchall()
        }
    finally:
        conn.close()

    required = {
        "callingcards",
        "callingcards_meta",
        "hackett",
        "hackett_meta",
        "hackett_analysis_set",
        "regulator_display_names",
        "artifact_manifest",
        "dataset_manifest",
        "field_manifest",
        "filter_level_cache",
    }
    assert required <= tables, f"missing: {required - tables}"


def test_build_from_fixture_artifact_version_recorded(
    tmp_path: Path, yaml_path: Path, fixture_db: Path
) -> None:
    out = tmp_path / "out.duckdb"
    build_from_fixture(
        fixture_path=fixture_db,
        yaml_config_path=yaml_path,
        out_path=out,
        artifact_version="2026-05-12-test",
    )
    conn = duckdb.connect(str(out), read_only=True)
    try:
        v = conn.execute(
            "SELECT artifact_version FROM artifact_manifest"
        ).fetchone()[0]
    finally:
        conn.close()
    assert v == "2026-05-12-test"


def test_build_from_fixture_overwrites_existing_out(
    tmp_path: Path, yaml_path: Path, fixture_db: Path
) -> None:
    out = tmp_path / "out.duckdb"
    out.write_bytes(b"not a duckdb file")
    build_from_fixture(
        fixture_path=fixture_db,
        yaml_config_path=yaml_path,
        out_path=out,
        artifact_version="x",
    )
    # If overwrite worked, this should open as a valid DuckDB.
    conn = duckdb.connect(str(out), read_only=True)
    try:
        n = conn.execute(
            "SELECT COUNT(*) FROM artifact_manifest"
        ).fetchone()[0]
    finally:
        conn.close()
    assert n == 1
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd data_prep && poetry run pytest tests/test_build_duckdb.py -v
```

Expected: `ImportError: cannot import name 'build_from_fixture'`.

- [ ] **Step 3: Create `data_prep/src/data_prep/build_duckdb.py`**

```python
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
    parser.add_argument("--from-fixture", type=Path, default=None,
                        help="Copy this fixture and run manifests only (bypasses HF).")
    parser.add_argument("--artifact-version", required=True)
    parser.add_argument("--hf-token", default=None,
                        help="HF token; falls back to HF_TOKEN env var.")
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
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd data_prep && poetry run pytest tests/test_build_duckdb.py -v
```

Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add data_prep/src/data_prep/build_duckdb.py data_prep/tests/test_build_duckdb.py
git commit -m "feat(data_prep): add build orchestrator with fixture mode"
```

---

## Task 9: build_full — labretriever path + integration smoke test

This is the real pipeline. It is gated behind `@pytest.mark.integration` because it requires `HF_TOKEN` and network access. The unit test suite skips it by default (see Task 1's `pyproject.toml` `addopts = "-m 'not integration'"`).

**Files:**
- Modify: `data_prep/src/data_prep/build_duckdb.py`
- Create: `data_prep/tests/test_build_duckdb_smoke.py`

- [ ] **Step 1: Write the failing integration test**

`data_prep/tests/test_build_duckdb_smoke.py`:

```python
"""Integration smoke test for the full labretriever pipeline.

Skipped by default; run with `pytest -m integration`. Requires:
- HF_TOKEN in env (or labretriever cache pre-populated)
- Network access to HuggingFace

This test does NOT verify numerical parity with the Shiny app (that lives
in Phase 1's tests/parity/). It only verifies the pipeline runs end-to-end
and the resulting artifact has the expected shape."""

from __future__ import annotations

import os
from pathlib import Path

import duckdb
import pytest

from data_prep.build_duckdb import build_full

YAML_CONFIG = Path(__file__).resolve().parents[1] / "brentlab_yeast_collection.yaml"


@pytest.mark.integration
def test_build_full_produces_artifact_with_expected_tables(tmp_path: Path) -> None:
    if "HF_TOKEN" not in os.environ:
        pytest.skip("HF_TOKEN not set")

    out = tmp_path / "tfbp.duckdb"
    build_full(
        yaml_config_path=YAML_CONFIG,
        out_path=out,
        artifact_version="2026-05-12-smoke",
        hf_token=os.environ["HF_TOKEN"],
    )

    assert out.exists() and out.stat().st_size > 0

    conn = duckdb.connect(str(out), read_only=True)
    try:
        tables = {
            row[0]
            for row in conn.execute(
                "SELECT table_name FROM information_schema.tables "
                "WHERE table_schema = 'main'"
            ).fetchall()
        }
        # All four manifest tables present
        assert {"artifact_manifest", "dataset_manifest",
                "field_manifest", "filter_level_cache"} <= tables
        # Two derived tables present
        assert {"hackett_analysis_set", "regulator_display_names"} <= tables
        # At least the canonical datasets from the YAML present as tables
        # (not views — the runtime cannot tolerate views).
        view_count = conn.execute(
            "SELECT COUNT(*) FROM information_schema.tables "
            "WHERE table_schema = 'main' AND table_type = 'VIEW'"
        ).fetchone()[0]
        assert view_count == 0, "artifact must contain zero views"

        # Sanity: at least one row in each manifest
        for t in ("artifact_manifest", "dataset_manifest",
                  "field_manifest"):
            n = conn.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
            assert n > 0, f"{t} is empty"
    finally:
        conn.close()
```

- [ ] **Step 2: Run test to verify it fails (without HF — assertion on NotImplementedError)**

For now, run a quick local-only check. The test will skip if `HF_TOKEN` is unset, but the underlying `build_full` still raises `NotImplementedError`. Force a fail to confirm the call path:

```bash
cd data_prep && HF_TOKEN=dummy poetry run pytest tests/test_build_duckdb_smoke.py -v -m integration
```

Expected: `NotImplementedError: build_full is implemented in Task 9...` (the call reaches `build_full` and fails before the HF call).

- [ ] **Step 3: Implement `build_full` in `data_prep/src/data_prep/build_duckdb.py`**

Replace the `NotImplementedError` body of `build_full` with:

```python
def build_full(
    *,
    yaml_config_path: Path,
    out_path: Path,
    artifact_version: str,
    hf_token: str | None,
) -> None:
    """Run the real labretriever pipeline against HuggingFace and write the
    materialized artifact to out_path. Requires HF_TOKEN unless every
    referenced repo is already in the labretriever cache.
    """
    # Lazy import: keeps unit test path free of labretriever (and its
    # transitive HF dependency) so tests run with no network.
    from labretriever import VirtualDB  # type: ignore[import-not-found]

    from data_prep.materialize import materialize_views_as_tables

    out_path = Path(out_path)
    if out_path.exists():
        out_path.unlink()
    out_path.parent.mkdir(parents=True, exist_ok=True)

    conn = duckdb.connect(str(out_path))
    try:
        # 1. labretriever registers `{db_name}` and `{db_name}_meta` views
        #    on the connection, plus `{db_name}_expanded` for comparative
        #    datasets. Note: VirtualDB(local_files_only=False) attempts
        #    network calls; pass token only when present.
        VirtualDB(
            str(yaml_config_path),
            duckdb_connection=conn,
            token=hf_token,
            local_files_only=hf_token is None,
        )

        # 2. Discover every view and materialize it as a table.
        view_names = [
            r[0]
            for r in conn.execute(
                "SELECT table_name FROM information_schema.tables "
                "WHERE table_schema = 'main' AND table_type = 'VIEW'"
            ).fetchall()
        ]
        materialize_views_as_tables(conn, view_names=view_names)

        # 3. Build derived tables (must run BEFORE manifests so
        #    field_manifest/filter_level_cache see them).
        if any(
            r[0] == "hackett_meta"
            for r in conn.execute(
                "SELECT table_name FROM information_schema.tables "
                "WHERE table_schema = 'main' AND table_name = 'hackett_meta'"
            ).fetchall()
        ):
            build_hackett_analysis_set(conn)

        all_db_names = [
            r[0]
            for r in conn.execute(
                "SELECT REPLACE(table_name, '_meta', '') FROM information_schema.tables "
                "WHERE table_schema = 'main' AND table_name LIKE '%_meta'"
            ).fetchall()
        ]
        build_regulator_display_names(conn, db_names=all_db_names)

        # 4. Build the four manifest tables.
        _run_manifests(
            conn,
            yaml_config_path=yaml_config_path,
            artifact_version=artifact_version,
            # parity_tests_passed is False here; CI flips it to True after
            # Phase 1's parity suite passes against this artifact (a
            # follow-up plan automates that signal).
            parity_tests_passed=False,
        )

        conn.execute("CHECKPOINT")
    finally:
        conn.close()
```

Note: `_run_manifests` already calls `build_hackett_analysis_set` and `build_regulator_display_names` — when invoked from `build_full`, those calls will execute twice harmlessly because both functions use `CREATE OR REPLACE`. The earlier explicit calls in `build_full` exist so that derived-table presence is observable for the field_manifest discovery in `_run_manifests`. Leave both in place; remove the duplication only if profiling shows it matters.

- [ ] **Step 4: Verify the integration test now reaches HF**

If you have an HF token locally:

```bash
cd data_prep && HF_TOKEN=$YOUR_TOKEN poetry run pytest tests/test_build_duckdb_smoke.py -v -m integration
```

Expected: passes (slow — minutes — because it actually downloads parquet data on first run).

If you don't have a token, confirm by running unit tests still pass and the smoke test skips:

```bash
cd data_prep && poetry run pytest -v
```

Expected: all unit tests pass; smoke test does not run (excluded by `-m 'not integration'` in `pyproject.toml`).

- [ ] **Step 5: Commit**

```bash
git add data_prep/src/data_prep/build_duckdb.py data_prep/tests/test_build_duckdb_smoke.py
git commit -m "feat(data_prep): implement labretriever path + integration smoke test"
```

---

## Task 10: Copy YAML config + parity placeholder + final wiring

The data_prep package needs its own copy of `brentlab_yeast_collection.yaml` (not a symlink to `reference/`), because the rewrite is the new source of truth and the reference symlink will eventually go away. We also create the `tests/parity/` placeholder so Phase 1 has somewhere to land its tests.

**Files:**
- Create: `data_prep/brentlab_yeast_collection.yaml` (copy from reference)
- Create: `tests/parity/README.md`
- Modify: `CLAUDE.md` (add data_prep section to "Local dev" pointer)

- [ ] **Step 1: Copy the YAML config**

```bash
cp /Volumes/Workspace/Projects/BrentLab/dbproject/tfbpshiny/tfbpshiny/brentlab_yeast_collection.yaml \
   /Volumes/Workspace/Projects/BrentLab/dbproject/tfbpshiny-go/data_prep/brentlab_yeast_collection.yaml
```

- [ ] **Step 2: Verify the copy is byte-identical**

```bash
diff /Volumes/Workspace/Projects/BrentLab/dbproject/tfbpshiny/tfbpshiny/brentlab_yeast_collection.yaml \
     /Volumes/Workspace/Projects/BrentLab/dbproject/tfbpshiny-go/data_prep/brentlab_yeast_collection.yaml
```

Expected: no output (identical). If the reference file changes upstream during this work, re-copy and re-run all tests before continuing.

- [ ] **Step 3: Create `tests/parity/README.md`**

```markdown
# Parity tests

Placeholder. Populated in Phase 1 (Go backend implementation plan). Each
test in this directory will run a "golden URL" against both the reference
Python Shiny query path and the Go backend, and assert numerical
equivalence within documented floating-point tolerances. See spec §11.3.1.
```

- [ ] **Step 4: Update `CLAUDE.md`** to point at the now-existing data_prep

Find this block in `CLAUDE.md`:

```
Three ways to get a `.duckdb` locally:
- `make data-pull` — pulls latest `tfbp.duckdb` from S3 (~30s, needs AWS creds)
- `make data-build` — runs `poetry run python data_prep/build_duckdb.py` (5–10 min, needs `HF_TOKEN`)
- Tests use `tests/fixtures/tfbp_test.duckdb` (committed, instant)
```

Replace with:

```
Three ways to get a `.duckdb` locally:
- `make data-pull` — pulls latest `tfbp.duckdb` from S3. **Not implemented in Phase 0** (see follow-up plan after Phase 1).
- `make data-build` — runs the labretriever pipeline (5–10 min first time, needs `HF_TOKEN`). See `data_prep/README.md`.
- `make data-fixture` — rebuilds `tests/fixtures/tfbp_test.duckdb` from `data_prep/build_fixture.py` (instant, no HF). Tests run against this.
```

- [ ] **Step 5: Run the full unit test suite from the repo root**

```bash
cd /Volumes/Workspace/Projects/BrentLab/dbproject/tfbpshiny-go
make test
```

Expected: all unit tests pass.

- [ ] **Step 6: Manually rebuild the fixture and verify the bootstrap path end-to-end**

```bash
cd /Volumes/Workspace/Projects/BrentLab/dbproject/tfbpshiny-go
make data-fixture
cd data_prep && poetry run build-duckdb \
    --config brentlab_yeast_collection.yaml \
    --out /tmp/tfbp_bootstrap.duckdb \
    --from-fixture ../tests/fixtures/tfbp_test.duckdb \
    --artifact-version 2026-05-12-bootstrap
```

Expected: `Wrote /tmp/tfbp_bootstrap.duckdb`. Verify shape:

```bash
duckdb /tmp/tfbp_bootstrap.duckdb "SELECT artifact_version, schema_version FROM artifact_manifest"
duckdb /tmp/tfbp_bootstrap.duckdb "SELECT db_name, data_type FROM dataset_manifest ORDER BY db_name"
```

Expected: artifact_version `2026-05-12-bootstrap`, schema_version `1`; dataset_manifest contains `callingcards` and `hackett` rows (only — the YAML config has many more but the synthetic fixture only contains those two).

- [ ] **Step 7: Commit**

```bash
git add data_prep/brentlab_yeast_collection.yaml tests/parity/README.md CLAUDE.md
git commit -m "feat(data_prep): copy YAML config + parity placeholder + docs"
```

---

## Phase 0 done — what now

After Task 10 the repo has:
- A working `data_prep/` package with full unit-test coverage of manifest + materialization logic
- A committed `tests/fixtures/tfbp_test.duckdb` ready for Phase 1 to load
- A working `make data-build` (labretriever path, requires HF_TOKEN)
- A working bootstrap path for Phase 1 to produce a manifest-shaped DuckDB without HF: `--from-fixture`

**Before starting Phase 1**, do one manual verification step that this plan does not own:

- Run `make data-build` once with a real `HF_TOKEN`. Inspect the resulting `tfbp.duckdb` against the running Shiny app (point-check 3–5 known queries: a regulator-and-target lookup in callingcards, a hackett perturbation effect, and the dto_expanded comparative view if present). Spec §11.2 calls this "verify by point-checking" — it is the human gate before trusting the artifact in Phase 1's parity tests.

If point-checks pass, write the Phase 1 plan.
