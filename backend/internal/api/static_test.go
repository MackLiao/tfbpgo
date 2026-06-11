package api

import (
	"io"
	"io/fs"
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

func TestStatic_RejectsNonGETOnFallback(t *testing.T) {
	t.Parallel()
	s := newTestServer(t)
	s.StaticFS = static.FS()
	ts := httptest.NewServer(s.Routes())
	t.Cleanup(ts.Close)

	resp, err := http.Post(ts.URL+"/foo", "text/plain", strings.NewReader(""))
	require.NoError(t, err)
	defer resp.Body.Close()
	require.Equal(t, http.StatusMethodNotAllowed, resp.StatusCode)
}

func TestStatic_UnknownAPIPathReturnsJSON404(t *testing.T) {
	t.Parallel()
	s := newTestServer(t)
	s.StaticFS = static.FS()
	ts := httptest.NewServer(s.Routes())
	t.Cleanup(ts.Close)

	// An unknown /api/* path must NOT be HTML-shimmed by the SPA fallback;
	// it should return a 404 (not the SPA shell with <div id="root">).
	// Use a path that doesn't hit /api/v/{v}/* (which gates on artifact
	// version) so we exercise the catch-all fallback explicitly.
	resp, err := http.Get(ts.URL + "/api/typo")
	require.NoError(t, err)
	defer resp.Body.Close()
	require.Equal(t, http.StatusNotFound, resp.StatusCode)
	body, err := io.ReadAll(resp.Body)
	require.NoError(t, err)
	require.False(t, strings.Contains(string(body), `<div id="root"`),
		"unknown /api/* must not serve SPA HTML, got: %s", string(body))
}

func TestStatic_SecurityHeadersOnSPAShell(t *testing.T) {
	t.Parallel()
	s := newTestServer(t)
	s.StaticFS = static.FS()
	ts := httptest.NewServer(s.Routes())
	t.Cleanup(ts.Close)

	resp, err := http.Get(ts.URL + "/binding")
	require.NoError(t, err)
	defer resp.Body.Close()

	require.Equal(t, "nosniff", resp.Header.Get("X-Content-Type-Options"))
	require.Equal(t, "DENY", resp.Header.Get("X-Frame-Options"))
	require.Equal(t, "strict-origin-when-cross-origin", resp.Header.Get("Referrer-Policy"))
	require.Equal(t, "no-store", resp.Header.Get("Cache-Control"))

	// CSP: same-origin everything, no 'unsafe-eval'; the index.html inline
	// script (the `window.global` Plotly shim) must be allowed via a sha256
	// hash computed from the shipped shell (see cspForIndex).
	csp := resp.Header.Get("Content-Security-Policy")
	require.Contains(t, csp, "default-src 'self'")
	require.Contains(t, csp, "script-src 'self' 'sha256-")
	require.Contains(t, csp, "frame-ancestors 'none'")
	require.NotContains(t, csp, "unsafe-eval")
}

func TestStatic_ImmutableCacheOnHashedAssets(t *testing.T) {
	t.Parallel()
	s := newTestServer(t)
	s.StaticFS = static.FS()
	ts := httptest.NewServer(s.Routes())
	t.Cleanup(ts.Close)

	// Pick a real content-hashed file from the embedded bundle rather than
	// hardcoding a hash that changes on every frontend rebuild.
	entries, err := fs.ReadDir(static.FS(), "assets")
	require.NoError(t, err)
	require.NotEmpty(t, entries, "embedded bundle must ship hashed assets/")

	resp, err := http.Get(ts.URL + "/assets/" + entries[0].Name())
	require.NoError(t, err)
	defer resp.Body.Close()

	require.Equal(t, http.StatusOK, resp.StatusCode)
	require.Equal(t, "public, max-age=31536000, immutable", resp.Header.Get("Cache-Control"))

	// index.html itself must never be immutable (it names the hashed chunks).
	resp2, err := http.Get(ts.URL + "/")
	require.NoError(t, err)
	defer resp2.Body.Close()
	require.Equal(t, "no-store", resp2.Header.Get("Cache-Control"))
}
