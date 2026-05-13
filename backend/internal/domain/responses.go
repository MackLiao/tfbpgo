package domain

type DatasetEntry struct {
	DBName        string   `json:"dbName"`
	DataType      string   `json:"dataType"`
	Assay         string   `json:"assay"`
	DisplayName   string   `json:"displayName"`
	SourceRepo    string   `json:"sourceRepo"`
	SampleIDField string   `json:"sampleIdField"`
	Fields        []string `json:"fields"`
}

type DatasetsResponse struct {
	Datasets []DatasetEntry `json:"datasets"`
}
