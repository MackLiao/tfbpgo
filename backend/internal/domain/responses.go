package domain

type DatasetEntry struct {
	DBName        string   `json:"dbName"`
	DataType      string   `json:"dataType"`
	Assay         string   `json:"assay"`
	DisplayName   string   `json:"displayName"`
	SourceRepo    string   `json:"sourceRepo"`
	SampleIDField string   `json:"sampleIdField"`
	Fields        []string `json:"fields"`
	// v4: per-dataset UX metadata sourced from dataset_manifest.
	//
	// DefaultActive: pre-select on first visit. DefaultFilters: raw
	// JSON {field: FilterSpec} the frontend applies as the initial
	// filter state (empty string when no preset). ConditionCols:
	// parsed from the CSV form in the manifest into a clean array so
	// the JSON contract is straightforward.
	DefaultActive  bool     `json:"defaultActive"`
	DefaultFilters string   `json:"defaultFilters"`
	ConditionCols []string `json:"conditionCols"`
}

type DatasetsResponse struct {
	Datasets []DatasetEntry `json:"datasets"`
}
