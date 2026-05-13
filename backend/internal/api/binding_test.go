package api

// TODO: happy-path tests land in Task 21 (parity) once fixtures with
// production measurement columns (callingcards_enrichment, etc.) exist.

import (
	"net/http/httptest"
	"net/url"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestBinding_RejectsUnknownDataset(t *testing.T) {
	s := newTestServer(t)
	q := url.Values{"regulator": []string{"YBR289W"}, "datasets": []string{"unknown"}}
	rr := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/v/"+s.Manifests.Artifact.ArtifactVersion+"/binding?"+q.Encode(), nil)
	s.Routes().ServeHTTP(rr, req)
	require.Equal(t, 400, rr.Code)
}

func TestBinding_RejectsPerturbationDatasetForBinding(t *testing.T) {
	s := newTestServer(t)
	// "hackett" is perturbation in the fixture
	q := url.Values{"regulator": []string{"YBR289W"}, "datasets": []string{"hackett"}}
	rr := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/v/"+s.Manifests.Artifact.ArtifactVersion+"/binding?"+q.Encode(), nil)
	s.Routes().ServeHTTP(rr, req)
	require.Equal(t, 400, rr.Code)
}

func TestBinding_RejectsMissingRegulator(t *testing.T) {
	s := newTestServer(t)
	q := url.Values{"datasets": []string{"callingcards"}}
	rr := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/v/"+s.Manifests.Artifact.ArtifactVersion+"/binding?"+q.Encode(), nil)
	s.Routes().ServeHTTP(rr, req)
	require.Equal(t, 400, rr.Code)
}

func TestBinding_RejectsBadFilterField(t *testing.T) {
	s := newTestServer(t)
	q := url.Values{
		"regulator": []string{"YBR289W"},
		"datasets":  []string{"callingcards"},
		"filters":   []string{`{"callingcards":{"definitely_not_a_field":{"type":"categorical","value":["x"]}}}`},
	}
	rr := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/v/"+s.Manifests.Artifact.ArtifactVersion+"/binding?"+q.Encode(), nil)
	s.Routes().ServeHTTP(rr, req)
	require.Equal(t, 400, rr.Code)
}
