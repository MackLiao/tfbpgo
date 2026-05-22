package db

import (
	"context"
	"fmt"
	"log/slog"
)

const (
	MinSchemaVersion = 4
	MaxSchemaVersion = 4
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

	m, err := LoadManifests(ctx, p)
	if err != nil {
		return nil, fmt.Errorf("startup: %w", err)
	}
	r.Manifests = m

	if m.Artifact.SchemaVersion < minSchema || m.Artifact.SchemaVersion > maxSchema {
		return nil, fmt.Errorf(
			"startup: artifact schema_version=%d outside compatible range [%d,%d]",
			m.Artifact.SchemaVersion, minSchema, maxSchema,
		)
	}

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
