.PHONY: data-fixture data-build data-pull test test-data-prep

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

test: test-data-prep
