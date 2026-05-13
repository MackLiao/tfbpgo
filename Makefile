.PHONY: data-fixture data-build data-pull test test-data-prep \
        backend-build backend-test backend-run \
        test-parity data-fixture-bootstrap parity-record \
        loadtest-profile loadtest-cold-burst

# ----- data_prep (Phase 0) ---------------------------------------------------

data-fixture:
	cd data_prep && poetry run build-fixture --out ../tests/fixtures/tfbp_test.duckdb

data-build:
	cd data_prep && poetry run build-duckdb \
	    --config brentlab_yeast_collection.yaml \
	    --out ../tfbp.duckdb

data-pull:
	@echo "Not implemented in Phase 0; see future plan for S3 publish/pull."
	@exit 1

test-data-prep:
	cd data_prep && poetry run pytest

# ----- backend (Phase 1) -----------------------------------------------------

backend-build:
	cd backend && go build -o tfbp-server ./cmd/tfbp-server

backend-test:
	cd backend && go test ./...

backend-run: backend-build
	./backend/tfbp-server --duckdb=./tfbp.duckdb --port=8080

# Local-dev convenience: copy the test fixture to ./tfbp.duckdb so the Go
# server can boot without S3 or HF. Re-runs `make data-fixture` first to
# (re)build the fixture if missing.
data-fixture-bootstrap: data-fixture
	cp tests/fixtures/tfbp_test.duckdb tfbp.duckdb

# ----- parity tests ----------------------------------------------------------

test-parity:
	cd tests/parity && go test ./...

# Re-record parity fixtures (manual step; requires reference/ symlink +
# labretriever poetry env).
parity-record:
	cd data_prep && poetry run python -m data_prep.record_parity_fixtures \
	    --fixture ../tests/fixtures/tfbp_test.duckdb \
	    --golden ../tests/parity/golden_urls.json \
	    --out ../tests/parity/fixtures

# ----- load testing (Phase 3 acceptance) -------------------------------------

loadtest-profile:
	cd tests/loadtest/k6 && k6 run profile.js

loadtest-cold-burst:
	cd tests/loadtest/k6 && k6 run cold_burst.js

# ----- aggregate -------------------------------------------------------------

test: test-data-prep backend-test test-parity
