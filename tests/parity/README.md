# Parity tests

Two complementary parity suites live here:

| Suite | Compares | Run with |
|-------|----------|----------|
| Reference parity (`parity_test.go`) | Go backend vs Python Shiny reference fixtures | `make test-parity` |
| Snapshot parity (`run_parity.sh`) | Go backend vs its own previously-recorded responses | `make parity` |

The reference parity suite is the *correctness* gate (spec §11.3.1). The
snapshot suite is the *regression* gate — it catches accidental changes in
serialization, query shape, ordering, JSON key names, etc. between commits.

---

## 1. Reference parity (Go test harness)

Verifies the Go backend produces JSON numerically equivalent to the Python
Shiny reference implementation.

### Tolerances (spec §11.3.1)

| Type | Rule |
|------|------|
| Floats | relative error <= `1e-9` |
| Integer counts | exact match |
| String identifiers | exact match |
| Booleans | exact match |
| Lists | order-sensitive, element-wise diff |
| Maps | key-set equal, value-wise diff |

### Status

The harness in `parity_test.go` is in place and exercised by CI, but golden
fixtures are not yet recorded. Each `t.Run` calls `t.Skip` when its expected
fixture file is missing, so the harness reports `SKIP` (not `FAIL`) on a fresh
checkout. Recording is a manual step gated on the reference Python environment.

### Recording fixtures

Pre-recorded JSON fixtures live in `tests/parity/fixtures/`. Recording requires
the reference symlink (`/reference -> ../tfbpshiny`) and the Python
labretriever environment with HF access:

```
cd data_prep
poetry run python -m data_prep.record_parity_fixtures \
    --fixture ../tests/fixtures/tfbp_test.duckdb \
    --golden ../tests/parity/golden_urls.json \
    --out ../tests/parity/fixtures
```

Or, equivalently, `make parity-record` from the repo root.

This is a manual step run when:
- A new golden URL is added to `golden_urls.json`.
- The reference Python query SQL changes.
- The fixture DuckDB is regenerated.

### Adding a new golden URL

1. Add `{"name": "...", "url": "/api/v/{v}/...", "tolerance": 1e-9}` to
   `golden_urls.json`.
2. Run `make parity-record` to populate `fixtures/{name}.json`.
3. Run `make test-parity` and confirm the new entry passes.
4. Commit both the URL and its fixture.

### Running

```
make test-parity
```

---

## 2. Snapshot parity (shell-based regression suite)

`run_parity.sh` records exact-byte JSON responses from a running backend the
first time it sees a URL, and diffs against those snapshots on subsequent
runs. Any change in payload (key order, value, rounding, etc.) trips the
diff.

### How it works

- URL list: `golden_urls.txt`, one URL per line. `{V}` is substituted with
  the artifact version from `/api/version` at run time.
- Snapshot filenames: SHA-256 hash (first 16 hex chars) of the *unrendered*
  URL — i.e. with `{V}` left in place. That way, bumping the artifact version
  doesn't invalidate snapshots; only payload changes do.
- Snapshot files: `tests/parity/snapshots/<hash>.expected`, committed to
  the repo. `<hash>.actual` files are scratch and gitignored implicitly
  (only `.expected` is the contract).

### Initial recording

Start the backend pointed at the test fixture (you may need to bootstrap
manifest tables — see "Bootstrapping the fixture" below):

```bash
cd backend && go build -o /tmp/tfbp-server ./cmd/tfbp-server
DUCKDB_PATH=/tmp/tfbp_parity.duckdb /tmp/tfbp-server &
SERVER_PID=$!
sleep 2

# From repo root
PARITY_RECORD=1 tests/parity/run_parity.sh
# or: make parity-record

kill $SERVER_PID
```

The script writes `<hash>.expected` files under `tests/parity/snapshots/`
which should be committed.

### Subsequent runs

```bash
# With backend running on :8080
tests/parity/run_parity.sh
# or: make parity
# Exits 0 if all match; non-zero with unified diffs if anything regresses.
```

### Refreshing snapshots

If a backend change is intentional and you've reviewed the diff:

```bash
PARITY_RECORD=1 tests/parity/run_parity.sh
git add tests/parity/snapshots
git commit -m "test(parity): refresh snapshots after <reason>"
```

