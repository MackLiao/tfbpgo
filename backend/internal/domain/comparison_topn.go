package domain

type TopNRow struct {
	PairKey              string  `json:"pairKey" db:"pair_key"`
	BindingSampleID      string  `json:"bindingSampleId" db:"binding_sample_id"`
	RegulatorLocusTag    string  `json:"regulatorLocusTag" db:"regulator_locus_tag"`
	PerturbationSampleID string  `json:"perturbationSampleId" db:"perturbation_sample_id"`
	N                    int64   `json:"n" db:"n"`
	NResponsive          int64   `json:"nResponsive" db:"n_responsive"`
	ResponsiveRatio      float64 `json:"responsiveRatio" db:"responsive_ratio"`
}

type TopNResponse struct {
	TopN            int       `json:"topN"`
	EffectThreshold float64   `json:"effectThreshold"`
	PValueThreshold float64   `json:"pvalueThreshold"`
	Rows            []TopNRow `json:"rows"`
}
