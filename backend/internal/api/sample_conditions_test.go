package api

import (
	"encoding/json"
	"net/http/httptest"
	"testing"

	"github.com/BrentLab/tfbpshiny-go/backend/internal/domain"
	"github.com/stretchr/testify/require"
)

// hackett.condition_cols = "mechanism,restriction,time" in the fixture
// dataset_manifest; the meta row for sample_id="h_0" is (ZEV, P, 45).
// Expected label = "ZEV / P / 45".
func TestSampleConditions_Hackett_BuildsLabel(t *testing.T) {
	s := newTestServer(t)
	rr := httptest.NewRecorder()
	url := "/api/v/" + s.Manifests.Artifact.ArtifactVersion + "/datasets/hackett/sample-conditions"
	req := httptest.NewRequest("GET", url, nil)
	s.Routes().ServeHTTP(rr, req)
	require.Equal(t, 200, rr.Code, rr.Body.String())

	var resp domain.SampleConditionsResponse
	require.NoError(t, json.Unmarshal(rr.Body.Bytes(), &resp))
	require.Equal(t, "hackett", resp.DBName)
	require.Equal(t, []string{"mechanism", "restriction", "time"}, resp.ConditionCols)
	require.Equal(t, "ZEV / P / 45", resp.Labels["h_0"])
}

// callingcards.condition_cols = "condition" in the fixture; the meta
// table populates `condition` per sample. Just assert the shape — the
// handler must return non-empty Labels and ConditionCols=["condition"].
func TestSampleConditions_Callingcards_HasSingleCondCol(t *testing.T) {
	s := newTestServer(t)
	rr := httptest.NewRecorder()
	url := "/api/v/" + s.Manifests.Artifact.ArtifactVersion + "/datasets/callingcards/sample-conditions"
	req := httptest.NewRequest("GET", url, nil)
	s.Routes().ServeHTTP(rr, req)
	require.Equal(t, 200, rr.Code, rr.Body.String())

	var resp domain.SampleConditionsResponse
	require.NoError(t, json.Unmarshal(rr.Body.Bytes(), &resp))
	require.Equal(t, "callingcards", resp.DBName)
	require.Equal(t, []string{"condition"}, resp.ConditionCols)
	// Every non-empty `condition` value should produce a single-token
	// label (no " / " separator since there's only one column).
	for sid, label := range resp.Labels {
		require.NotEmpty(t, sid)
		require.NotEmpty(t, label)
		require.NotContains(t, label, " / ")
	}
}

// Unknown dataset must 400 before any SQL runs (Whitelist.CheckDataset
// gate). Defense-in-depth: the SafeIdentRE tripwire would also catch
// junk like "foo;drop", but CheckDataset is the first filter.
func TestSampleConditions_UnknownDataset_400(t *testing.T) {
	s := newTestServer(t)
	rr := httptest.NewRecorder()
	url := "/api/v/" + s.Manifests.Artifact.ArtifactVersion + "/datasets/no_such_db/sample-conditions"
	req := httptest.NewRequest("GET", url, nil)
	s.Routes().ServeHTTP(rr, req)
	require.Equal(t, 400, rr.Code)
}

// Second request to the same path must come from cache (X-Cache: HIT).
func TestSampleConditions_CachesByPath(t *testing.T) {
	s := newTestServer(t)
	url := "/api/v/" + s.Manifests.Artifact.ArtifactVersion + "/datasets/hackett/sample-conditions"

	rr1 := httptest.NewRecorder()
	s.Routes().ServeHTTP(rr1, httptest.NewRequest("GET", url, nil))
	require.Equal(t, 200, rr1.Code)
	require.Equal(t, "MISS", rr1.Header().Get("X-Cache"))

	// GetOrLoad internally calls store.Wait() after Set so the second
	// request sees the entry without an explicit barrier here.

	rr2 := httptest.NewRecorder()
	s.Routes().ServeHTTP(rr2, httptest.NewRequest("GET", url, nil))
	require.Equal(t, 200, rr2.Code)
	require.Equal(t, "HIT", rr2.Header().Get("X-Cache"))
}
