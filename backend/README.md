# tfbp-server

Phase 1 Go backend for the TFBPShiny rewrite. Serves JSON over chi from a
read-only DuckDB artifact built by `data_prep/`.

## Build

```
make backend-build
```

## Run (local dev)

Bootstrap a local DuckDB from the test fixture, then start the server:

```
make data-fixture-bootstrap
make backend-run
```

The server binds `:8080` by default. Override with `--port` or `PORT`.

## Install (Go toolchain)

The backend targets the Go version pinned in `backend/go.mod` (currently
`go 1.25`). Install via your platform package manager or
[https://go.dev/dl/](https://go.dev/dl/), then:

```
cd backend
go mod download
```

## Env vars

| Var | Default | Notes |
|-----|---------|-------|
| `DUCKDB_PATH` | (required) | Path to `tfbp.duckdb`. CLI flag `--duckdb` overrides. |
| `CACHE_SIZE_BYTES` | `134217728` (128 MiB) | Ristretto budget. |
| `LOG_LEVEL` | `info` | slog level. |
| `PORT` | `8080` | HTTP listen port. CLI flag `--port` overrides. |
| `DUCKDB_TEMP_DIR` | `/tmp/duckdb` | Spill directory. |

## Endpoints

Operational (unversioned):

- `GET /healthz` — liveness
- `GET /readyz` — readiness (DuckDB canary)
- `GET /metrics` — Prometheus
- `GET /api/version` — `{artifactVersion, schemaVersion, builtAt, duckdbVersion}`

Data (versioned, `Cache-Control: immutable`):

- `GET /api/v/{v}/datasets`
- `GET /api/v/{v}/regulators?search=...&limit=...`
- `GET /api/v/{v}/binding?regulator=...&datasets=a,b&filters=...`
- `GET /api/v/{v}/perturbation?regulator=...&datasets=a,b&filters=...`
- `GET /api/v/{v}/comparison/topn?binding=...&perturbation=...&top_n=25&effect=0&pvalue=0.05&filters=...`
- `GET /api/v/{v}/comparison/dto`

Stale `{v}` values return `410 Gone` with `Location: /api/version`.

Static SPA:

- `GET /` and any unmatched non-API path serves the embedded React bundle
  from `backend/static/dist/` (built by `frontend/`).

## Tests

```
make backend-test    # unit tests against tests/fixtures/tfbp_test.duckdb
make test-parity     # parity diffs vs recorded Python reference
```

## Architecture (Phase 1 hard constraints)

- `database/sql` + `jmoiron/sqlx` only; no ORM, no `sqlc`.
- Squirrel for safe `WHERE`-clause assembly.
- `embed.FS` for SQL files (under `internal/queries/`) and HTML templates
  (`internal/api/templates/`).
- DuckDB opened **read-only** with §6.3 settings; `MaxOpenConns=2`.
- Ristretto + singleflight cache wrapper with the `Set()` admission check
  and `Wait()` per spec §8.1.
- Identifier whitelisting backed by `dataset_manifest` / `field_manifest`.

Schema versions accepted by this binary: `MinSchemaVersion=2,
MaxSchemaVersion=2` (see `internal/db/startup.go`).
