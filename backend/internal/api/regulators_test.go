package api

import (
	"encoding/json"
	"net/http/httptest"
	"net/url"
	"strings"
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

// TestRegulators_RejectsOversizeSearch verifies the input cap on ?search=
// — a 100-character string should be rejected with 400 (cap is 64).
func TestRegulators_RejectsOversizeSearch(t *testing.T) {
	s := newTestServer(t)
	q := url.Values{"search": []string{strings.Repeat("A", 100)}}
	rr := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/v/"+s.Manifests.Artifact.ArtifactVersion+"/regulators?"+q.Encode(), nil)
	s.Routes().ServeHTTP(rr, req)
	require.Equal(t, 400, rr.Code)
	require.Contains(t, rr.Body.String(), "search exceeds maximum length")
}
