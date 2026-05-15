package api

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestRequestGuard_RejectsTooManyQueryKeys(t *testing.T) {
	s := newTestServer(t)
	q := url.Values{}
	for i := 0; i <= MaxQueryKeys; i++ {
		q.Set("k"+strings.Repeat("x", i+1), "v")
	}
	req := httptest.NewRequest(http.MethodGet,
		"/api/v/"+s.Manifests.Artifact.ArtifactVersion+"/datasets?"+q.Encode(),
		nil)
	rr := httptest.NewRecorder()
	s.Routes().ServeHTTP(rr, req)
	require.Equal(t, http.StatusBadRequest, rr.Code)
	require.Contains(t, rr.Body.String(), "too many query parameters")
}

func TestRequestGuard_RejectsOversizedValue(t *testing.T) {
	s := newTestServer(t)
	huge := strings.Repeat("x", MaxQueryValueBytes+1)
	q := url.Values{"x": []string{huge}}
	req := httptest.NewRequest(http.MethodGet,
		"/api/v/"+s.Manifests.Artifact.ArtifactVersion+"/datasets?"+q.Encode(),
		nil)
	rr := httptest.NewRecorder()
	s.Routes().ServeHTTP(rr, req)
	require.Equal(t, http.StatusBadRequest, rr.Code)
	require.Contains(t, rr.Body.String(), "query parameter value too large")
}

func TestRequestGuard_PassesNormalRequest(t *testing.T) {
	s := newTestServer(t)
	req := httptest.NewRequest(http.MethodGet,
		"/api/v/"+s.Manifests.Artifact.ArtifactVersion+"/datasets",
		nil)
	rr := httptest.NewRecorder()
	s.Routes().ServeHTTP(rr, req)
	require.Equal(t, http.StatusOK, rr.Code)
}

// TestRequestGuard_NonAPIPathsBypass pins the M3 fix: the guard scopes to
// /api/* only, so SPA navigation URLs with many marketing/UTM params do
// not get a JSON 400 instead of HTML.
func TestRequestGuard_NonAPIPathsBypass(t *testing.T) {
	s := newTestServer(t)
	q := url.Values{}
	for i := 0; i <= MaxQueryKeys; i++ {
		q.Set("utm_"+strings.Repeat("x", i+1), "v")
	}
	// /binding is the SPA fallback (React Router route), not /api/*.
	req := httptest.NewRequest(http.MethodGet, "/binding?"+q.Encode(), nil)
	rr := httptest.NewRecorder()
	s.Routes().ServeHTTP(rr, req)
	// The SPA fallback (without StaticFS in the test server) returns 404
	// because StaticFS is nil. The key assertion: it's NOT 400 from the
	// guard. Any non-400 response proves the guard didn't fire.
	require.NotEqual(t, http.StatusBadRequest, rr.Code,
		"guard should not reject non-/api requests; got: %s",
		rr.Body.String())
}
