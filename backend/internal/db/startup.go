package db

import (
	"context"
	"fmt"
	"log/slog"
)

const (
	// schema_version=6 (2026-06-11 promoter-sets + comparison parity
	// re-audit) adds dataset_manifest.is_primary / log10p_col /
	// neglog10p_col. The v6 loader SELECTs those columns, so a v5 artifact
	// (which lacks them) is incompatible.
	MinSchemaVersion = 6
	MaxSchemaVersion = 6
)

var RequiredTables = []string{
	"artifact_manifest",
	"dataset_manifest",
	"field_manifest",
	"filter_level_cache",
	"dto_expanded",
	"hackett_analysis_set",
	"regulator_display_names",
}

type StartupReport struct {
	Manifests      *Manifests
	StorageVersion string
	RuntimeDuckDB  string
}

func RunStartupChecks(ctx context.Context, p *Pool, minSchema, maxSchema int) (*StartupReport, error) {
	r := &StartupReport{}

	// Gate the schema version with a NARROW read BEFORE LoadManifests. The v6
	// loader SELECTs v6-only columns (is_primary/log10p_col/neglog10p_col), so
	// running it first would make a v5 rollback artifact die with a confusing
	// "column not found" binder error instead of this actionable mismatch
	// message. schema_version exists on every artifact version, so this probe is
	// version-agnostic. (Still fail-fast either way — only the message improves.)
	var schemaVersion int
	if err := p.DB.QueryRowxContext(ctx,
		`SELECT schema_version FROM artifact_manifest LIMIT 1`,
	).Scan(&schemaVersion); err != nil {
		return nil, fmt.Errorf("startup: read artifact_manifest.schema_version: %w", err)
	}
	if schemaVersion < minSchema || schemaVersion > maxSchema {
		return nil, fmt.Errorf(
			"startup: artifact schema_version=%d outside compatible range [%d,%d]",
			schemaVersion, minSchema, maxSchema,
		)
	}

	m, err := LoadManifests(ctx, p)
	if err != nil {
		return nil, fmt.Errorf("startup: %w", err)
	}
	r.Manifests = m

	_ = p.DB.QueryRowxContext(ctx, `SELECT current_setting('storage_compatibility_version')`).Scan(&r.StorageVersion)
	_ = p.DB.QueryRowxContext(ctx, `SELECT version()`).Scan(&r.RuntimeDuckDB)

	for _, tbl := range RequiredTables {
		var n int
		if err := p.DB.QueryRowxContext(ctx,
			`SELECT COUNT(*) FROM information_schema.tables WHERE table_name = ?`, tbl,
		).Scan(&n); err != nil {
			return nil, fmt.Errorf("startup: probe table %q: %w", tbl, err)
		}
		if n == 0 {
			return nil, fmt.Errorf("startup: required table missing: %q", tbl)
		}
	}

	var one int
	if err := p.DB.QueryRowxContext(ctx, `SELECT 1 FROM artifact_manifest LIMIT 1`).Scan(&one); err != nil {
		return nil, fmt.Errorf("startup: canary failed: %w", err)
	}

	if !m.Artifact.ParityTestsPassed {
		slog.Warn("artifact_parity_marker_false", "artifact_version", m.Artifact.ArtifactVersion)
	}

	return r, nil
}
