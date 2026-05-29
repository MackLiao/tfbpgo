# CRITICAL — P0 blockers

**Two** genuine P0 defects, both in the Select-Datasets `/selection/matrix` path, both producing the **same** user-facing error (`SelectionMatrix.tsx:77`: *"Failed to load dataset matrix. Check that filters are valid. (HTTP 400)"*) via the handler's `CheckField` rejection (`select_datasets.go:395-402`) — but with **different root causes and fix sites**:

- **P0-3** — seeded `default_filters` reference experimental-condition fields that the real-data `field_manifest` drops → matrix 400s **on first load, default selection, zero user action**. *(This is the one observed live on 2026-05-28.)*
- **P0-2** — the common-regulators flow writes a `regulator_locus_tag` filter that the matrix/breakdown/export handlers reject (only `/corr` strips it).

A third, widely-claimed P0 (NaN→500) was **refuted** — already fixed by `9cbc3ae`; see the note at the bottom so the team knows not to chase it.

> **Verification note:** this file's claims were re-checked against HEAD by the orchestrator (and P0-3 reproduced against the real `tfbp.duckdb` artifact `local-20260528`), *after* the multi-agent workflow — specifically because the workflow produced a false positive on the NaN→500 finding (its grep-based "no guard exists" claim was wrong). P0-3 and P0-2 below are confirmed by reading the actual code + querying the real artifact.

---

## ✅ P0-3 · Real-data default filters 400 the dataset matrix on first load  ⟵ FIXED & VERIFIED LIVE

> **Closed (2026-05-28):** `write_field_manifest` now derives `field_manifest` from `{db}_meta` columns only (declared `sample_id_field` as the structural join key; experimental-condition columns kept even when hidden), and a build-time assertion enforces `default_filters ⊆ field_manifest`. Rebuilt the real artifact (`local-20260528-v5`) and confirmed `GET /selection/matrix` on the default selection + seeded filters returns **200** (was 400). See [README → Implementation status](README.md).

**Affects:** `GET /selection/matrix` (and `/selection/breakdown`, `/export`) on the **default dataset selection, with zero user interaction**.
**Status:** reproduced live 2026-05-28 against the real `tfbp.duckdb` (`artifact_version=local-20260528`): the Select page shows *"Failed to load dataset matrix. Check that filters are valid. (HTTP 400)"* (`frontend/src/plots/SelectionMatrix.tsx:77`, backed by the `selectionMatrix` query → `/selection/matrix`). **Completely masked by the synthetic fixture** — surfaced only once the real artifact was built.

### Root cause — `field_manifest` drops the experimental-condition columns
`write_field_manifest` excludes any column present in **both** `{db}` and `{db}_meta`, assuming the only overlap is the sample-id join key:
```python
# data_prep/src/data_prep/manifests.py:355-356
join_keys = set(data_cols) & set(meta_cols)
excluded   = _hidden_for(db_name) | _STRUCTURAL_FIELDS | join_keys
```
In the **real** artifact, labretriever materializes the metadata columns into *both* tables, so the intersection is far larger than the join key. Verified against `local-20260528` — these fields are columns in **both** `{db}` and `{db}_meta`, hence swept into `join_keys` and **absent from `field_manifest`**:

| dataset | dropped field | in `{db}`? | in `{db}_meta`? | in `field_manifest`? |
|---|---|---|---|---|
| chec_m2025 | `condition` | ✓ | ✓ | ✗ |
| hackett | `time` | ✓ | ✓ | ✗ |
| harbison | `condition` | ✓ | ✓ | ✗ |
| rossi | `treatment` | ✓ | ✓ | ✗ |

### The trip-wire — `default_filters` seed exactly those dropped fields
`dataset_manifest.default_filters` (verified in the artifact) seeds, for the default-active datasets:
- `chec_m2025` → `{"condition":{"type":"categorical","value":["standard"]}}`
- `hackett` → `{"time":{"type":"numeric","value":[45,45]}}`
- `harbison` → `{"condition":{"type":"categorical","value":["YPD"]}}`
- `rossi` → `{"treatment":{"type":"categorical","value":["Normal"]}}`

On first visit the Select page seeds these into the URL (the `useRef`-guarded first-visit-defaults effect), the matrix query forwards them to `/selection/matrix`, and the `CheckField` loop (`select_datasets.go:395-402`) returns `unknown field "condition" for dataset "chec_m2025"` → **400** → the matrix never renders.

