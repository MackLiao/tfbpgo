package db

import (
	"context"
	"fmt"
	"time"
)

// ArtifactRow mirrors artifact_manifest (single row).
type ArtifactRow struct {
	ArtifactVersion   string    `db:"artifact_version"`
	SchemaVersion     int       `db:"schema_version"`
	BuiltAt           time.Time `db:"built_at"`
	SourceYAMLSHA256  string    `db:"source_yaml_sha256"`
	DuckDBVersion     string    `db:"duckdb_version"`
	ParityTestsPassed bool      `db:"parity_tests_passed"`
}

// DatasetRow mirrors dataset_manifest.
type DatasetRow struct {
	DBName        string `db:"db_name"`
	DataType      string `db:"data_type"`
	Assay         string `db:"assay"`
	DisplayName   string `db:"display_name"`
	SourceRepo    string `db:"source_repo"`
	SampleIDField string `db:"sample_id_field"`
	// EffectCol / PValueCol moved into the artifact in schema_version=3.
	// EffectCol is required (non-empty for every selectable dataset).
	// PValueCol may be empty for datasets without an associated p-value
	// column (hackett, hughes_*).
	EffectCol string `db:"effect_col"`
	PValueCol string `db:"pvalue_col"`
}

// FieldRow mirrors field_manifest.
type FieldRow struct {
	DBName string `db:"db_name"`
	Field  string `db:"field"`
	// Role added in schema_version=3. Empty string for ordinary fields;
	// "experimental_condition" for fields the Select Datasets UI treats
	// as experimental-condition controls.
	Role string `db:"role"`
}

// FilterLevelRow mirrors filter_level_cache.
type FilterLevelRow struct {
	DBName string `db:"db_name"`
	Field  string `db:"field"`
	Level  string `db:"level"`
}

// Manifests is the in-memory snapshot loaded once at startup.
type Manifests struct {
	Artifact ArtifactRow
	Datasets []DatasetRow
	Fields   []FieldRow
	Levels   []FilterLevelRow
}

// LoadManifests reads all four manifest tables. Returns an error if
// artifact_manifest does not have exactly one row.
func LoadManifests(ctx context.Context, p *Pool) (*Manifests, error) {
	m := &Manifests{}

	rows := []ArtifactRow{}
	if err := p.DB.SelectContext(ctx, &rows, `SELECT artifact_version, schema_version, built_at, source_yaml_sha256, duckdb_version, parity_tests_passed FROM artifact_manifest`); err != nil {
		return nil, fmt.Errorf("artifact_manifest: %w", err)
	}
	if len(rows) != 1 {
		return nil, fmt.Errorf("artifact_manifest must have exactly one row, got %d", len(rows))
	}
	m.Artifact = rows[0]

	if err := p.DB.SelectContext(ctx, &m.Datasets, `SELECT db_name, data_type, assay, display_name, source_repo, sample_id_field, effect_col, pvalue_col FROM dataset_manifest ORDER BY db_name`); err != nil {
		return nil, fmt.Errorf("dataset_manifest: %w", err)
	}
	if err := p.DB.SelectContext(ctx, &m.Fields, `SELECT db_name, field, role FROM field_manifest ORDER BY db_name, field`); err != nil {
		return nil, fmt.Errorf("field_manifest: %w", err)
	}
	if err := p.DB.SelectContext(ctx, &m.Levels, `SELECT db_name, field, level FROM filter_level_cache ORDER BY db_name, field, level`); err != nil {
		return nil, fmt.Errorf("filter_level_cache: %w", err)
	}
	return m, nil
}
