package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestRequireArtifactVersion_410OnMismatch(t *testing.T) {
	s := newTestServer(t)
	rr := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/v/1999-01-01/datasets", nil)
	s.Routes().ServeHTTP(rr, req)
	require.Equal(t, http.StatusGone, rr.Code)
	require.Equal(t, "/api/version", rr.Header().Get("Location"))
}

func TestVersion_Returns200JSON(t *testing.T) {
	s := newTestServer(t)
	rr := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/version", nil)
	s.Routes().ServeHTTP(rr, req)
	require.Equal(t, http.StatusOK, rr.Code)
	require.True(t, strings.HasPrefix(rr.Header().Get("Content-Type"), "application/json"))
}

func TestHealthz_Returns200(t *testing.T) {
	s := newTestServer(t)
	rr := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/healthz", nil)
	s.Routes().ServeHTTP(rr, req)
	require.Equal(t, http.StatusOK, rr.Code)
}
