package api

// TODO: happy-path tests land in Task 21 (parity) once fixtures with
// production measurement columns exist.

import (
	"net/http/httptest"
	"net/url"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestPerturbation_RejectsBindingDatasetForPerturbation(t *testing.T) {
	s := newTestServer(t)
	q := url.Values{"regulator": []string{"YBR289W"}, "datasets": []string{"callingcards"}}
	rr := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/v/"+s.Manifests.Artifact.ArtifactVersion+"/perturbation?"+q.Encode(), nil)
	s.Routes().ServeHTTP(rr, req)
	require.Equal(t, 400, rr.Code)
}

func TestPerturbation_RejectsUnknownDataset(t *testing.T) {
	s := newTestServer(t)
	q := url.Values{"regulator": []string{"YBR289W"}, "datasets": []string{"unknown"}}
	rr := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/v/"+s.Manifests.Artifact.ArtifactVersion+"/perturbation?"+q.Encode(), nil)
	s.Routes().ServeHTTP(rr, req)
	require.Equal(t, 400, rr.Code)
}
