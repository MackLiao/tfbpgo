.PHONY: data-fixture data-build data-pull data-publish test test-data-prep \
        frontend-build backend-build backend-build-only backend-test backend-run build \
        test-parity data-fixture-bootstrap parity-record \
        parity parity-snapshot-record \
        loadtest-profile loadtest-cold-burst \
        docker-build docker-run

# ----- docker (Phase 3) ------------------------------------------------------

DOCKER_TAG ?= tfbp-local

docker-build:
	docker build -t $(DOCKER_TAG) --build-arg VERSION=$$(git rev-parse --short HEAD) .

docker-run: docker-build
	docker run --rm \
		-v "$$PWD/tests/fixtures/tfbp_test.duckdb:/data/tfbp.duckdb:ro" \
		-p 8080:8080 \
		$(DOCKER_TAG)

# ----- data_prep (Phase 0) ---------------------------------------------------

data-fixture:
	cd data_prep && poetry run build-fixture --out ../tests/fixtures/tfbp_test.duckdb

data-build:
	cd data_prep && poetry run build-duckdb \
	    --config brentlab_yeast_collection.yaml \
	    --out ../tfbp.duckdb

data-pull:
	@command -v aws >/dev/null || { echo "aws CLI required"; exit 1; }
	@: "$${ARTIFACT_BUCKET:?ARTIFACT_BUCKET env var required}"
	@: "$${ARTIFACT_KEY:?ARTIFACT_KEY env var required}"
	@: "$${ARTIFACT_SHA256:?ARTIFACT_SHA256 env var required}"
	aws s3 cp "s3://$$ARTIFACT_BUCKET/$$ARTIFACT_KEY" ./tfbp.duckdb.new
	@if command -v sha256sum >/dev/null; then \
		echo "$$ARTIFACT_SHA256  ./tfbp.duckdb.new" | sha256sum -c -; \
	else \
		actual=$$(shasum -a 256 ./tfbp.duckdb.new | awk '{print $$1}'); \
		[ "$$actual" = "$$ARTIFACT_SHA256" ] || { echo "SHA mismatch: $$actual"; exit 1; }; \
	fi
	mv ./tfbp.duckdb.new ./tfbp.duckdb
	@echo "Pulled artifact to ./tfbp.duckdb"

data-publish: data-build
	bash deploy/s3-upload.sh

test-data-prep:
	cd data_prep && poetry run pytest

# ----- frontend (Phase 2) ----------------------------------------------------

frontend-build:
	cd frontend && pnpm install --frozen-lockfile && pnpm build

# ----- backend (Phase 1) -----------------------------------------------------

backend-build: frontend-build
	cd backend && go build -o tfbp-server ./cmd/tfbp-server

# Skips frontend rebuild; only safe when backend/static/dist/ is already populated.
backend-build-only:
	cd backend && go build -o tfbp-server ./cmd/tfbp-server

# Top-level "build everything" target: frontend assets first (embedded into
# the Go binary via //go:embed all:dist), then the backend binary.
build: backend-build

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

# Re-record reference-parity fixtures (manual step; requires reference/
# symlink + labretriever poetry env).
parity-record:
	cd data_prep && poetry run python -m data_prep.record_parity_fixtures \
	    --fixture ../tests/fixtures/tfbp_test.duckdb \
	    --golden ../tests/parity/golden_urls.json \
	    --out ../tests/parity/fixtures

# Snapshot-based parity suite (spec §11.3.1 cutover-gate foundation).
# Requires a backend already running on $PARITY_BASE_URL (default :8080).
# See tests/parity/README.md for end-to-end instructions.
parity:
	@bash tests/parity/run_parity.sh

parity-snapshot-record:
	@PARITY_RECORD=1 bash tests/parity/run_parity.sh

# ----- load testing (Phase 3 acceptance) -------------------------------------

loadtest-profile:
	cd tests/loadtest/k6 && k6 run profile.js

loadtest-cold-burst:
	cd tests/loadtest/k6 && k6 run cold_burst.js

# ----- aggregate -------------------------------------------------------------

test: test-data-prep backend-test test-parity
