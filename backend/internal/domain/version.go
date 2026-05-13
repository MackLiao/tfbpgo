package domain

import "time"

type VersionInfo struct {
	ArtifactVersion string    `json:"artifactVersion"`
	SchemaVersion   int       `json:"schemaVersion"`
	BuiltAt         time.Time `json:"builtAt"`
	DuckDBVersion   string    `json:"duckdbVersion"`
}
