.PHONY: data-fixture data-build data-pull data-pull-latest data-publish test test-data-prep \
        frontend-build backend-build backend-build-only backend-test backend-run build \
        test-parity data-fixture-bootstrap parity-record \
        parity parity-snapshot-record \
        loadtest-profile loadtest-cold-burst \
        loadtest-smoke loadtest-coverage loadtest-cold-fanout \
        loadtest-headtohead-go loadtest-headtohead-shiny loadtest-headtohead \
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

# Label baked into artifact_manifest.version — surfaces as /api/version and the
# /api/v/{v}/ URL segment, and prefixes every cache key. Must be unique per
# build; defaults to today's UTC date. Override: make data-build ARTIFACT_VERSION=foo
ARTIFACT_VERSION ?= $(shell date -u +%Y-%m-%d)

data-fixture:
	cd data_prep && poetry run build-fixture --out ../tests/fixtures/tfbp_test.duckdb

data-build:
	cd data_prep && poetry run build-duckdb \
	    --config brentlab_yeast_collection.yaml \
	    --artifact-version $(ARTIFACT_VERSION) \
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

# Resolve the latest.json pointer in S3 and forward to data-pull.
# Requires `aws` and `jq`. Only ARTIFACT_BUCKET need be set; key + sha are
# read from the s3://${ARTIFACT_BUCKET}/tfbp/latest.json pointer that
# deploy/s3-upload.sh maintains on every publish.
data-pull-latest:
	@command -v aws >/dev/null || { echo "aws CLI required"; exit 1; }
	@command -v jq  >/dev/null || { echo "jq required"; exit 1; }
	@: "$${ARTIFACT_BUCKET:?ARTIFACT_BUCKET env var required}"
	@aws s3 cp "s3://$$ARTIFACT_BUCKET/tfbp/latest.json" /tmp/tfbp-latest.json
	$(eval ARTIFACT_KEY := $(shell jq -r .key    /tmp/tfbp-latest.json))
	$(eval ARTIFACT_SHA256 := $(shell jq -r .sha256 /tmp/tfbp-latest.json))
	@echo "Fetched pointer: key=$(ARTIFACT_KEY) sha=$(ARTIFACT_SHA256)"
	$(MAKE) data-pull ARTIFACT_KEY=$(ARTIFACT_KEY) ARTIFACT_SHA256=$(ARTIFACT_SHA256)

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

# Phase-A fixture scenarios. All are run against a backend already listening on
# $(BASE_URL) (default :8080) backed by tests/fixtures/tfbp_test.duckdb.
# These assert BEHAVIOR + cache/singleflight MECHANICS, not absolute latency,
# so they are safe to gate in CI on the committed fixture.
BASE_URL ?= http://127.0.0.1:8080

# ~20 req/s over the full endpoint mix + negative checks + MISS->HIT flip.
loadtest-smoke:
	cd tests/loadtest/k6 && ARTIFACT_KIND=fixture BASE_URL=$(BASE_URL) k6 run scenarios/smoke.js

# Per-route cold/warm X-Cache flip + Cache-Control matrix + negatives table.
# REQUIRES a freshly restarted backend (cacheable routes must be cold).
loadtest-coverage:
	cd tests/loadtest/k6 && ARTIFACT_KIND=fixture BASE_URL=$(BASE_URL) k6 run scenarios/coverage.js

# Small-K singleflight fan-in mechanics. REQUIRES a freshly restarted backend
# (setup() asserts cache_hits_total==0). Override K/N via env.
loadtest-cold-fanout:
	cd tests/loadtest/k6 && ARTIFACT_KIND=fixture BASE_URL=$(BASE_URL) K=$${K:-3} N=$${N:-40} k6 run scenarios/cold_fanout.js