### Why the fixture hid it
In `tfbp_test.duckdb` the synthetic `{db}` carried only measurement columns and `{db}_meta` only metadata columns, so `data_cols ∩ meta_cols` was just the sample-id key and `condition`/`time` stayed in `field_manifest`. Real materialized tables replicate metadata columns into the data table, so the intersection over-excludes.

### Knock-on — confirms SD-3 in real data
The same heuristic *leaves* the measurement/coordinate columns in `field_manifest`: chec_m2025 now exposes `enrichment, poisson_pval, end, start, strand, seqnames, target_locus_tag, …` as "filter" fields, and rossi exposes `background_counts, experiment_counts, …`. So on real data the filter modal is doubly wrong — it offers genomic coordinates + p-values as filters (which **500** when filtered, [SD-3](select-datasets.md)) while hiding the actual experimental-condition filters (which **400** via `default_filters`, this finding).

### Fix site (for the implementation session)
`write_field_manifest` (`data_prep/src/data_prep/manifests.py:329-393`) — the `join_keys` heuristic must distinguish the true sample-id join key (use the declared `sample_id_field` / structural set) from shared metadata columns, and must **keep** the experimental-condition columns. Coordinate with `DEFAULT_DATASET_FILTERS` (`:43`) and `EXPERIMENTAL_CONDITION_FIELDS` (`:153`) so every seeded filter field is guaranteed to be in `field_manifest` ([DM-5](data-prep-manifest.md) is the same single-source-of-truth gap). **Requires an artifact rebuild** (`9cbc3ae`'s operator note applies: manifest-semantic fix ⇒ rebuild). A cheap guard for the new session: a build-time assertion that every `default_filters` field appears in `field_manifest`.

---

## ✅ P0-2 · Common-regulators narrowing flow 400s end-to-end  ⟵ FIXED & VERIFIED LIVE

> **Closed (2026-05-28):** a shared `checkFilterFields` helper accepts the hidden-but-valid `regulator_locus_tag` WHERE field (matched against a compile-time constant; values stay parameterized) in the matrix, breakdown, export, and comparison handlers, so the filter is applied (narrows) instead of 400-ing. Verified live: a `regulator_locus_tag` filter on the real matrix narrows each diagonal to the chosen regulators. `stripRegulatorFilter` is still used by the `/corr` handlers (regulators resolved via INTERSECT there).

**Affects:** `GET /selection/matrix`, `GET /selection/breakdown`, `GET /export` — the moment the user clicks "Select N common regulators".
**Verdict:** confirmed (orchestrator-verified directly: handler loops + `CheckField` semantics + manifest exclusion all read at HEAD).

### Shiny behavior (parity target)
Clicking an off-diagonal cell → "Select N common regulators" writes a `regulator_locus_tag` categorical filter to **every** active dataset, then the matrix re-renders narrowed to those regulators because `_matrix_data` passes `dataset_filters()` straight into the matrix queries and `_build_where` emits `"regulator_locus_tag" IN (...)`:

- `reference/tfbpshiny/modules/select_datasets/server/workspace.py:278-287` (writes the filter to every dataset), `:90-123` (matrix re-render uses `dataset_filters()`).
- `reference/tfbpshiny/modules/select_datasets/queries.py:45-48` — `regulator_locus_tag` is a legitimate WHERE field even though it is hidden from the filter **UI**.

### Current behavior (the bug)
The React common-regulators flow writes exactly that filter to every active dataset:
- `frontend/src/routes/Select.tsx:386-391` (`REGULATOR_LOCUS_TAG_FIELD = 'regulator_locus_tag'`).

But `regulator_locus_tag` is in `HIDDEN_FILTER_FIELDS['*']`, so it is **excluded from `field_manifest`** (verified: `data_prep/src/data_prep/manifests.py:299`, and absent from the fixture's `field_manifest`).

And the matrix / breakdown / export handlers loop every filter field and call `Whitelist.CheckField(db, fld)` with **no regulator strip** (verified by reading each loop — none calls `stripRegulatorFilter` beforehand):
- `backend/internal/api/select_datasets.go:395-402` (matrix), `:662-669` (breakdown)
- `backend/internal/api/export.go:117-124` (export)

`CheckField` rejects any field not present in the dataset's manifest field set (verified `backend/internal/db/whitelist.go:166-175`: `if _, ok := fs[field]; !ok { return "unknown field …" }`). So a `regulator_locus_tag` filter → **400**. `stripRegulatorFilter` exists and is correct, but is called **only** by the `/corr` handlers (verified: every call site is in `binding_corr.go:98,315,374,375`; defined in `correlation.go:239`). `select_datasets.go` and `export.go` never call it.

**Net:** after "Select N common regulators", the matrix refetch, the breakdown modal, and export all 400. The headline Select-Datasets narrowing feature crashes on its primary interaction path.

### Two compounding P1s on the same flow (see [select-datasets.md](select-datasets.md))
- **SD-1 — filter-blind resolve.** The resolve endpoint producing the common set ignores active non-regulator filters (`regulators_resolve.go:71-121`; `resolve_intersect.sql` has no WHERE), while the matrix cell the user clicked **is** filter-aware. So the modal shows/selects a *different, larger* set than the cell count.
- **SD-2 — silent 1000-cap.** The resolve result is capped at `maxResolvedTags = 1000` (`regulators_resolve.go:18-19,207-208`); a pair with >1000 common regulators narrows to the alphabetically-first 1000.

### Why it was missed by prior passes
No backend test exercises a `regulator_locus_tag` filter on `/selection/matrix` — `select_datasets_test.go:185-218` only uses `condition`/`time`. The fixture's single-dataset-per-type also makes off-diagonal cells trivial.

### Fix sketch
Apply the same `stripRegulatorFilter` logic the `/corr` handlers use — or special-case `regulator_locus_tag` in the matrix/breakdown/export field-validation loops so it is accepted as a WHERE field (re-verified with `whitelistedIdent`) while staying out of the filter **UI** manifest. Add a backend test with a `regulator_locus_tag` filter on `/selection/matrix`, `/selection/breakdown`, and `/export`.

---

## ⚠️ Refuted P0 — NaN correlation → 500 is ALREADY FIXED (do not chase)

The multi-agent workflow flagged a P0 across binding, perturbation, and sql-parity surfaces: *"a zero-variance regulator group makes DuckDB `corr()` return NaN, which scans into a non-nullable `float64` and `json.Marshal` then 500s the entire `/binding/corr` and `/perturbation/correlations` response, where Shiny `dropna`s it."* Its empirical DuckDB reproduction (corr of a constant series → NaN; `json.Marshal(NaN)` → error) is correct **in isolation**, and the verifier's grep claim that `binding_corr.go` has "no `IsNaN`/skip/continue" appeared to confirm it.

**That grep claim is false.** Reading the actual handler:

```go
// backend/internal/api/binding_corr.go:238-246  (inside buildCorrResponse, the
// shared body of /binding/corr AND /perturbation/correlations)
// DuckDB corr() returns NaN on a zero-variance group ... Drop those rows —
// mirrors the Python reference's df.dropna(subset=["correlation"]) (workspace.py:274)
// and keeps the response JSON-serializable (encoding/json rejects NaN/Inf).
if math.IsNaN(row.Correlation) || math.IsInf(row.Correlation, 0) {
    continue
}
resp.Pairs[slot].Points = append(resp.Pairs[slot].Points, row.CorrPairPoint)
```

The data-carrying path drops NaN/Inf before marshaling. The other two `json.Marshal` sites in the file are: line 159 (the unreachable empty-pairs defensive branch — `resp.Pairs` empty, no NaN possible) and line 417 (the scatter path, whose `R` comes from `pearsonR()` which clamps to `[-1,1]` and returns 0 on degenerate input — never NaN). **There is no unguarded NaN marshal path.** This is a verified non-gap; recorded in [non-gaps.md](non-gaps.md).

**It was fixed mid-audit by commit `9cbc3ae`**, which also *generalized* the fix beyond the corr path: a new `domain.SafeFloat` marshals non-finite values as JSON `null` on `BindingRow.Value`, `PerturbationRow.Value`, `DTORow.*`, and `TopNRow.ResponsiveRatio`, closing the data-tab / DTO / TopN non-finite paths too. So the agents weren't hallucinating a bug — they read the code in the brief window before `9cbc3ae` landed.

*Lesson for future audits: the workflow's "presence" claims (this SQL contains X) proved reliable, but its "absence" claims (no guard / never called) require a direct re-read — the cited line range (230-238) stopped three lines short of the guard at 243.*
