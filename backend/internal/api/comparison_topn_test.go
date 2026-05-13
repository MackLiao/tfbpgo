package api

// TODO: happy-path tests land in Task 21 (parity) once fixtures with
// production columns (poisson_pval, harbison, etc.) exist.

import (
	"net/http/httptest"
	"net/url"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestComparisonTopN_RejectsUnknownBindingDataset(t *testing.T) {
	s := newTestServer(t)
	q := url.Values{"binding": []string{"unknown"}, "perturbation": []string{"hackett"}}
	rr := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/v/"+s.Manifests.Artifact.ArtifactVersion+"/comparison/topn?"+q.Encode(), nil)
	s.Routes().ServeHTTP(rr, req)
	require.Equal(t, 400, rr.Code)
}

func TestComparisonTopN_RejectsUnknownPerturbationDataset(t *testing.T) {
	s := newTestServer(t)
	q := url.Values{"binding": []string{"callingcards"}, "perturbation": []string{"unknown"}}
	rr := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/v/"+s.Manifests.Artifact.ArtifactVersion+"/comparison/topn?"+q.Encode(), nil)
	s.Routes().ServeHTTP(rr, req)
	require.Equal(t, 400, rr.Code)
}
