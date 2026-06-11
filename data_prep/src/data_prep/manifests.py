"""Builders for the four manifest tables consumed by the Go service.

See spec §5.5 for the contract. These are the *new* tables added by the
rewrite — separate from the VirtualDB compatibility layer (which is
materialized in materialize.py).
"""

from __future__ import annotations

import json
from typing import NamedTuple

import duckdb

from data_prep._sql import columns_of, validate_identifier


class ColumnFieldMeta(NamedTuple):
    """Per-(db, field) UX metadata harvested from labretriever at build time
    (DM-4). ``description`` is free-text tooltip copy; ``level_definitions`` is
    a compact JSON ``{level: label}`` string (or ``""`` when none). Both default
    empty so a column with no labretriever metadata degrades gracefully."""

    description: str = ""
    level_definitions: str = ""


# Bump when the set of §5.5 tables, or the meaning of their columns,
# changes. The Go binary embeds the compatible range and refuses to
# start against an artifact outside it.
#
# v5 (2026-05-28 parity re-audit):
#   * dataset_manifest gains `description` (DM-2: per-dataset prose used in the
#     sidebar tooltip + export README) and `upstream_cols` (DM-3/SD-6A: CSV of
#     the categorical columns that drive the condition-choice cascade).
#   * field_manifest.description / level_definitions are now populated
#     (best-effort, from labretriever column metadata) rather than always empty
#     (DM-4).
#   * field_manifest field SET is sourced from {db}_meta only (P0-3/SD-3/DM-0).
SCHEMA_VERSION: int = 5


# ---------------------------------------------------------------------------
# v4 additions — per-(db, field) and per-dataset UX metadata.
# ---------------------------------------------------------------------------

# Datasets whose toggles are on by default on first visit. Mirrors
# reference/tfbpshiny/utils/vdb_init.py:40-50.
DEFAULT_ACTIVE_DATASETS: frozenset[str] = frozenset(
    {
        "harbison",
        "rossi",
        "chec_m2025",
        "callingcards",
        "hackett",
        "kemmeren",
        "degron",
    }
)


# Default filter state applied on first visit. The structure mirrors the
# dict the Shiny app stores in its ``dataset_filters`` reactive value, so it
# can be used as the initial value with no additional handling. Sourced from
# reference/tfbpshiny/utils/vdb_init.py:55-68.
DEFAULT_DATASET_FILTERS: dict[str, dict[str, dict]] = {
    "harbison": {"condition": {"type": "categorical", "value": ["YPD"]}},
    "rossi": {"treatment": {"type": "categorical", "value": ["Normal"]}},
    "chec_m2025": {"condition": {"type": "categorical", "value": ["standard"]}},
    # divergence: Shiny uses [45.0, 45.0] (floats); the Go service represents
    # numeric ranges as [low, high] integers when the underlying DuckDB
    # column is INTEGER (hackett.time). Either form parses to the same
    # interval, but encoding as ints keeps the JSON byte-stable across
    # platforms with differing default float reprs.
    "hackett": {"time": {"type": "numeric", "value": [45, 45]}},
}


# Per-dataset set of fields classified `experimental_condition`. This is the
# SINGLE SOURCE OF TRUTH for the experimental-condition role (DM-5): it drives
# (1) field_manifest.role, (2) the derived CONDITION_COLS below, and (3) the
# "experimental-condition fields override the hidden exclusion" rule in
# write_field_manifest. Mirrors the columns Shiny classifies role=
# 'experimental_condition' (reference/tfbpshiny/utils/vdb_init.py:334-340).
#
# Note vs Shiny: harbison/chec_m2025/rossi each expose a Title-Case display
# column ("Experimental condition") AND a lowercase machine column
# (condition/treatment). Shiny hides the machine column and shows the
# Title-Case one; the Go rewrite cannot use space-containing identifiers
# (SafeIdentRE), so it uses the lowercase machine column as the experimental-
# condition filter — which is why these appear here even though some are listed
# in HIDDEN_FILTER_FIELDS.
#
# This dict is the *intended* set. Both consumers — write_field_manifest (role
# assignment) and write_dataset_manifest (condition_cols) — intersect it with
# each dataset's ACTUAL {db}_meta columns, so listing a column that a given
# artifact's meta table happens to lack is inert: it yields no field_manifest
# row and no condition_cols entry. callingcards is the live example — its only
# condition-like meta columns on the real artifact are the space-containing
# display duplicates ("Carbon source"/"Temperature"), so it ends up with empty
# condition_cols even though it is listed here. Keeping the entry means the
# column auto-activates if a future materialization adds a machine `condition`.
EXPERIMENTAL_CONDITION_FIELDS: dict[str, frozenset[str]] = {
    "callingcards": frozenset({"condition"}),
    "harbison": frozenset({"condition"}),
    "rossi": frozenset({"treatment"}),
    "chec_m2025": frozenset({"condition"}),
    "hackett": frozenset({"time"}),
}