### Bootstrapping the fixture

The committed `tests/fixtures/tfbp_test.duckdb` deliberately ships *without*
the four manifest tables (`artifact_manifest`, `dataset_manifest`,
`field_manifest`, `filter_level_cache`) — Go unit tests synthesize those in
a temp copy. To run the snapshot suite, you need a copy of the fixture with
those tables present. A minimal Python snippet (uses the `data_prep` poetry
env's duckdb):

```bash
cp tests/fixtures/tfbp_test.duckdb /tmp/tfbp_parity.duckdb
data_prep/.venv/bin/python <<'PY'
import duckdb
c = duckdb.connect("/tmp/tfbp_parity.duckdb")
c.execute("CREATE TABLE artifact_manifest (artifact_version VARCHAR NOT NULL, schema_version INTEGER NOT NULL, built_at TIMESTAMP NOT NULL, source_yaml_sha256 VARCHAR NOT NULL, duckdb_version VARCHAR NOT NULL, parity_tests_passed BOOLEAN NOT NULL)")
c.execute("INSERT INTO artifact_manifest VALUES ('test-fixture', 2, TIMESTAMP '2026-01-01 00:00:00', 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef', 'test', false)")
c.execute("CREATE TABLE dataset_manifest (db_name VARCHAR PRIMARY KEY, data_type VARCHAR NOT NULL, assay VARCHAR NOT NULL, display_name VARCHAR NOT NULL, source_repo VARCHAR NOT NULL, sample_id_field VARCHAR NOT NULL)")
c.execute("INSERT INTO dataset_manifest VALUES ('callingcards', 'binding', 'CallingCards', 'Calling Cards', 'BrentLab/callingcards', 'gm_id'), ('hackett', 'perturbation', 'overexpression', 'Hackett 2020', 'BrentLab/hackett_2020', 'sample_id')")
c.execute("CREATE TABLE field_manifest (db_name VARCHAR NOT NULL, field VARCHAR NOT NULL, PRIMARY KEY (db_name, field))")
c.execute("INSERT INTO field_manifest VALUES ('callingcards', 'target_locus_tag'), ('callingcards', 'score'), ('hackett', 'target_locus_tag'), ('hackett', 'effect'), ('hackett', 'pvalue')")
c.execute("CREATE TABLE filter_level_cache (db_name VARCHAR NOT NULL, field VARCHAR NOT NULL, level VARCHAR NOT NULL)")
c.execute("CREATE TABLE hackett_analysis_set (sample_id VARCHAR, regulator_locus_tag VARCHAR, regulator_symbol VARCHAR, mechanism VARCHAR, restriction VARCHAR, time DOUBLE, date VARCHAR, strain VARCHAR)")
c.execute("CREATE TABLE regulator_display_names (regulator_locus_tag VARCHAR, regulator_symbol VARCHAR, display_name VARCHAR)")
c.execute("CREATE TABLE dto_expanded (binding_id VARCHAR, perturbation_id VARCHAR, dto_empirical_pvalue DOUBLE, dto_fdr DOUBLE)")
c.close()
PY
```

The fixture's *data* tables (`callingcards`, `hackett`, etc.) only have the
columns needed by current unit tests; URLs that depend on production-only
columns (e.g. `poisson_pval`, `log2_shrunken_timecourses`,
`*_id_source`/`*_id_id` on `dto_expanded`) will return 500. Those URLs
remain in `golden_urls.txt` as TODOs — they'll start passing once the
fixture is extended in Phase 1 Task 21 (full parity fixtures).

### CI hook

Phase 3 will add this to the cutover gate. Today it's a local check.

---

## Layout

```
tests/parity/
  README.md           # this file
  golden_urls.json    # reference-parity URL list (Go harness)
  golden_urls.txt     # snapshot-suite URL list (shell harness)
  parity_test.go      # Go test runner; skips per-entry when fixture missing
  run_parity.sh       # shell snapshot runner (record/diff)
  fixtures/           # recorded JSON for reference parity, "{name}.json"
  snapshots/          # recorded JSON for snapshot suite, "<hash>.expected"
```
