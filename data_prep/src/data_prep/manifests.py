"""Builders for the four manifest tables consumed by the Go service.

See spec §5.5 for the contract. These are the *new* tables added by the
rewrite — separate from the VirtualDB compatibility layer (which is
materialized in materialize.py).
"""

from __future__ import annotations

import duckdb

from data_prep._sql import columns_of, validate_identifier

# Bump when the set of §5.5 tables, or the meaning of their columns,
# changes. The Go binary embeds the compatible range and refuses to
# start against an artifact outside it.
SCHEMA_VERSION: int = 3


# Per-dataset measurement column map. Each value is (effect_col, pvalue_col).
# pvalue_col may be '' for datasets that have no associated p-value column
# (e.g. hackett, hughes_*). These mirror the previously hard-coded Go-side
# maps bindingMeasurementColumn / pertMeasurementColumn and the per-dataset
# switch inside comparison_topn.buildResponsiveExpr.
#
# Datasets present in dataset_manifest but absent from this map will cause
# write_dataset_manifest to raise ValueError — the artifact MUST carry the
# effect/pvalue column names so the Go service can serve the dataset.
DATASET_MEASUREMENT_COLUMNS: dict[str, tuple[str, str]] = {
    # binding
    "callingcards": ("callingcards_enrichment", "poisson_pval"),
    "harbison":     ("effect", "pvalue"),
    "rossi":        ("enrichment", "poisson_pval"),
    "chec_m2025":   ("enrichment", "poisson_pval"),
    # perturbation
    "degron":                ("log2FoldChange", "pvalue"),
    "hughes_overexpression": ("mean_norm_log2fc", ""),
    "hughes_knockout":       ("mean_norm_log2fc", ""),
    "kemmeren":              ("Madj", "pval"),
    "hackett":               ("log2_shrunken_timecourses", ""),
    "hu_reimand":            ("effect", "pval"),
}


# Per-dataset set of fields whose role classification is
# `experimental_condition`. Used by Select Datasets (and the frontend) to
# surface the experimental condition control independently from generic
# filters. All other (db_name, field) rows get role=''.
EXPERIMENTAL_CONDITION_FIELDS: dict[str, frozenset[str]] = {
    "callingcards": frozenset({"condition"}),
    "hackett":      frozenset({"time"}),
}


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
    rows: list[tuple[str, str, str, str, str, str, str, str]] = []
    for repo_id, repo_block in (config.get("repositories") or {}).items():
        datasets = (repo_block or {}).get("dataset") or {}
        for _ds_key, ds_cfg in datasets.items():
            tags = (ds_cfg or {}).get("tags")
            db_name = (ds_cfg or {}).get("db_name")
            if not tags or not db_name:
                continue
            sample_id_block = (ds_cfg or {}).get("sample_id") or {}
            sample_id_field = sample_id_block.get("field")
            if not sample_id_field:
                raise ValueError(
                    f"dataset {db_name!r} (repo {repo_id}) "
                    "missing required sample_id.field in YAML"
                )
            if db_name not in DATASET_MEASUREMENT_COLUMNS:
                raise ValueError(
                    f"dataset {db_name!r} (repo {repo_id}) has no entry in "
                    "DATASET_MEASUREMENT_COLUMNS; add (effect_col, pvalue_col) "
                    "to data_prep.manifests before building this artifact"
                )
            effect_col, pvalue_col = DATASET_MEASUREMENT_COLUMNS[db_name]
            rows.append(
                (
                    db_name,
                    tags.get("data_type", ""),
                    tags.get("assay", ""),
                    tags.get("display_name", ""),
                    repo_id,
                    sample_id_field,
                    effect_col,
                    pvalue_col,
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
            db_name         VARCHAR PRIMARY KEY,
            data_type       VARCHAR NOT NULL,
            assay           VARCHAR NOT NULL,
            display_name    VARCHAR NOT NULL,
            source_repo     VARCHAR NOT NULL,
            sample_id_field VARCHAR NOT NULL,
            effect_col      VARCHAR NOT NULL,
            pvalue_col      VARCHAR NOT NULL
        )
        """
    )
    conn.executemany(
        "INSERT INTO dataset_manifest VALUES (?, ?, ?, ?, ?, ?, ?, ?)", rows
    )


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

    rows: list[tuple[str, str, str]] = []
    for db_name in db_names:
        data_cols = columns_of(conn, db_name)
        meta_cols = columns_of(conn, f"{db_name}_meta")
        if not data_cols and not meta_cols:
            continue

        join_keys = set(data_cols) & set(meta_cols)
        excluded = _hidden_for(db_name) | _STRUCTURAL_FIELDS | join_keys
        exp_cond = EXPERIMENTAL_CONDITION_FIELDS.get(db_name, frozenset())

        seen: set[str] = set()
        for col in [*data_cols, *meta_cols]:
            if col in excluded or col in seen:
                continue
            seen.add(col)
            role = "experimental_condition" if col in exp_cond else ""
            rows.append((db_name, col, role))

    conn.execute("DROP TABLE IF EXISTS field_manifest")
    conn.execute(
        """
        CREATE TABLE field_manifest (
            db_name VARCHAR NOT NULL,
            field   VARCHAR NOT NULL,
            role    VARCHAR NOT NULL,
            PRIMARY KEY (db_name, field)
        )
        """
    )
    if rows:
        conn.executemany(
            "INSERT INTO field_manifest VALUES (?, ?, ?)", rows
        )


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
        # Validate identifiers before any string interpolation.
        safe_db = validate_identifier(db_name)
        safe_field = validate_identifier(field)

        # Prefer meta table; fall back to data table.
        candidate_tables = [f"{safe_db}_meta", safe_db]
        source_table: str | None = None
        for t in candidate_tables:
            cols = columns_of(conn, t)
            if safe_field in cols:
                source_table = t
                break
        if source_table is None:
            continue

        n_distinct = conn.execute(
            f'SELECT COUNT(DISTINCT "{safe_field}") FROM "{source_table}" '
            f'WHERE "{safe_field}" IS NOT NULL'
        ).fetchone()[0]
        if n_distinct == 0 or n_distinct > LEVEL_CACHE_THRESHOLD:
            continue

        conn.execute(
            f"""
            INSERT INTO filter_level_cache
            SELECT
                ?::VARCHAR AS db_name,
                ?::VARCHAR AS field,
                CAST("{safe_field}" AS VARCHAR) AS level
            FROM "{source_table}"
            WHERE "{safe_field}" IS NOT NULL
            GROUP BY "{safe_field}"
            """,
            [db_name, field],
        )
