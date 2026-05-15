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

// TestBinding_RejectsBadFilterType pins the H1 fix: an unknown
// FilterSpec.Type used to surface as a 500 via the cache loader (after
// the prior patch added a default case in buildSquirrelWhereRaw).
// parseFilters now validates the type at request-parse time so the
// client-side error returns 400.
func TestBinding_RejectsBadFilterType(t *testing.T) {
	s := newTestServer(t)
	q := url.Values{
		"regulator": []string{"YBR289W"},
		"datasets":  []string{"callingcards"},
		"filters":   []string{`{"callingcards":{"score":{"type":"bogus","value":"x"}}}`},
	}
	rr := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/v/"+s.Manifests.Artifact.ArtifactVersion+"/binding?"+q.Encode(), nil)
	s.Routes().ServeHTTP(rr, req)
	require.Equal(t, 400, rr.Code)
	require.Contains(t, rr.Body.String(), "bogus")
}

// TestBinding_4xxResponsesAreJSON pins the M1 fix: 4xx responses across
// all handlers go through writeJSONError (Content-Type: application/json,
// Cache-Control: no-store) — previously some paths used stdlib http.Error
// which emits text/plain with no Cache-Control.
func TestBinding_4xxResponsesAreJSON(t *testing.T) {
	s := newTestServer(t)
	rr := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/v/"+s.Manifests.Artifact.ArtifactVersion+"/binding", nil)
	s.Routes().ServeHTTP(rr, req)
	require.Equal(t, 400, rr.Code)
	require.Equal(t, "application/json", rr.Header().Get("Content-Type"))
	require.Equal(t, "no-store", rr.Header().Get("Cache-Control"))
	require.Contains(t, rr.Body.String(), `"error"`)
}
