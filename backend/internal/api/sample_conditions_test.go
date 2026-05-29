package api

import (
	"encoding/json"
	"net/http/httptest"
	"testing"

	"github.com/BrentLab/tfbpshiny-go/backend/internal/domain"
	"github.com/stretchr/testify/require"
)

// DM-1: hackett.condition_cols is derived from EXPERIMENTAL_CONDITION_FIELDS,
// so the hidden mechanism/restriction columns are excluded — only `time`
// remains. The meta row for sample_id="h_0" is (…, time=45), so the hover
// label is "45", NOT the old buggy "ZEV / P / 45" (which leaked hidden fields).
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
	require.Equal(t, []string{"time"}, resp.ConditionCols)
	require.Equal(t, "45", resp.Labels["h_0"])
}

// Real-data regression: callingcards has NO experimental-condition column
// (its only condition-like meta columns are the space-containing display
// duplicates `Carbon source`/`Temperature`, which SafeIdentRE rejects). So
// condition_cols is empty and the handler must return 200 with empty Labels —
// NOT the previous 500 ("Column condition ... cannot be referenced before it
// is defined") from a phantom condition col the manifest used to claim.
func TestSampleConditions_Callingcards_NoCondCol_Graceful(t *testing.T) {
	s := newTestServer(t)
	rr := httptest.NewRecorder()
	url := "/api/v/" + s.Manifests.Artifact.ArtifactVersion + "/datasets/callingcards/sample-conditions"
	req := httptest.NewRequest("GET", url, nil)
	s.Routes().ServeHTTP(rr, req)
	require.Equal(t, 200, rr.Code, rr.Body.String())

	var resp domain.SampleConditionsResponse
	require.NoError(t, json.Unmarshal(rr.Body.Bytes(), &resp))
	require.Equal(t, "callingcards", resp.DBName)
	require.Empty(t, resp.ConditionCols, "callingcards has no condition column")
	require.Empty(t, resp.Labels, "no condition column → no hover labels")
}

// harbison genuinely has a `condition` column, so its sample-conditions map is
// non-empty and each label is a single token (one condition col). hb_extra
// carries condition="SC"; the rest are "YPD".
func TestSampleConditions_Harbison_HasSingleCondCol(t *testing.T) {
	s := newTestServer(t)
	rr := httptest.NewRecorder()
	url := "/api/v/" + s.Manifests.Artifact.ArtifactVersion + "/datasets/harbison/sample-conditions"
	req := httptest.NewRequest("GET", url, nil)
	s.Routes().ServeHTTP(rr, req)
	require.Equal(t, 200, rr.Code, rr.Body.String())

	var resp domain.SampleConditionsResponse
	require.NoError(t, json.Unmarshal(rr.Body.Bytes(), &resp))
	require.Equal(t, "harbison", resp.DBName)
	require.Equal(t, []string{"condition"}, resp.ConditionCols)
	require.NotEmpty(t, resp.Labels)
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
