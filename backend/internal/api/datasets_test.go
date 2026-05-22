package api

import (
	"encoding/json"
	"net/http/httptest"
	"testing"

	"github.com/BrentLab/tfbpshiny-go/backend/internal/domain"
	"github.com/stretchr/testify/require"
)

func TestDatasets_ReturnsManifestRows(t *testing.T) {
	s := newTestServer(t)
	rr := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/v/"+s.Manifests.Artifact.ArtifactVersion+"/datasets", nil)
	s.Routes().ServeHTTP(rr, req)
	require.Equal(t, 200, rr.Code)

	var resp domain.DatasetsResponse
	require.NoError(t, json.Unmarshal(rr.Body.Bytes(), &resp))
	require.NotEmpty(t, resp.Datasets)
	for _, d := range resp.Datasets {
		require.NotEmpty(t, d.DBName)
		require.Contains(t, []string{"binding", "perturbation"}, d.DataType)
	}
}

// v4: datasets endpoint must surface defaultActive / defaultFilters /
// conditionCols sourced from dataset_manifest.
func TestDatasets_V4Metadata(t *testing.T) {
	s := newTestServer(t)
	rr := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/v/"+s.Manifests.Artifact.ArtifactVersion+"/datasets", nil)
	s.Routes().ServeHTTP(rr, req)
	require.Equal(t, 200, rr.Code, rr.Body.String())

	var resp domain.DatasetsResponse
	require.NoError(t, json.Unmarshal(rr.Body.Bytes(), &resp))
	byName := map[string]domain.DatasetEntry{}
	for _, d := range resp.Datasets {
		byName[d.DBName] = d
	}

	cc, ok := byName["callingcards"]
	require.True(t, ok)
	require.True(t, cc.DefaultActive)
	require.Equal(t, "", cc.DefaultFilters)
	require.Equal(t, []string{"condition"}, cc.ConditionCols)

	hk, ok := byName["hackett"]
	require.True(t, ok)
	require.True(t, hk.DefaultActive)
	require.Equal(t,
		`{"time":{"type":"numeric","value":[45,45]}}`,
		hk.DefaultFilters,
	)
	require.Equal(t, []string{"mechanism", "restriction", "time"}, hk.ConditionCols)
}
