package api

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/BrentLab/tfbpshiny-go/backend/static"
	"github.com/stretchr/testify/require"
)

func TestStatic_ServesPlaceholderIndex(t *testing.T) {
	t.Parallel()
	s := newTestServer(t)
	s.StaticFS = static.FS()
	ts := httptest.NewServer(s.Routes())
	t.Cleanup(ts.Close)

	resp, err := http.Get(ts.URL + "/")
	require.NoError(t, err)
	defer resp.Body.Close()

	require.Equal(t, http.StatusOK, resp.StatusCode)
	body, err := io.ReadAll(resp.Body)
	require.NoError(t, err)
	require.True(t, strings.Contains(string(body), "Phase 1 backend up"),
		"expected placeholder content, got: %s", string(body))
}

func TestStatic_DoesNotShadowAPIRoutes(t *testing.T) {
	t.Parallel()
	s := newTestServer(t)
	s.StaticFS = static.FS()
	ts := httptest.NewServer(s.Routes())
	t.Cleanup(ts.Close)

	resp, err := http.Get(ts.URL + "/healthz")
	require.NoError(t, err)
	defer resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)

	resp2, err := http.Get(ts.URL + "/api/version")
	require.NoError(t, err)
	defer resp2.Body.Close()
	require.Equal(t, http.StatusOK, resp2.StatusCode)
}
