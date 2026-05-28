# Data Prep & Manifest Coverage

**Parity verdict:** The `schema_version=4` manifest plumbing is genuinely complete and end-to-end — `dataset_manifest` carries `effect_col`/`pvalue_col`/`sample_id_field`/`default_active`/`default_filters`/`condition_cols`; `field_manifest` carries `role`/`description`/`level_definitions`/`ui_kind_override`/`numeric_level_sort`; and the Go service (`manifest.go`, `datasets.go`, `select_datasets.go`, `sample_conditions.go`) plus the React `DatasetFilterModal` consume every column with graceful fallbacks. The previously hard-coded Go measurement-column maps were faithfully externalized — `DATASET_MEASUREMENT_COLUMNS` exactly matches Shiny's binding/perturbation `DATASET_COLUMNS`.

The gaps are about **what the artifact carries and how it was derived**, not the plumbing. One **P0** (surfaced only by the real artifact) drops the experimental-condition filter fields; one P1 corrupts hover labels; the rest are content-loss / derivation-coupling issues that degrade UX or risk drift.

## P0 — root cause of the live matrix 400 (P0-3)

### DM-0 · `write_field_manifest`'s `join_keys` heuristic over-excludes shared metadata columns on real data
This is the data-prep root cause of [CRITICAL.md → P0-3](CRITICAL.md) and [select-datasets.md → SD-0a/SD-3](select-datasets.md). `write_field_manifest` (`manifests.py:329-393`) excludes any column present in **both** `{db}` and `{db}_meta` as a presumed join key:
```python
# manifests.py:355-356
join_keys = set(data_cols) & set(meta_cols)
excluded   = _hidden_for(db_name) | _STRUCTURAL_FIELDS | join_keys
```
The heuristic assumes the only data∩meta overlap is the sample-id key. The **synthetic fixture honored that** (data table = measurements only, meta = metadata only). But labretriever's **real** materialized tables replicate the metadata columns into the data table, so `data_cols ∩ meta_cols` includes `condition`/`time`/`treatment` — which are then dropped from `field_manifest` (verified against `local-20260528`: each is a column in both `{db}` and `{db}_meta`, yet absent from `field_manifest`).

Two consequences, both live on real data:
1. **Matrix 400 on first load** — `default_filters` seed `condition`/`time`/`treatment`, which are no longer whitelisted → `CheckField` 400 (P0-3).
2. **Wrong filter set** — the experimental-condition filters vanish while measurement + genomic-coordinate columns (`end`/`start`/`strand`/`seqnames`/`enrichment`/`poisson_pval`) remain, inverting what should be filterable (SD-3).

