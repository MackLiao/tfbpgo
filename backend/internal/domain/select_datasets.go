package domain

import "encoding/json"

// FieldMeta describes one field's metadata for the Select Datasets filter
// modal. Combines manifest data (role + filter_level_cache levels +
// v4 UX metadata) with runtime introspection (DBType + numeric min/max).
//
// v4: Description / LevelDefinitions / UIKindOverride / NumericLevelSort
// are sourced from field_manifest. Description is free-text tooltip copy
// that the frontend MUST HTML-escape on render. LevelDefinitions is an
// opaque JSON {level: label} object emitted on the wire as a JSON object
// (or omitted entirely when the manifest value is empty — we leave the
// json.RawMessage nil so Go's encoder writes nothing). UIKindOverride
// takes precedence over DuckDB-type-driven Kind inference.
type FieldMeta struct {
	Field            string          `json:"field"`
	DBType           string          `json:"dbType"`
	Kind             string          `json:"kind"`
	Role             string          `json:"role"`
	Description      string          `json:"description,omitempty"`
	LevelDefinitions json.RawMessage `json:"levelDefinitions,omitempty"`
	UIKindOverride   string          `json:"uiKindOverride,omitempty"`
	NumericLevelSort string          `json:"numericLevelSort,omitempty"`
	Levels           []string        `json:"levels,omitempty"`
	NumericMin       *float64        `json:"numericMin,omitempty"`
	NumericMax       *float64        `json:"numericMax,omitempty"`
}

// DatasetFieldsResponse is the shape returned by
// GET /api/v/{v}/datasets/{db}/fields.
type DatasetFieldsResponse struct {
	DBName string      `json:"dbName"`
	Fields []FieldMeta `json:"fields"`
}

// DatasetRegulator is one (locus_tag, symbol) pair plus the pre-formatted
// display string that the filter modal's regulator selectize renders.
type DatasetRegulator struct {
	LocusTag string `json:"locusTag"`
	Symbol   string `json:"symbol"`
	Display  string `json:"display"`
}

// DatasetRegulatorsResponse is the shape returned by
// GET /api/v/{v}/datasets/{db}/regulators.
type DatasetRegulatorsResponse struct {
	DBName     string             `json:"dbName"`
	Regulators []DatasetRegulator `json:"regulators"`
}

// MatrixDiagonalCell is one per-dataset cell in the selection-matrix
// diagonal: distinct regulator + sample counts after filters applied.
type MatrixDiagonalCell struct {
	DBName      string `json:"dbName"`
	NRegulators int64  `json:"nRegulators"`
	NSamples    int64  `json:"nSamples"`
}

// MatrixCrossCell is one pairwise (dbA, dbB) cell: how many regulators the
// two datasets share (post-filter) plus each side's distinct sample count
// restricted to the common regulator set.
type MatrixCrossCell struct {
	PairID   string `json:"pairId"`
	DBA      string `json:"dbA"`
	DBB      string `json:"dbB"`
	NCommon  int64  `json:"nCommon"`
	SamplesA int64  `json:"samplesA"`
	SamplesB int64  `json:"samplesB"`
}

// MatrixResponse is the shape returned by
// GET /api/v/{v}/selection/matrix.
type MatrixResponse struct {
	Diagonal     []MatrixDiagonalCell `json:"diagonal"`
	CrossDataset []MatrixCrossCell    `json:"crossDataset"`
}

// BreakdownColumn is one candidate column's distinct-value count across
// multi-sample regulators in a dataset. 0 means uniform across the
// multi-sample subset; >1 means the column differentiates samples.
type BreakdownColumn struct {
	Field          string `json:"field"`
	DistinctValues int64  `json:"distinctValues"`
}

// BreakdownResponse is the shape returned by
// GET /api/v/{v}/selection/breakdown.
type BreakdownResponse struct {
	DBName  string            `json:"dbName"`
	NMulti  int64             `json:"nMulti"`
	Columns []BreakdownColumn `json:"columns"`
}
