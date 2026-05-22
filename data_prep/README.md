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

## Reusing the tfbpshiny HuggingFace cache (no HF_TOKEN needed)

If you've already run the Python Shiny app (`../tfbpshiny`) locally, its
data downloads live in the standard HuggingFace Hub cache as
`datasets--{owner}--{repo}/snapshots/...` directories. Our `build-duckdb`
calls labretriever with `local_files_only=True` whenever `HF_TOKEN` is
unset (`src/data_prep/build_duckdb.py:152`), so a pre-warmed cache is the
fastest path to a real `tfbp.duckdb` for parity work — no HF token, no
re-download.

### One-time: prime the cache by running tfbpshiny once

```bash
cd ../tfbpshiny
# follow tfbpshiny's own README to install and run it; the first launch
# downloads every dataset listed in brentlab_yeast_collection.yaml into
# the HF cache.
```

This populates `$HF_HOME/hub/datasets--*` (default `~/.cache/huggingface/hub/`).

### Then: build the Go artifact off that cache

```bash
cd ../tfbpgo/data_prep
unset HF_TOKEN                              # force local_files_only mode
poetry run build-duckdb \
    --config brentlab_yeast_collection.yaml \
    --out ../tfbp.duckdb
```

If the cache is in a non-default location, point HF at it before running:

```bash
export HF_HOME=/path/to/your/hf/home        # or HF_CACHE_DIR for older clients
```

### Then: run the Go service against the real artifact

```bash
cd ../backend
DUCKDB_PATH=../tfbp.duckdb PORT=8080 go run ./cmd/tfbp-server
```

If `build-duckdb` errors with a `local_files_only` / repo-not-cached
message, your Shiny run didn't pull that dataset — either run Shiny
again with that dataset selected, or set `HF_TOKEN` and let
`build-duckdb` fetch it directly.
