# Artifact schema contract

This document describes the shape of `tfbp.duckdb`, the immutable runtime
artifact produced by `data_prep/build_duckdb.py`. The Phase 1 Go service
consumes this contract; changes here may require coordinated updates to
the Go binary's compatibility range (see Schema versioning below).

Source of truth at runtime: the four `*_manifest` tables in the artifact
itself. This document mirrors them for human review; if it ever drifts
from `data_prep/src/data_prep/manifests.py`, the code wins.

## Schema versioning

The current schema version is **3**. It is recorded in
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

Datasets without a `tags` block in YAML (e.g., the comparative `dto`
entry) are excluded — their tables still exist but are not user-selectable.

### `field_manifest` (composite primary key)

| Column | Type | Notes |
|--------|------|-------|
| `db_name` | VARCHAR | References `dataset_manifest.db_name`. |
| `field` | VARCHAR | A column name legal as a filter or sort target. |
| `role` | VARCHAR NOT NULL | Role classification (currently `'experimental_condition'` or `''`). Used by Select Datasets to surface experimental-condition controls separately from generic filters. |

Excludes: `regulator_locus_tag`, `regulator_symbol` (globally hidden),
the join key (e.g., `gm_id` or `sample_id`), and per-dataset hidden
fields (see `HIDDEN_FILTER_FIELDS` in `manifests.py`).

### `filter_level_cache` (low-cardinality filter values)

| Column | Type | Notes |
|--------|------|-------|
| `db_name` | VARCHAR NOT NULL | |
| `field` | VARCHAR NOT NULL | Must be in `field_manifest`. |
| `level` | VARCHAR NOT NULL | A distinct value. |

Only fields with `<= 50` distinct values appear (see `LEVEL_CACHE_THRESHOLD`).
Values are CAST to VARCHAR — Phase 1 must handle type coercion if needed.

### Derived tables (also present, schema fixed by ported SQL)

- `hackett_analysis_set` — filtered hackett samples, see `materialize.py:_HACKETT_ANALYSIS_SET_SQL`.
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
