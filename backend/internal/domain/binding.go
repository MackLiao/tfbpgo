package domain

type BindingRow struct {
	RegulatorLocusTag string  `json:"regulatorLocusTag" db:"regulator_locus_tag"`
	TargetLocusTag    string  `json:"targetLocusTag" db:"target_locus_tag"`
	SampleID          string  `json:"sampleId" db:"sample_id"`
	Value             float64 `json:"value" db:"value"`
}

type BindingDatasetResult struct {
	DBName string       `json:"dbName"`
	Column string       `json:"column"`
	Rows   []BindingRow `json:"rows"`
}

type BindingResponse struct {
	Regulator string                 `json:"regulator"`
	Datasets  []BindingDatasetResult `json:"datasets"`
}
