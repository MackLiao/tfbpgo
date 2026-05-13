package api

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestRefIndex_RendersHTML(t *testing.T) {
	t.Parallel()
	s := newTestServer(t)
	ts := httptest.NewServer(s.Routes())
	t.Cleanup(ts.Close)

	resp, err := http.Get(ts.URL + "/_ref")
	require.NoError(t, err)
	defer resp.Body.Close()

	require.Equal(t, http.StatusOK, resp.StatusCode)
	require.Contains(t, resp.Header.Get("Content-Type"), "text/html")

	body, err := io.ReadAll(resp.Body)
	require.NoError(t, err)
	got := string(body)
	require.True(t, strings.Contains(got, "Reference Views"), "expected title in body, got: %s", got)
	require.Contains(t, got, "/_ref/datasets")
}

func TestRefView_DatasetsRendersJSON(t *testing.T) {
	t.Parallel()
	s := newTestServer(t)
	ts := httptest.NewServer(s.Routes())
	t.Cleanup(ts.Close)

	resp, err := http.Get(ts.URL + "/_ref/datasets")
	require.NoError(t, err)
	defer resp.Body.Close()

	require.Equal(t, http.StatusOK, resp.StatusCode)
	body, err := io.ReadAll(resp.Body)
	require.NoError(t, err)
	got := string(body)
	require.Contains(t, got, "<pre")
	// The datasets payload from the bootstrapped fixture includes "callingcards".
	require.Contains(t, got, "callingcards")
}

func TestRefView_UnknownReturns404(t *testing.T) {
	t.Parallel()
	s := newTestServer(t)
	ts := httptest.NewServer(s.Routes())
	t.Cleanup(ts.Close)

	resp, err := http.Get(ts.URL + "/_ref/nope")
	require.NoError(t, err)
	defer resp.Body.Close()
	require.Equal(t, http.StatusNotFound, resp.StatusCode)
}