# Per-dataset list of column names whose values together form the sample-
# condition label shown in hover tooltips on the binding/perturbation overlay.
# Mirrors AppDatasets.condition_cols (reference/tfbpshiny/utils/vdb_init.py:
# 334-340: role=='experimental_condition' AND level_definitions is not None AND
# col NOT IN hidden). DERIVED from EXPERIMENTAL_CONDITION_FIELDS so the two can
# never silently disagree (DM-5) and so hidden non-condition columns (hackett
# mechanism/restriction) never leak into the hover label (DM-1: '45', not
# 'ZEV / P / 45').
CONDITION_COLS: dict[str, list[str]] = {
    db: sorted(fields) for db, fields in EXPERIMENTAL_CONDITION_FIELDS.items()
}


# Per-dataset list of *upstream* categorical columns that drive the condition-
# choice cascade in the Select-Datasets filter modal (DM-3 / SD-6A). Mirrors
# AppDatasets.upstream_cols (reference/tfbpshiny/utils/vdb_init.py:341-352:
# non-condition, non-hidden, non-identifier categoricals with level_definitions
# is None). Externalized here (CSV → dataset_manifest.upstream_cols) so the Go
# service + frontend can narrow condition choices without labretriever.
#
# Empty for the current production datasets: the labretriever-computed upstream
# categoricals ("Carbon source", "Experimental condition") are Title-Case
# display columns that the rewrite cannot expose as filters (SafeIdentRE
# forbids spaces), and the remaining non-hidden meta columns are not condition
# drivers. The cascade MECHANISM is wired end-to-end and exercised by a
# synthetic upstream column in the test fixture; it is simply inert where a
# dataset exposes no valid-identifier upstream categorical.
UPSTREAM_COLS: dict[str, list[str]] = {}


# UI kind override + level sort hint per (db_name, field). Mirrors
# reference/tfbpshiny/modules/select_datasets/queries.py:17-20.
# A wildcard key ("", field) matches any dataset that exposes `field`.
# Values are (ui_kind_override, numeric_level_sort).
FIELD_TYPE_OVERRIDES: dict[tuple[str, str], tuple[str, str]] = {
    ("hackett", "time"): ("categorical", "numeric"),
    ("", "temperature_celsius"): ("categorical", "string"),
}


# Hand-curated tooltip copy keyed by (db_name, field). Empty for now; ops
# fills in via PR. Wildcard key ("", field) matches any dataset.
FIELD_DESCRIPTIONS: dict[tuple[str, str], str] = {}


# Per-(db, field) JSON-encodable mapping of {level: label}. Empty for now;
# ops fills in via PR. Wildcard key ("", field) matches any dataset.
FIELD_LEVEL_DEFINITIONS: dict[tuple[str, str], dict[str, str]] = {}


_UI_KIND_OVERRIDE_ALLOWED: frozenset[str] = frozenset(
    {"", "categorical", "numeric", "bool"}
)
_NUMERIC_LEVEL_SORT_ALLOWED: frozenset[str] = frozenset({"", "numeric", "string"})


