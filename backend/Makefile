.PHONY: openapi-check

# Round-trips backend/openapi.yaml through swagger-cli to catch schema
# regressions before the React SPA's `openapi-typescript` codegen step.
# Requires npx (Node >= 18). No global install needed; the package is
# fetched on demand.
openapi-check:
	npx --yes @apidevtools/swagger-cli validate openapi.yaml
