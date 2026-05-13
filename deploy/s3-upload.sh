#!/usr/bin/env bash
# Publishes tfbp.duckdb to S3 under a date-versioned key.
# Inputs: tfbp.duckdb in the repo root (built by `make data-build`).
# Env vars: ARTIFACT_BUCKET (required), AWS_REGION (default us-east-2).
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
ARTIFACT="${ROOT}/tfbp.duckdb"
[ -f "$ARTIFACT" ] || { echo "FATAL: $ARTIFACT missing — run 'make data-build' first"; exit 1; }
: "${ARTIFACT_BUCKET:?ARTIFACT_BUCKET env var required}"
AWS_REGION="${AWS_REGION:-us-east-2}"

# Portable sha256: prefer sha256sum (Linux/CI), fall back to shasum -a 256 (macOS).
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

VERSION=$(date -u +%Y-%m-%d)
KEY="tfbp/${VERSION}/tfbp.duckdb"
SHA=$(sha256_of "$ARTIFACT")
SIZE=$(stat -c '%s' "$ARTIFACT" 2>/dev/null || stat -f '%z' "$ARTIFACT")

echo "Uploading $ARTIFACT ($SIZE bytes, sha256=$SHA) → s3://${ARTIFACT_BUCKET}/${KEY}"
aws s3 cp --region "$AWS_REGION" "$ARTIFACT" "s3://${ARTIFACT_BUCKET}/${KEY}" \
  --metadata "sha256=${SHA},size=${SIZE},built-at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Write a small JSON manifest that names the latest key + sha256.
MANIFEST="${ROOT}/deploy/artifact-manifest.${VERSION}.json"
mkdir -p "$(dirname "$MANIFEST")"
cat > "$MANIFEST" <<EOF
{
  "version": "$VERSION",
  "key": "$KEY",
  "sha256": "$SHA",
  "size_bytes": $SIZE,
  "uploaded_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
echo "Wrote $MANIFEST"
echo "Set these in .env for the next deploy:"
echo "  ARTIFACT_BUCKET=$ARTIFACT_BUCKET"
echo "  ARTIFACT_KEY=$KEY"
echo "  ARTIFACT_SHA256=$SHA"
