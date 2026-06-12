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
	// v4 additions — per-dataset UX metadata mirrored from
	// reference/tfbpshiny/utils/vdb_init.py:40-68 + :339-351.
	//
	// DefaultActive: whether this dataset should be pre-selected on first
	// visit. DefaultFilters: opaque JSON {field: FilterSpec} for the
	// initial filter state, forwarded to the frontend as-is.
	// ConditionCols: comma-separated list of field names whose values
	// together form the sample-condition label in binding/perturbation
	// hover tooltips. Parsed downstream into []string.
	DefaultActive  bool   `db:"default_active"`
	DefaultFilters string `db:"default_filters"`
	ConditionCols  string `db:"condition_cols"`
	// v5 additions.
	//
	// UpstreamCols: comma-separated categorical columns that drive the
	// condition-choice cascade in the Select-Datasets filter modal (DM-3 /
	// SD-6A). Parsed downstream into []string. Validated against SafeIdentRE
	// at startup (interpolated into SQL by the cascade query).
	//
	// Description: free-text per-dataset prose (DM-2) shown in the sidebar
	// tooltip + export README. May contain any UTF-8; capped at startup.
	UpstreamCols string `db:"upstream_cols"`
	Description  string `db:"description"`
	// v6 additions — mirror reference/tfbpshiny/utils/vdb_init.py
	// (PRIMARY_DATASETS) + DATASET_COLUMNS.
	//
	// IsPrimary: whether this dataset is a base dataset shown in the
	// dataset selector. The 11 promoter-set variants are is_primary=false
	// (comparison-only; hidden from the selector). Surfaced on the wire as
	// DatasetEntry.IsPrimary so the frontend can filter the selector.
	//
	// Log10PCol / NegLog10PCol: pre-computed log10 / -log10 p-value column
	// names (mirror reference DATASET_COLUMNS). Non-empty only for the base
	// rossi / chec_m2025 binding datasets (log_poisson_pval); '' elsewhere.
	// Consumed server-side by the col=log10pval scatter transform + axis-label
	// resolution (api.resolveMeasurementCol / log10pSourceFor) — NOT part of
	// the /datasets wire contract.
	IsPrimary    bool   `db:"is_primary"`
	Log10PCol    string `db:"log10p_col"`
	NegLog10PCol string `db:"neglog10p_col"`
}

// FieldRow mirrors field_manifest.
type FieldRow struct {
	DBName string `db:"db_name"`
	Field  string `db:"field"`
	// Role added in schema_version=3. Empty string for ordinary fields;
	// "experimental_condition" for fields the Select Datasets UI treats
	// as experimental-condition controls.
	Role string `db:"role"`
	// v4 additions — per-field UX metadata.
	//
	// Description: free-text tooltip copy; may contain any UTF-8 (capped
	// at 1 KB in NewWhitelist). Frontend MUST HTML-escape on render.
	//
	// LevelDefinitions: opaque JSON {level: label} mapping, or empty
	// string. Forwarded to the frontend as-is; capped at 16 KB at
	// startup.
	//
	// UIKindOverride: when non-empty, overrides DuckDB-type-driven kind
	// inference in the Select Datasets fields endpoint. One of
	// "" | "categorical" | "numeric" | "bool".
	//
	// NumericLevelSort: for categorical fields whose level labels look
	// numeric ("45", "90"), whether the frontend should sort them
	// numerically ("numeric") or lexicographically ("string") or take
	// the default ("").
	Description      string `db:"description"`
	LevelDefinitions string `db:"level_definitions"`
	UIKindOverride   string `db:"ui_kind_override"`
	NumericLevelSort string `db:"numeric_level_sort"`
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

	if err := p.DB.SelectContext(ctx, &m.Datasets, `SELECT db_name, data_type, assay, display_name, source_repo, sample_id_field, effect_col, pvalue_col, default_active, default_filters, condition_cols, upstream_cols, description, is_primary, log10p_col, neglog10p_col FROM dataset_manifest ORDER BY db_name`); err != nil {
		return nil, fmt.Errorf("dataset_manifest: %w", err)
	}
	if err := p.DB.SelectContext(ctx, &m.Fields, `SELECT db_name, field, role, description, level_definitions, ui_kind_override, numeric_level_sort FROM field_manifest ORDER BY db_name, field`); err != nil {
		return nil, fmt.Errorf("field_manifest: %w", err)
	}
	if err := p.DB.SelectContext(ctx, &m.Levels, `SELECT db_name, field, level FROM filter_level_cache ORDER BY db_name, field, level`); err != nil {
		return nil, fmt.Errorf("filter_level_cache: %w", err)
	}
	return m, nil
}
