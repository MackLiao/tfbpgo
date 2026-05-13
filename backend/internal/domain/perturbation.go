package domain

type PerturbationRow struct {
	RegulatorLocusTag string  `json:"regulatorLocusTag" db:"regulator_locus_tag"`
	TargetLocusTag    string  `json:"targetLocusTag" db:"target_locus_tag"`
	SampleID          string  `json:"sampleId" db:"sample_id"`
	Value             float64 `json:"value" db:"value"`
}

type PerturbationDatasetResult struct {
	DBName string            `json:"dbName"`
	Column string            `json:"column"`
	Rows   []PerturbationRow `json:"rows"`
}

type PerturbationResponse struct {
	Regulator string                      `json:"regulator"`
	Datasets  []PerturbationDatasetResult `json:"datasets"`
}
