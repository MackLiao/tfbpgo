package api

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// TestRespondInternalError_SanitizesBody verifies that the internal-error
// helper never leaks the underlying err string to the client. Sensitive
// internal messages (file paths, SQL fragments, "no measurement column
// mapped for dataset") used to land in the response body via
// http.Error(w, err.Error(), 500); the new helper writes a generic shape.
func TestRespondInternalError_SanitizesBody(t *testing.T) {
	rr := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/v/x/binding", nil)
	respondInternalError(rr, req, errors.New("postgres: connection refused at /var/run/db.sock"))

	require.Equal(t, 500, rr.Code)
	require.Equal(t, "application/json", rr.Header().Get("Content-Type"))
	require.JSONEq(t, `{"error":"internal error"}`, rr.Body.String())
	require.NotContains(t, rr.Body.String(), "postgres")
	require.NotContains(t, rr.Body.String(), "/var/run/db.sock")
}

func TestVersionedPathSetsImmutableCacheControl(t *testing.T) {
	srv := newTestServer(t)
	req := httptest.NewRequest(http.MethodGet, "/api/v/"+srv.ArtifactVersion+"/datasets", nil)
	w := httptest.NewRecorder()
	srv.Routes().ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("want 200, got %d: %s", w.Code, w.Body.String())
	}
	got := w.Header().Get("Cache-Control")
	if !strings.Contains(got, "immutable") || !strings.Contains(got, "max-age=31536000") {
		t.Fatalf("missing immutable Cache-Control: %q", got)
	}
}

func TestUnversionedPathDoesNotSetImmutableCacheControl(t *testing.T) {
	srv := newTestServer(t)
	req := httptest.NewRequest(http.MethodGet, "/api/version", nil)
	w := httptest.NewRecorder()
	srv.Routes().ServeHTTP(w, req)
	got := w.Header().Get("Cache-Control")
	if strings.Contains(got, "immutable") {
		t.Fatalf("/api/version must not be immutable-cached, got: %q", got)
	}
}

// TestVersionedResponseHasXCacheHeader verifies that cached JSON responses
// expose a HIT/MISS X-Cache header so operators (and the cold_burst k6 gate)
// can observe coalescing/admission behaviour from the wire alone.
func TestVersionedResponseHasXCacheHeader(t *testing.T) {
	srv := newTestServer(t)
	req := httptest.NewRequest(http.MethodGet, "/api/v/"+srv.ArtifactVersion+"/datasets", nil)
	w := httptest.NewRecorder()
	srv.Routes().ServeHTTP(w, req)
	if got := w.Header().Get("X-Cache"); got != "HIT" && got != "MISS" {
		t.Fatalf("want HIT|MISS, got %q", got)
	}
}
