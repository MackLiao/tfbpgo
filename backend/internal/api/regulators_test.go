package api

import (
	"encoding/json"
	"net/http/httptest"
	"net/url"
	"testing"

	"github.com/BrentLab/tfbpshiny-go/backend/internal/domain"
	"github.com/stretchr/testify/require"
)

func TestRegulators_PrefixSearch(t *testing.T) {
	s := newTestServer(t)
	q := url.Values{"search": []string{"Y"}, "limit": []string{"5"}}
	rr := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/v/"+s.Manifests.Artifact.ArtifactVersion+"/regulators?"+q.Encode(), nil)
	s.Routes().ServeHTTP(rr, req)
	require.Equal(t, 200, rr.Code)

	var resp domain.RegulatorsResponse
	require.NoError(t, json.Unmarshal(rr.Body.Bytes(), &resp))
	require.LessOrEqual(t, len(resp.Regulators), 5)
}
