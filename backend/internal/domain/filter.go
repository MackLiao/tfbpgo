package domain

import "encoding/json"

type FilterSpec struct {
	Type  string          `json:"type"`
	Value json.RawMessage `json:"value"`
}

type FiltersByDB map[string]map[string]FilterSpec
