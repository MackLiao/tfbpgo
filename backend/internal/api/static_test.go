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

func TestStatic_ServesSPAIndex(t *testing.T) {
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
	// The Vite-built SPA mounts into <div id="root">.
	require.True(t, strings.Contains(string(body), `<div id="root"`),
		"expected SPA index.html with root div, got: %s", string(body))
}

func TestStatic_SPAFallbackForClientRoutes(t *testing.T) {
	t.Parallel()
	s := newTestServer(t)
	s.StaticFS = static.FS()
	ts := httptest.NewServer(s.Routes())
	t.Cleanup(ts.Close)

	// A client-side route (no real file at /binding) should still serve
	// the SPA shell so React Router can resolve it on the client.
	resp, err := http.Get(ts.URL + "/binding")
	require.NoError(t, err)
	defer resp.Body.Close()

	require.Equal(t, http.StatusOK, resp.StatusCode)
	body, err := io.ReadAll(resp.Body)
	require.NoError(t, err)
	require.True(t, strings.Contains(string(body), `<div id="root"`),
		"expected SPA fallback to serve index.html for /binding, got: %s", string(body))
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
