# Artifact schema contract

This document describes the shape of `tfbp.duckdb`, the immutable runtime
artifact produced by `data_prep/build_duckdb.py`. The Phase 1 Go service
consumes this contract; changes here may require coordinated updates to
the Go binary's compatibility range (see Schema versioning below).

Source of truth at runtime: the four `*_manifest` tables in the artifact
itself. This document mirrors them for human review; if it ever drifts
from `data_prep/src/data_prep/manifests.py`, the code wins.

## Schema versioning

The current schema version is **5**. It is recorded in
`artifact_manifest.schema_version` and exported as `SCHEMA_VERSION` in
`data_prep/src/data_prep/manifests.py`.

**Bump `SCHEMA_VERSION` and add a CHANGELOG entry below when:**
- A column is added, removed, or renamed in any §5.5 table.
- The semantic meaning of an existing column changes (e.g., from "all
  legal fields" to "only filterable fields").
- A table is added to or removed from the §5.5 set.

**Do NOT bump for:**
- Changes to the row content of a table (those are versioned by
  `artifact_version`, not `schema_version`).
- Changes to the §5.5 *derived* tables (`hackett_analysis_set`,
  `regulator_display_names`) — their structure is fixed by ported SQL.

The Go binary's startup contract (see spec §9.5 step 5) refuses any
artifact whose `schema_version` is outside its compatible range.

## CHANGELOG

- **v5** (2026-05-28 parity re-audit): Added `dataset_manifest.upstream_cols`
  (CSV of categorical columns that drive the condition-choice cascade, DM-3 /
  SD-6A) and `dataset_manifest.description` (per-dataset prose for the sidebar
  tooltip + export README, DM-2). `field_manifest.description` /
  `level_definitions` are now **populated** (best-effort, from labretriever
  column metadata at build time) rather than always empty (DM-4). The
  `field_manifest` **field set** is now sourced from `{db}_meta` columns ONLY
  (minus the declared `sample_id_field` and the hidden set, with
  experimental-condition columns always kept) — previously it unioned `{db}`
  and `{db}_meta`, which on the real artifact dropped the experimental-condition
  filters while leaking data-only measurement/coordinate columns (P0-3 / SD-3 /
  DM-0). `condition_cols` is now derived from `EXPERIMENTAL_CONDITION_FIELDS`
  (single source of truth) so hidden non-condition columns no longer leak into
  hover labels (DM-1 / DM-5). The materialized `hackett` / `hackett_meta`
  tables are restricted to the analysis set at build time (SQL-1).
- **v4**: Added per-dataset UX metadata to `dataset_manifest`
  (`default_active`, `default_filters`, `condition_cols`) and per-field UX
  metadata to `field_manifest` (`description`, `level_definitions`,
  `ui_kind_override`, `numeric_level_sort`), mirroring Shiny's
  `DEFAULT_ACTIVE_DATASETS` / `DEFAULT_DATASET_FILTERS` / `condition_cols`
  and `FIELD_TYPE_OVERRIDES`.
- **v3**: Externalized previously hard-coded Go-side maps into the artifact:
  added `dataset_manifest.effect_col` and `dataset_manifest.pvalue_col`
  (both NOT NULL; `pvalue_col` may be empty string for datasets with no
  associated p-value column, e.g. hackett, hughes_*). Added
  `field_manifest.role` (NOT NULL; currently `'experimental_condition'`
  for `(callingcards, condition)` and `(hackett, time)`, `''` otherwise)
  so the Select Datasets UI can classify experimental-condition fields
  without re-encoding the list in the frontend.
- **v2**: Added `sample_id_field` to `dataset_manifest` so Phase 1 can
  write JOIN queries without re-parsing YAML.
- **v1**: Initial release. Four manifest tables + two derived tables.

## Tables

### `artifact_manifest` (single row)

| Column | Type | Notes |
|--------|------|-------|
| `artifact_version` | VARCHAR NOT NULL | Build-time identifier (e.g., `2026-05-12`). Used as cache-key prefix. |
| `schema_version` | INTEGER NOT NULL | This document's version. |
| `built_at` | TIMESTAMP NOT NULL | Set via `CURRENT_TIMESTAMP` at build. |
| `source_yaml_sha256` | VARCHAR NOT NULL | SHA-256 of `brentlab_yeast_collection.yaml` at build. |
| `duckdb_version` | VARCHAR NOT NULL | The DuckDB version that built this file. |
| `parity_tests_passed` | BOOLEAN NOT NULL | False at build; flipped to True by CI after Phase 1 parity tests pass. |

### `dataset_manifest` (one row per user-selectable dataset)

| Column | Type | Notes |
|--------|------|-------|
| `db_name` | VARCHAR PRIMARY KEY | Identifier for the dataset's tables. Used as `{db_name}` and `{db_name}_meta`. |
| `data_type` | VARCHAR NOT NULL | `binding` or `perturbation`. |
| `assay` | VARCHAR NOT NULL | Assay technology (e.g., `CallingCards`, `ChIP-chip`). |
| `display_name` | VARCHAR NOT NULL | Human-readable label. |
| `source_repo` | VARCHAR NOT NULL | HuggingFace repo path. |
| `sample_id_field` | VARCHAR NOT NULL | Name of the JOIN-key column between `{db_name}` and `{db_name}_meta` (e.g., `gm_id`, `sample_id`). |
| `effect_col` | VARCHAR NOT NULL | Measurement column used by binding/perturbation data endpoints and as the per-pair effect column in comparison topn. |
| `pvalue_col` | VARCHAR NOT NULL | P-value column for the dataset, or `''` if the dataset has no associated p-value column (hackett, hughes_*). |
| `default_active` | BOOLEAN NOT NULL | v4. Pre-select this dataset on first visit (mirrors `DEFAULT_ACTIVE_DATASETS`). |
| `default_filters` | VARCHAR NOT NULL | v4. JSON `{field: FilterSpec}` for the initial filter state, or `''`. Every field referenced here is guaranteed present in `field_manifest` (build-time assertion). |
| `condition_cols` | VARCHAR NOT NULL | v4. CSV of experimental-condition columns whose values form the sample-condition hover label. Derived from `EXPERIMENTAL_CONDITION_FIELDS` (DM-1/DM-5). |
| `upstream_cols` | VARCHAR NOT NULL | v5. CSV of categorical columns that drive the condition-choice cascade in the filter modal (DM-3 / SD-6A). May be empty. |
| `description` | VARCHAR NOT NULL | v5. Per-dataset prose (from the YAML `description:` key) for the sidebar tooltip + export README (DM-2). May be empty. |

Datasets without a `tags` block in YAML (e.g., the comparative `dto`
entry) are excluded — their tables still exist but are not user-selectable.

### `field_manifest` (composite primary key)

| Column | Type | Notes |
|--------|------|-------|
| `db_name` | VARCHAR | References `dataset_manifest.db_name`. |
| `field` | VARCHAR | A `{db_name}_meta` column legal as a filter/WHERE target. |
| `role` | VARCHAR NOT NULL | Role classification (`'experimental_condition'` or `''`). |
| `description` | VARCHAR NOT NULL | v4/v5. Free-text tooltip copy (best-effort from labretriever), or `''`. |
| `level_definitions` | VARCHAR NOT NULL | v4/v5. JSON `{level: label}` mapping, or `''`. |
| `ui_kind_override` | VARCHAR NOT NULL | v4. `''` \| `categorical` \| `numeric` \| `bool` — overrides DuckDB-type inference. |
| `numeric_level_sort` | VARCHAR NOT NULL | v4. `''` \| `numeric` \| `string` — sort hint for numeric-looking categorical levels. |

**Field set (v5):** sourced from `{db_name}_meta` columns ONLY (Shiny builds
its filter modal from `{db}_meta`). Excludes the declared
`dataset_manifest.sample_id_field` join key, `sample_id`, the globally/locally
hidden fields (`HIDDEN_FILTER_FIELDS`), and any column whose name is not a safe
SQL identifier (labretriever's Title-Case display duplicates like
`"Experimental condition"`). **Experimental-condition columns
(`EXPERIMENTAL_CONDITION_FIELDS`) are always kept even when listed as hidden** —
they are user-facing filters seeded by `default_filters`. Hidden-but-valid WHERE
columns like `regulator_locus_tag` stay OUT of `field_manifest`; handlers that
must accept them as WHERE-only fields strip them via `stripRegulatorFilter`.

### `filter_level_cache` (low-cardinality filter values)

| Column | Type | Notes |
|--------|------|-------|
| `db_name` | VARCHAR NOT NULL | |
| `field` | VARCHAR NOT NULL | Must be in `field_manifest`. |
| `level` | VARCHAR NOT NULL | A distinct value. |

Only fields with `<= 50` distinct values appear (see `LEVEL_CACHE_THRESHOLD`).
Values are CAST to VARCHAR — Phase 1 must handle type coercion if needed.

### Derived tables (also present, schema fixed by ported SQL)

- `hackett_analysis_set` — filtered hackett samples, see `materialize.py:_HACKETT_ANALYSIS_SET_SQL`. v5: the materialized `hackett` / `hackett_meta` tables are also restricted to these samples at build time (`filter_hackett_to_analysis_set`, SQL-1), so every downstream hackett query sees only analysis-set rows — matching Shiny's `_filter_hackett_views`.
- `regulator_display_names` — `(regulator_locus_tag, regulator_symbol, display_name)`.

### Per-dataset tables

For each `db_name` in `dataset_manifest`, two tables exist:
- `{db_name}` — data table
- `{db_name}_meta` — metadata table

Schemas vary per dataset; introspect via `information_schema.columns` if
you need shape information at runtime. The `field_manifest` lists
filter/sort-eligible columns across both tables.

## Relationship with the YAML config

`brentlab_yeast_collection.yaml` is a **build-time** input. Phase 1 must
not read it; everything Phase 1 needs is in the manifest tables above.
If you find yourself wanting to read the YAML at runtime, the artifact
contract is missing a column — bump `SCHEMA_VERSION` and add it.
