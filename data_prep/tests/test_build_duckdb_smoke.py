"""Integration smoke test for the full labretriever pipeline.

Skipped by default; run with `pytest -m integration`. Requires:
- HF_TOKEN in env (or labretriever cache pre-populated)
- Network access to HuggingFace
- data_prep/brentlab_yeast_collection.yaml (copied in Task 10)

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
    if not YAML_CONFIG.exists():
        pytest.skip(f"{YAML_CONFIG} missing — copied in Task 10")
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
