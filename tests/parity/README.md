# Parity tests

These tests verify the Go backend produces JSON numerically equivalent to the
Python Shiny reference implementation, per spec §11.3.1.

## Tolerances (spec §11.3.1)

| Type | Rule |
|------|------|
| Floats | relative error <= `1e-9` |
| Integer counts | exact match |
| String identifiers | exact match |
| Booleans | exact match |
| Lists | order-sensitive, element-wise diff |
| Maps | key-set equal, value-wise diff |

## Status

The harness in `parity_test.go` is in place and exercised by CI, but golden
fixtures are not yet recorded. Each `t.Run` calls `t.Skip` when its expected
fixture file is missing, so the harness reports `SKIP` (not `FAIL`) on a fresh
checkout. Recording is a manual step gated on the reference Python environment.

## Recording fixtures

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

## Adding a new golden URL

1. Add `{"name": "...", "url": "/api/v/{v}/...", "tolerance": 1e-9}` to
   `golden_urls.json`.
2. Run `make parity-record` to populate `fixtures/{name}.json`.
3. Run `make test-parity` and confirm the new entry passes.
4. Commit both the URL and its fixture.

## Running

```
make test-parity
```

## Layout

```
tests/parity/
  README.md           # this file
  golden_urls.json    # list of {name, url, tolerance}
  parity_test.go      # Go test runner; skips per-entry when fixture missing
  fixtures/           # recorded JSON, named "{name}.json"
```
