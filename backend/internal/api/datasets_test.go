package api

import (
	"encoding/json"
	"net/http/httptest"
	"testing"

	"github.com/BrentLab/tfbpshiny-go/backend/internal/domain"
	"github.com/stretchr/testify/require"
)

func TestDatasets_ReturnsManifestRows(t *testing.T) {
	s := newTestServer(t)
	rr := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/v/"+s.Manifests.Artifact.ArtifactVersion+"/datasets", nil)
	s.Routes().ServeHTTP(rr, req)
	require.Equal(t, 200, rr.Code)

	var resp domain.DatasetsResponse
	require.NoError(t, json.Unmarshal(rr.Body.Bytes(), &resp))
	require.NotEmpty(t, resp.Datasets)
	for _, d := range resp.Datasets {
		require.NotEmpty(t, d.DBName)
		require.Contains(t, []string{"binding", "perturbation"}, d.DataType)
	}
}

// v4: datasets endpoint must surface defaultActive / defaultFilters /
// conditionCols sourced from dataset_manifest.
func TestDatasets_V4Metadata(t *testing.T) {
	s := newTestServer(t)
	rr := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/v/"+s.Manifests.Artifact.ArtifactVersion+"/datasets", nil)
	s.Routes().ServeHTTP(rr, req)
	require.Equal(t, 200, rr.Code, rr.Body.String())

	var resp domain.DatasetsResponse
	require.NoError(t, json.Unmarshal(rr.Body.Bytes(), &resp))
	byName := map[string]domain.DatasetEntry{}
	for _, d := range resp.Datasets {
		byName[d.DBName] = d
	}

	cc, ok := byName["callingcards"]
	require.True(t, ok)
	require.True(t, cc.DefaultActive)
	// Empty manifest value → nil RawMessage on encode → JSON `null` on
	// the wire. On *decode* into RawMessage, a JSON null becomes the
	// 4-byte literal []byte("null") (not nil), so we assert on that.
	// The wire-shape pin lives in TestDatasets_V4_DefaultFiltersWireShape.
	require.Equal(t, "null", string(cc.DefaultFilters))
	// DM-5 / real-data shape: callingcards has no experimental-condition column,
	// so condition_cols is empty. (harbison is the binding dataset that carries
	// a real `condition`.)
	require.Empty(t, cc.ConditionCols)

	hk, ok := byName["hackett"]
	require.True(t, ok)
	require.True(t, hk.DefaultActive)
	// DefaultFilters is now a JSON object on the wire — assert by
	// unmarshalling instead of byte-comparing so whitespace from the
	// upstream artifact doesn't fragilize the test.
	require.NotNil(t, hk.DefaultFilters)
	var parsed map[string]any
	require.NoError(t, json.Unmarshal(hk.DefaultFilters, &parsed))
	require.Equal(t, map[string]any{
		"time": map[string]any{
			"type":  "numeric",
			"value": []any{float64(45), float64(45)},
		},
	}, parsed)
	// DM-1: hackett condition_cols is derived to just `time`.
	require.Equal(t, []string{"time"}, hk.ConditionCols)

	// v5: datasets endpoint surfaces upstreamCols (cascade) + description (DM-2).
	require.Equal(t, "Synthetic calling-cards fixture dataset.", cc.Description)
	require.Equal(t, []string{}, cc.UpstreamCols)
}

// TestDatasets_V4_DefaultFiltersWireShape pins the exact JSON shape
// (object, not string) so a regression to the v3 double-encoded form
// trips the test. The reviewer's IMPORTANT 1 finding was exactly this:
// the v4 commit emitted `"defaultFilters": "{...}"` (string) instead of
// `"defaultFilters": {...}` (object).
func TestDatasets_V4_DefaultFiltersWireShape(t *testing.T) {
	s := newTestServer(t)
	rr := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/v/"+s.Manifests.Artifact.ArtifactVersion+"/datasets", nil)
	s.Routes().ServeHTTP(rr, req)
	require.Equal(t, 200, rr.Code, rr.Body.String())

	// Decode as a loose tree so we can assert the *type* of the leaf.
	var tree map[string]any
	require.NoError(t, json.Unmarshal(rr.Body.Bytes(), &tree))
	dsRaw, ok := tree["datasets"].([]any)
	require.True(t, ok)
	for _, raw := range dsRaw {
		obj := raw.(map[string]any)
		if obj["dbName"] == "hackett" {
			df := obj["defaultFilters"]
			// Must be a JSON object (map after decode), NOT a string.
			_, isMap := df.(map[string]any)
			require.True(t, isMap, "defaultFilters must be a JSON object, got %T (%v)", df, df)
		}
		if obj["dbName"] == "callingcards" {
			// Must be null on the wire — Go decodes JSON null to nil.
			require.Nil(t, obj["defaultFilters"], "empty manifest → null, got %v", obj["defaultFilters"])
		}
	}
}
