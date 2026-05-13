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
