# data_prep

Build-time pipeline. Produces `tfbp.duckdb` (the runtime artifact) and `tests/fixtures/tfbp_test.duckdb` (the committed test fixture).

## Setup

For unit tests and the synthetic fixture (no HF, no labretriever):

```bash
cd data_prep
poetry install
```

For the full pipeline (`build-duckdb` real mode, integration tests):

```bash
cd data_prep
poetry install -E full
```

## What the artifact contains

See [SCHEMA.md](SCHEMA.md) for the table-by-table contract. The Phase 1
Go service depends on this shape; bumps to `SCHEMA_VERSION` are coordinated
through the rules described there.

## Commands

| Goal | Command |
|------|---------|
| Build the test fixture | `poetry run build-fixture --out ../tests/fixtures/tfbp_test.duckdb` |
| Build the runtime artifact (needs HF_TOKEN) | `poetry run build-duckdb --config brentlab_yeast_collection.yaml --out ../tfbp.duckdb` |
| Run unit tests | `poetry run pytest` |
| Run integration tests (needs HF_TOKEN) | `poetry run pytest -m integration` |