# ----- Phase D: head-to-head Go vs legacy Shiny (G3) -------------------------
# OPERATIONAL: runs against LIVE hosts on matched t3.small hardware.
# k6 must be run OFF-BOX (not on either target). See:
#   tests/loadtest/k6/headtohead/METHODOLOGY.md  (pinned protocol)
#   tests/loadtest/k6/headtohead/RUNBOOK.md      (step-by-step procedure)
#   tests/loadtest/k6/headtohead/CAPTURE.md      (frame capture prerequisite)
#
# Override via env:
#   RATES=5,40,80  STEP_HOLD=4m  RAMP=30s  WARM=1
#   BASE_URL_GO=https://tfbindingandperturbation.com
#   BASE_URL_SHINY=https://legacy.tfbindingandperturbation.com
#   SHINY_ACTION_TIMEOUT=30000

BASE_URL_GO    ?= https://tfbindingandperturbation.com
BASE_URL_SHINY ?= https://legacy.tfbindingandperturbation.com

# Go arm: arrival_slo.js against the Go service (METHODOLOGY.md §3).
# Set WARM=1 for warm posture; leave unset for cold posture.
loadtest-headtohead-go:
	cd tests/loadtest/k6 && \
	  ARTIFACT_KIND=real \
	  BASE_URL=$(BASE_URL_GO) \
	  $${WARM:+WARM=$$WARM} \
	  k6 run \
	    -e ARTIFACT_KIND=real \
	    -e BASE_URL=$(BASE_URL_GO) \
	    $$([ -n "$$WARM" ] && echo "-e WARM=$$WARM") \
	    $$([ -n "$$RATES" ] && echo "-e RATES=$$RATES") \
	    $$([ -n "$$STEP_HOLD" ] && echo "-e STEP_HOLD=$$STEP_HOLD") \
	    $$([ -n "$$RAMP" ] && echo "-e RAMP=$$RAMP") \
	    --out json=headtohead_go_$$([ -n "$$WARM" ] && echo warm || echo cold).json \
	    scenarios/arrival_slo.js

# Shiny arm: shiny_k6.js against the legacy Shiny service.
# Requires frame capture to be complete (frames.js __CAPTURED__ = true).
loadtest-headtohead-shiny:
	cd tests/loadtest/k6 && \
	  k6 run \
	    -e ARTIFACT_KIND=real \
	    -e BASE_URL=$(BASE_URL_SHINY) \
	    -e SHINY_ACTION_TIMEOUT=$${SHINY_ACTION_TIMEOUT:-30000} \
	    $$([ -n "$$RATES" ] && echo "-e RATES=$$RATES") \
	    $$([ -n "$$STEP_HOLD" ] && echo "-e STEP_HOLD=$$STEP_HOLD") \
	    $$([ -n "$$RAMP" ] && echo "-e RAMP=$$RAMP") \
	    --out json=headtohead_shiny_$$([ -n "$$WARM" ] && echo warm || echo cold).json \
	    headtohead/shiny_k6.js

# Full head-to-head sequence: warm Go -> cold Go -> warm Shiny -> cold Shiny.
# Operator must restart containers between warm/cold runs as directed by RUNBOOK.md.
loadtest-headtohead:
	@echo "=== Phase D head-to-head: Go (warm) ==="
	$(MAKE) loadtest-headtohead-go WARM=1
	@echo ""
	@echo "=== Phase D head-to-head: Go (cold) — restart tfbp container first ==="
	@echo "Restart the Go container (docker compose restart tfbp) then press Enter..."
	@read _confirm
	$(MAKE) loadtest-headtohead-go
	@echo ""
	@echo "=== Phase D head-to-head: Shiny (warm) ==="
	$(MAKE) loadtest-headtohead-shiny WARM=1
	@echo ""
	@echo "=== Phase D head-to-head: Shiny (cold) — restart Shiny container first ==="
	@echo "Restart the Shiny container (docker compose restart shiny) then press Enter..."
	@read _confirm
	$(MAKE) loadtest-headtohead-shiny
	@echo ""
	@echo "=== Run complete. Fill in tests/loadtest-summary.md crossover table. ==="

# ----- aggregate -------------------------------------------------------------

test: test-data-prep backend-test test-parity
