# data_prep

Build-time pipeline. Produces `tfbp.duckdb` (the runtime artifact) and `tests/fixtures/tfbp_test.duckdb` (the committed test fixture).

## Setup

```bash
cd data_prep
poetry install
```

## Commands

| Goal | Command |
|------|---------|
| Build the test fixture | `poetry run build-fixture --out ../tests/fixtures/tfbp_test.duckdb` |
| Build the runtime artifact (needs HF_TOKEN) | `poetry run build-duckdb --config brentlab_yeast_collection.yaml --out ../tfbp.duckdb` |
| Run unit tests | `poetry run pytest` |
| Run integration tests (needs HF_TOKEN) | `poetry run pytest -m integration` |
