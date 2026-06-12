package domain

import "encoding/json"

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
	// filter state — wire-encoded as a JSON object (or null when the
	// artifact has no preset). Typed as json.RawMessage so we forward
	// the bytes from the manifest without double-encoding through a
	// Go string. ConditionCols: parsed from the CSV form in the
	// manifest into a clean array so the JSON contract is
	// straightforward.
	DefaultActive  bool            `json:"defaultActive"`
	DefaultFilters json.RawMessage `json:"defaultFilters"`
	ConditionCols  []string        `json:"conditionCols"`
	// v5: UpstreamCols drives the condition-choice cascade in the filter
	// modal (DM-3 / SD-6A). Description is per-dataset prose shown as the
	// sidebar toggle tooltip (DM-2); the frontend MUST HTML-escape it.
	UpstreamCols []string `json:"upstreamCols"`
	Description  string   `json:"description"`
	// v6: only primary datasets are shown in the dataset selector; the
	// promoter-set variants are comparison-only (IsPrimary=false) and the
	// frontend hides them from the selector. Mirrors the reference
	// PRIMARY_DATASETS gating. (log10p columns stay server-side and are NOT
	// part of the wire contract.)
	IsPrimary bool `json:"isPrimary"`
}

type DatasetsResponse struct {
	Datasets []DatasetEntry `json:"datasets"`
}