**Fix:** identify the true join key via the declared `sample_id_field` (or the structural set) rather than the full `data_cols ∩ meta_cols` intersection, and ensure experimental-condition columns survive into `field_manifest`. Add a build-time assertion that every `DEFAULT_DATASET_FILTERS` field exists in `field_manifest` (ties to [DM-5](#p2)). Requires an artifact rebuild.

## P1

### DM-1 · `condition_cols` includes HIDDEN fields → wrong sample hover labels
Shiny derives `AppDatasets.condition_cols` at runtime as: fields where `role == 'experimental_condition'` **and** `level_definitions is not None` **and** `col NOT IN hidden`, where `hidden = HIDDEN_FILTER_FIELDS['*'] | HIDDEN_FILTER_FIELDS[db]` (`vdb_init.py:334-340`). For hackett, `HIDDEN_FILTER_FIELDS['hackett'] = {date, mechanism, restriction, strain}` (`vdb_init.py:32`), so `mechanism`/`restriction` **cannot** appear → `condition_cols['hackett'] = ['time']` at most. `fetch_sample_condition_map` then builds the hover label from only those columns (`sample_conditions.py:86-92`), so hackett dots are labelled by time alone, e.g. **`45`**.

The rewrite hand-codes `CONDITION_COLS['hackett'] = ['mechanism','restriction','time']` (`manifests.py:67`) and writes it verbatim into `dataset_manifest.condition_cols` (`:246`). The Go handler reads `row.ConditionCols`, SELECTs all three from `hackett_meta` with **no hidden-field filtering**, and joins with ` / ` (`sample_conditions.go:66-146`) → label **`ZEV / P / 45`** instead of `45`. Confirmed against the fixture (`hackett_meta` h_0 = `ZEV, P, 45`; `field_manifest` for hackett has only `time` with `role=experimental_condition` — `mechanism`/`restriction` absent because hidden). Same pattern affects `harbison.condition` and `chec_m2025.condition` (`manifests.py:305-306`). The team's own note acknowledges the deliberate inclusion (`STATUS-C.md:145-147`).

> **Important nuance:** the hover-label *mechanism* (the ` / ` join, NaN-dropping, HTML-escape) is fully ported and correct on both Binding and Perturbation — see [non-gaps.md](non-gaps.md). DM-1 is purely about the wrong **column set** being fed into that correct mechanism. **Fix:** derive `condition_cols` the way Shiny does — exclude `HIDDEN_FILTER_FIELDS` and require a non-null `level_definitions` — rather than hand-coding it.

### DM-2 · Dataset-level `description` not carried in the artifact (sidebar tooltip + export README lose it)
Shiny reads `vdb.get_dataset_description(db)` (from the per-dataset `description:` keys in `brentlab_yeast_collection.yaml` — present for callingcards `:19-24`, rossi `:64-67`, degron `:123-126`) and uses it in two visible places: the hover tooltip on each dataset toggle row (`dataset_row.py:50-52`) and the prose body of each dataset's README in the export tarball (`export.py:58-81`). The artifact carries **no** dataset description: `dataset_manifest` has no description column (`manifests.py:272-285`, `manifest.go:18-45`) and `manifests.py:248-262` never reads `ds_cfg['description']`. So the sidebar rows render no tooltip and the Go export README substitutes db_name/data_type/assay/source_repo + filters JSON (`export.go:346-383`) — different content from Shiny.

### DM-3 · `upstream_cols` + the upstream→condition cascade absent from artifact and rewrite
Shiny computes `upstream_cols` at startup (`vdb_init.py:341-352`: non-condition, non-hidden, non-identifier categoricals with `level_definitions is None`) and registers a reactive cascade narrowing condition-checkbox choices to co-occurring levels when an upstream categorical changes (`server/sidebar.py:300-399,39-68`). Only `condition_cols` is externalized; `upstream_cols` is neither computed in data_prep nor present in any manifest table, and the frontend cascade is explicitly deferred (`DatasetFilterModal.tsx:12-15`). This is the data-side blocker for [select-datasets.md → SD-6 cascade](select-datasets.md#sd-6--cascade-narrowing-missing--reset-semantics-inverted--apply-to-all-not-persisted).

## P2

| # | Gap | Evidence |
|---|---|---|
| DM-4 | `FIELD_DESCRIPTIONS` and `FIELD_LEVEL_DEFINITIONS` ship **empty** (`manifests.py:83,88`) → `field_manifest.description`/`level_definitions` are empty strings for every row (verified in fixture). Shiny labels condition levels as `{level_definitions[v]} ({v})` and bool toggles as `{field} ({description})` (`ui.py:185-188`); the rewrite falls back to raw level strings. **Field-level descriptions DO exist in the YAML source** (top-level `description:` block) and are dropped — so this is **data loss**, not merely an unfilled placeholder. |
| DM-5 | `CONDITION_COLS` and `EXPERIMENTAL_CONDITION_FIELDS` are hand-coded **independently and disagree** — the latter marks only `{callingcards:condition, hackett:time}` as `experimental_condition` (`manifests.py:153-156`) while the former lists 5 datasets (`:62-68`). Shiny derives one from the other (single source of truth = `ColumnMeta.role`). Risk of silent drift. |
| DM-6 | SCHEMA.md documents **v3** while code is **v4** (`SCHEMA.md:14,35-45` vs `manifests.py:19` `SCHEMA_VERSION=4`, `build_fixture.py:37`). The v4 columns shipped but are undocumented. |
| DM-7 | ✅ **FIXED by `9cbc3ae`.** ~~Fixture sets `callingcards.sample_id_field='gm_id'` but production forces `'sample_id'`~~ — the fixture `callingcards_meta` now exposes `sample_id`, matching the materialized view; the data_prep assertion was corrected and a positive YAML-`gm_id`→emitted-`sample_id` regression added. |
| DM-8 | Comparison TopN per-source config (`rank_col`, `rank_asc`, `hackett_time_filter`, blacklist, harbison dedup) is re-declared as Go constants (`comparison_topn.go:20-52`) rather than externalized into `dataset_manifest` (deliberate, documented — values are faithful to Shiny). | 
| DM-9 | `BINDING_LABEL_MAP`/`PERTURBATION_LABEL_MAP` re-hard-coded in the **frontend** and can drift from `dataset_manifest.display_name` — not carried in the artifact. |
| DM-10 | `regulator_display_names` `MIN` vs Shiny `FIRST` (also in [sql-numerical-parity.md](sql-numerical-parity.md) SQL-5). |