def _lookup_field_override(db_name: str, field: str) -> tuple[str, str]:
    """Resolve (ui_kind_override, numeric_level_sort) for a (db, field).

    Exact key wins over the ("", field) wildcard. Returns ("", "") when no
    override applies.
    """
    if (db_name, field) in FIELD_TYPE_OVERRIDES:
        return FIELD_TYPE_OVERRIDES[(db_name, field)]
    if ("", field) in FIELD_TYPE_OVERRIDES:
        return FIELD_TYPE_OVERRIDES[("", field)]
    return ("", "")


def _lookup_field_description(db_name: str, field: str) -> str:
    if (db_name, field) in FIELD_DESCRIPTIONS:
        return FIELD_DESCRIPTIONS[(db_name, field)]
    return FIELD_DESCRIPTIONS.get(("", field), "")


def _lookup_field_level_definitions(db_name: str, field: str) -> str:
    """Return JSON-encoded mapping (or empty string when no entry)."""
    val = FIELD_LEVEL_DEFINITIONS.get((db_name, field))
    if val is None:
        val = FIELD_LEVEL_DEFINITIONS.get(("", field))
    if val is None:
        return ""
    return json.dumps(val, sort_keys=True, separators=(",", ":"))


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
    "harbison": ("effect", "pvalue"),
    "rossi": ("enrichment", "poisson_pval"),
    "chec_m2025": ("enrichment", "poisson_pval"),
    # binding — promoter-set variants (2026-06-11 parity re-audit). Each is the
    # same assay re-quantified over a different promoter-region definition, so
    # it shares its parent's measurement columns. The `_peaks` variants are the
    # original-authors' peak-calling output and carry only a `peak_score`
    # binding score (no p-value column). Mirrors reference BINDING_CONFIGS
    # (comparison/queries.py) + DATASET_COLUMNS (binding/queries.py).
    "callingcards_mindel": ("callingcards_enrichment", "poisson_pval"),
    "callingcards_500bp": ("callingcards_enrichment", "poisson_pval"),
    "callingcards_intergenic": ("callingcards_enrichment", "poisson_pval"),
    "rossi_mindel": ("enrichment", "poisson_pval"),
    "rossi_500bp": ("enrichment", "poisson_pval"),
    "rossi_intergenic": ("enrichment", "poisson_pval"),
    "rossi_peaks": ("peak_score", ""),
    "chec_m2025_mindel": ("enrichment", "poisson_pval"),
    "chec_m2025_500bp": ("enrichment", "poisson_pval"),
    "chec_m2025_intergenic": ("enrichment", "poisson_pval"),
    "chec_m2025_peaks": ("peak_score", ""),
    # perturbation
    # degron's responsiveness p-value is the DESeq2-adjusted `padj` column, NOT
    # the raw `pvalue` (reference perturbation/queries.py:DATASET_COLUMNS +
    # DEFAULT_RESPONSIVENESS_PRESETS "padj < 0.1"). The previous "pvalue" value
    # silently computed the degron responsive-ratio against the wrong column.
    "degron": ("log2FoldChange", "padj"),
    "hughes_overexpression": ("mean_norm_log2fc", ""),
    "hughes_knockout": ("mean_norm_log2fc", ""),
    "kemmeren": ("Madj", "pval"),
    "hackett": ("log2_shrunken_timecourses", ""),
    "hu_reimand": ("effect", "pval"),
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
    rows: list[
        tuple[str, str, str, str, str, str, str, str, bool, str, str, str, str]
    ] = []
    for repo_id, repo_block in (config.get("repositories") or {}).items():
        datasets = (repo_block or {}).get("dataset") or {}
        for _ds_key, ds_cfg in datasets.items():
            tags = (ds_cfg or {}).get("tags")
            db_name = (ds_cfg or {}).get("db_name")
            if not tags or not db_name:
                continue
            sample_id_block = (ds_cfg or {}).get("sample_id") or {}
            yaml_sample_id_field = sample_id_block.get("field")
            if not yaml_sample_id_field:
                raise ValueError(
                    f"dataset {db_name!r} (repo {repo_id}) "
                    "missing required sample_id.field in YAML"
                )
            # labretriever unifies all sample-id columns under `sample_id`
            # in the materialized VirtualDB view regardless of source name
            # (e.g. `gm_id` for callingcards). The runtime manifest must
            # reflect the *materialized* column name, not the YAML source.
            sample_id_field = "sample_id"
            if db_name not in DATASET_MEASUREMENT_COLUMNS:
                raise ValueError(
                    f"dataset {db_name!r} (repo {repo_id}) has no entry in "
                    "DATASET_MEASUREMENT_COLUMNS; add (effect_col, pvalue_col) "
                    "to data_prep.manifests before building this artifact"
                )
            effect_col, pvalue_col = DATASET_MEASUREMENT_COLUMNS[db_name]

            # v4: per-dataset UX metadata.
            default_active = db_name in DEFAULT_ACTIVE_DATASETS
            df_block = DEFAULT_DATASET_FILTERS.get(db_name)
            default_filters = (
                json.dumps(df_block, sort_keys=True, separators=(",", ":"))
                if df_block is not None
                else ""
            )
            # DM-5: condition_cols must mirror the experimental_condition rows
            # write_field_manifest emits — and that function only assigns the
            # role to columns that physically exist in {db}_meta (it iterates
            # the actual columns). So intersect the *intended* set
            # (CONDITION_COLS, derived from EXPERIMENTAL_CONDITION_FIELDS) with
            # the columns that actually exist, exactly as write_field_manifest
            # does. Without this, a dataset listed in EXPERIMENTAL_CONDITION_FIELDS
            # whose column is absent from the materialized meta table (real-data
            # callingcards: claimed `condition`, but callingcards_meta has none)
            # writes a phantom condition col that 500s the sample-conditions
            # query. Every production/fixture build materializes {db}_meta before
            # this runs (build_full → materialize_views_as_tables → _run_manifests;
            # build_fixture → _create_* → write_dataset_manifest), so the lookup
            # is always populated; columns_of() returns [] for a missing table.
            meta_cols = set(
                columns_of(conn, f"{db_name}_meta") or columns_of(conn, db_name)
            )
            present_cond = [
                c for c in CONDITION_COLS.get(db_name, []) if c in meta_cols
            ]
            condition_cols = ",".join(present_cond)
            upstream_cols = ",".join(UPSTREAM_COLS.get(db_name, []))

            # v5: per-dataset prose description (DM-2). The YAML stores it as a
            # folded scalar (`description: >-`); normalize internal whitespace
            # so the sidebar tooltip + export README get a single clean line.
            raw_desc = (ds_cfg or {}).get("description") or ""
            description = " ".join(str(raw_desc).split())

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
                    default_active,
                    default_filters,
                    condition_cols,
                    upstream_cols,
                    description,
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
            pvalue_col      VARCHAR NOT NULL,
            default_active  BOOLEAN NOT NULL DEFAULT FALSE,
            default_filters VARCHAR NOT NULL DEFAULT '',
            condition_cols  VARCHAR NOT NULL DEFAULT '',
            upstream_cols   VARCHAR NOT NULL DEFAULT '',
            description     VARCHAR NOT NULL DEFAULT ''
        )
        """
    )
    conn.executemany(
        "INSERT INTO dataset_manifest VALUES "
        "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        rows,
    )


# Mirrors HIDDEN_FILTER_FIELDS from
# reference/tfbpshiny/utils/vdb_init.py:20-36. Update both together if
# this set changes; the runtime Go service consults field_manifest, not
# this constant, so the table is the source of truth at runtime.
HIDDEN_FILTER_FIELDS: dict[str, frozenset[str]] = {
    "*": frozenset(
        {
            "regulator_locus_tag",
            "regulator_symbol",
            "Regulator locus tag",
            "Regulator symbol",
        }
    ),
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

# Always-excluded structural column (not a user-selectable filter/sort). The
# per-dataset sample-id join key (gm_id for callingcards, etc.) is excluded
# additionally via dataset_manifest.sample_id_field inside write_field_manifest.
_STRUCTURAL_FIELDS: frozenset[str] = frozenset({"sample_id"})


def _hidden_for(db_name: str) -> frozenset[str]:
    return HIDDEN_FILTER_FIELDS.get("*", frozenset()) | HIDDEN_FILTER_FIELDS.get(
        db_name, frozenset()
    )


def write_field_manifest(
    conn: duckdb.DuckDBPyConnection,
    column_metadata: dict[str, dict[str, ColumnFieldMeta]] | None = None,
) -> None:
    """Create or replace field_manifest by introspecting per-dataset tables.

    Requires dataset_manifest to exist. For each db_name the filterable /
    whitelisted field set is the columns of ``{db_name}_meta`` — Shiny builds
    its filter modal from ``SELECT * FROM {db}_meta`` only
    (reference/.../dataset_row.py:182-183) — minus:

      * the declared sample-id join key (``dataset_manifest.sample_id_field``),
      * ``_STRUCTURAL_FIELDS``,
      * the hidden fields (``HIDDEN_FILTER_FIELDS``),

    EXCEPT that experimental-condition fields (``EXPERIMENTAL_CONDITION_FIELDS``)
    are always kept even when listed as hidden — they are user-facing filters
    and are seeded by ``DEFAULT_DATASET_FILTERS`` (closing P0-3).

    Why ``{db}_meta`` only (not the old ``{db} ∪ {db}_meta`` union): the
    matrix/breakdown WHERE runs against ``{db}_meta``, and labretriever
    replicates the metadata columns into ``{db}`` too, so the old
    ``data_cols ∩ meta_cols`` join-key heuristic over-excluded the experimental-
    condition columns on real data (P0-3 / DM-0) while leaking data-only
    measurement/coordinate columns as bogus filters that 500 when applied
    (SD-3). Sourcing from ``{db}_meta`` keeps the whitelist and the queryable
    surface in sync.

    Columns whose names are not safe SQL identifiers — labretriever's Title-Case
    display duplicates such as ``"Experimental condition"`` / ``"Carbon source"``
    — are skipped: they are redundant duplicates of the lowercase machine
    columns and cannot be safely interpolated (SafeIdentRE forbids spaces).
    """
    dm_rows = conn.execute(
        "SELECT db_name, sample_id_field FROM dataset_manifest ORDER BY db_name"
    ).fetchall()

    rows: list[tuple[str, str, str, str, str, str, str]] = []
    for db_name, sample_id_field in dm_rows:
        # Filter fields come from {db}_meta. Fall back to the data table only
        # if no _meta table exists (degenerate; every real dataset has one).
        source_cols = columns_of(conn, f"{db_name}_meta") or columns_of(conn, db_name)
        if not source_cols:
            continue

        exp_cond = EXPERIMENTAL_CONDITION_FIELDS.get(db_name, frozenset())
        structural = _STRUCTURAL_FIELDS | {sample_id_field}
        # Experimental-condition fields override the *hidden* exclusion, never
        # the structural join-key exclusion.
        excluded = structural | (_hidden_for(db_name) - exp_cond)

        seen: set[str] = set()
        for col in source_cols:
            if col in excluded or col in seen:
                continue
            try:
                validate_identifier(col)
            except ValueError:
                # Title-Case display duplicate of a lowercase machine column.
                continue
            seen.add(col)
            role = "experimental_condition" if col in exp_cond else ""
            ui_kind, level_sort = _lookup_field_override(db_name, col)
            # DM-4: prefer labretriever-harvested description / level_definitions
            # when available (real build), else fall back to the hand-curated
            # module dicts (empty by default → graceful degradation).
            harvested = (column_metadata or {}).get(db_name, {}).get(col)
            if harvested is not None:
                description = harvested.description
                level_defs = harvested.level_definitions
            else:
                description = _lookup_field_description(db_name, col)
                level_defs = _lookup_field_level_definitions(db_name, col)
            rows.append(
                (db_name, col, role, description, level_defs, ui_kind, level_sort)
            )

    conn.execute("DROP TABLE IF EXISTS field_manifest")
    conn.execute(
        """
        CREATE TABLE field_manifest (
            db_name            VARCHAR NOT NULL,
            field              VARCHAR NOT NULL,
            role               VARCHAR NOT NULL,
            description        VARCHAR NOT NULL DEFAULT '',
            level_definitions  VARCHAR NOT NULL DEFAULT '',
            ui_kind_override   VARCHAR NOT NULL DEFAULT '',
            numeric_level_sort VARCHAR NOT NULL DEFAULT '',
            PRIMARY KEY (db_name, field),
            CHECK (role IN ('', 'experimental_condition')),
            CHECK (ui_kind_override IN ('', 'categorical', 'numeric', 'bool')),
            CHECK (numeric_level_sort IN ('', 'numeric', 'string'))
        )
        """
    )
    if rows:
        conn.executemany(
            "INSERT INTO field_manifest VALUES (?, ?, ?, ?, ?, ?, ?)", rows
        )


def assert_default_filters_in_field_manifest(
    conn: duckdb.DuckDBPyConnection,
) -> None:
    """Fail the build if any field seeded by DEFAULT_DATASET_FILTERS is missing
    from field_manifest for its dataset.

    This is the permanent tripwire for P0-3: on first visit the Select page
    seeds default_filters into the matrix request, and the handler 400s any
    filter field not in field_manifest. The synthetic fixture masked the
    original break (its {db}/{db}_meta did not share metadata columns), so this
    assertion runs against whatever field_manifest the build actually produced
    — real artifact or fixture-bootstrap — and stops a regression before it
    ships, not on first user visit.
    """
    have = {
        (db, fld)
        for db, fld in conn.execute(
            "SELECT db_name, field FROM field_manifest"
        ).fetchall()
    }
    known_dbs = {
        r[0] for r in conn.execute("SELECT db_name FROM dataset_manifest").fetchall()
    }
    missing: list[str] = []
    for db, spec in DEFAULT_DATASET_FILTERS.items():
        if db not in known_dbs:
            # Dataset not present in this build (e.g. a trimmed fixture) — the
            # filter is never seeded, so there is nothing to validate.
            continue
        for fld in spec:
            if (db, fld) not in have:
                missing.append(f"{db}.{fld}")
    if missing:
        raise ValueError(
            "DEFAULT_DATASET_FILTERS references fields absent from field_manifest "
            f"(matrix would 400 on first load): {sorted(missing)}"
        )


def harvest_column_metadata(
    vdb: object,
    db_names: list[str],
) -> dict[str, dict[str, ColumnFieldMeta]]:
    """Best-effort harvest of per-column description / level_definitions from a
    labretriever VirtualDB (DM-4). Used only by the real (build_full) path;
    the fixture/test path passes None and field_manifest descriptions stay
    empty.

    Robust by design: labretriever's column metadata is incomplete/inconsistent
    across datasets (some DataCards lack roles/definitions, some path lookups
    warn), so every dataset is wrapped in try/except and any failure degrades
    that dataset to ``{}`` rather than failing the artifact build.
    """
    out: dict[str, dict[str, ColumnFieldMeta]] = {}
    get_cm = getattr(vdb, "get_column_metadata", None)
    if get_cm is None:
        return out
    for db in db_names:
        # The ENTIRE per-dataset harvest (fetch + per-column parse) is inside the
        # try: labretriever metadata is incomplete/inconsistent, so a column with
        # a non-mapping level_definitions or a non-string description must degrade
        # the dataset to {} — never fail the artifact build.
        try:
            cm = get_cm(db) or {}
            per_col: dict[str, ColumnFieldMeta] = {}
            for col, meta in cm.items():
                desc = str(getattr(meta, "description", None) or "").strip()
                level_defs = getattr(meta, "level_definitions", None)
                ld_json = ""
                if level_defs:
                    ld_json = json.dumps(
                        {str(k): str(v) for k, v in level_defs.items()},
                        sort_keys=True,
                        separators=(",", ":"),
                    )
                if desc or ld_json:
                    per_col[col] = ColumnFieldMeta(
                        description=desc, level_definitions=ld_json
                    )
        except Exception:  # noqa: BLE001 — metadata is best-effort, never fatal
            continue
        if per_col:
            out[db] = per_col
    return out


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
