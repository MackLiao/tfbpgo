package domain

type DTORow struct {
	BindingIDSource      string  `json:"bindingIdSource" db:"binding_id_source"`
	PerturbationIDSource string  `json:"perturbationIdSource" db:"perturbation_id_source"`
	DTOEmpiricalPValue   float64 `json:"dtoEmpiricalPvalue" db:"dto_empirical_pvalue"`
	DTOFDR               float64 `json:"dtoFdr" db:"dto_fdr"`
	BindingSetSize       int64   `json:"bindingSetSize" db:"binding_set_size"`
	PerturbationSetSize  int64   `json:"perturbationSetSize" db:"perturbation_set_size"`
	BindingSampleID      string  `json:"bindingSampleId" db:"binding_sample_id"`
	PertSampleID         string  `json:"pertSampleId" db:"pert_sample_id"`
	Time                 string  `json:"time" db:"time"`
}

type DTOResponse struct {
	Rows []DTORow `json:"rows"`
}
