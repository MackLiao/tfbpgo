package domain

type Regulator struct {
	LocusTag    string `json:"locusTag" db:"locus_tag"`
	Symbol      string `json:"symbol" db:"symbol"`
	DisplayName string `json:"displayName" db:"display_name"`
}

type RegulatorsResponse struct {
	Regulators []Regulator `json:"regulators"`
}
