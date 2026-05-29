package api

import (
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// fixture exposes datasets `callingcards` (binding) and `hackett` (perturbation),
// both with `*_meta` tables containing `regulator_locus_tag`.

func TestRegulatorsResolve_Intersect(t *testing.T) {
	s := newTestServer(t)
	q := url.Values{"intersect": []string{"callingcards,hackett"}}
	rr := httptest.NewRecorder()
	req := httptest.NewRequest("GET",
		"/api/v/"+s.Manifests.Artifact.ArtifactVersion+"/regulators/resolve?"+q.Encode(), nil)
	s.Routes().ServeHTTP(rr, req)
	require.Equal(t, 200, rr.Code, "body=%s", rr.Body.String())
	require.Contains(t, rr.Body.String(), `"regulators":[`)

	var resp resolveResponse
	require.NoError(t, json.Unmarshal(rr.Body.Bytes(), &resp))
	require.False(t, resp.Truncated)
	// The fixture has 3 shared regulators across both datasets.
	require.NotEmpty(t, resp.Regulators)
}

// SD-1: the resolve must be filter-aware so the modal's common set matches the
// filter-aware matrix cell. Filtering callingcards to condition=SC keeps only
// cc_extra (regulator YBR289W), so the callingcards∩hackett common set narrows
// from all 3 shared regulators to just YBR289W.
func TestRegulatorsResolve_FilterAware(t *testing.T) {
	s := newTestServer(t)

	doResolve := func(filters string) []string {
		q := url.Values{"intersect": []string{"callingcards,hackett"}}
		if filters != "" {
			q.Set("filters", filters)
		}
		rr := httptest.NewRecorder()
		req := httptest.NewRequest("GET",
			"/api/v/"+s.Manifests.Artifact.ArtifactVersion+"/regulators/resolve?"+q.Encode(), nil)
		s.Routes().ServeHTTP(rr, req)
		require.Equal(t, 200, rr.Code, "body=%s", rr.Body.String())
		var resp resolveResponse
		require.NoError(t, json.Unmarshal(rr.Body.Bytes(), &resp))
		return resp.Regulators
	}

	unfiltered := doResolve("")
	require.ElementsMatch(t, []string{"YBR289W", "YML007W", "YGL073W"}, unfiltered)

	filtered := doResolve(`{"callingcards":{"condition":{"type":"categorical","value":["SC"]}}}`)
	require.Equal(t, []string{"YBR289W"}, filtered,
		"condition=SC keeps only cc_extra (YBR289W); the common set must narrow")

	// A regulator_locus_tag filter must be STRIPPED (computing the regulator
	// set — applying it would be circular), so it behaves like no filter.
	stripped := doResolve(`{"callingcards":{"regulator_locus_tag":{"type":"categorical","value":["YML007W"]}}}`)
	require.ElementsMatch(t, unfiltered, stripped)
}

func TestRegulatorsResolve_BadDataset(t *testing.T) {
	s := newTestServer(t)
	q := url.Values{"intersect": []string{"not_a_dataset"}}
	rr := httptest.NewRecorder()
	req := httptest.NewRequest("GET",
		"/api/v/"+s.Manifests.Artifact.ArtifactVersion+"/regulators/resolve?"+q.Encode(), nil)
	s.Routes().ServeHTTP(rr, req)
	require.Equal(t, 400, rr.Code)
	require.Contains(t, rr.Body.String(), "unknown dataset")
}

func TestRegulatorsResolve_TooManyExplicit(t *testing.T) {
	s := newTestServer(t)
	// Use distinct tags to avoid dedup hiding the cap (handler caps on raw split count).
	distinct := make([]string, 0, 31)
	for i := 0; i < 31; i++ {
		distinct = append(distinct, fmt.Sprintf("YBR%03dW", i))
	}
	q := url.Values{"regulators": []string{strings.Join(distinct, ",")}}
	rr := httptest.NewRecorder()
	req := httptest.NewRequest("GET",
		"/api/v/"+s.Manifests.Artifact.ArtifactVersion+"/regulators/resolve?"+q.Encode(), nil)
	s.Routes().ServeHTTP(rr, req)
	require.Equal(t, 400, rr.Code, "body=%s", rr.Body.String())
	require.Contains(t, rr.Body.String(), "regulators")
}

func TestRegulatorsResolve_CommonAlias(t *testing.T) {
	s := newTestServer(t)

	q1 := url.Values{"intersect": []string{"callingcards,hackett"}}
	rr1 := httptest.NewRecorder()
	req1 := httptest.NewRequest("GET",
		"/api/v/"+s.Manifests.Artifact.ArtifactVersion+"/regulators/resolve?"+q1.Encode(), nil)
	s.Routes().ServeHTTP(rr1, req1)
	require.Equal(t, 200, rr1.Code)
	var resp1 resolveResponse
	require.NoError(t, json.Unmarshal(rr1.Body.Bytes(), &resp1))

	q2 := url.Values{"common": []string{"binding.callingcards:perturbation.hackett"}}
	rr2 := httptest.NewRecorder()
	req2 := httptest.NewRequest("GET",
		"/api/v/"+s.Manifests.Artifact.ArtifactVersion+"/regulators/resolve?"+q2.Encode(), nil)
	s.Routes().ServeHTTP(rr2, req2)
	require.Equal(t, 200, rr2.Code, "body=%s", rr2.Body.String())
	var resp2 resolveResponse
	require.NoError(t, json.Unmarshal(rr2.Body.Bytes(), &resp2))

	require.Equal(t, resp1.Regulators, resp2.Regulators)
	require.Equal(t, resp1.Truncated, resp2.Truncated)
}

// TestRegulatorsResolve_ExplicitOnly verifies that the explicit `regulators=`
// list is case-normalized to upper case and deduplicated, and that the
// response is sorted.
func TestRegulatorsResolve_ExplicitOnly(t *testing.T) {
	s := newTestServer(t)
	q := url.Values{"regulators": []string{"ybr289w,YBR289W,YML007W"}}
	rr := httptest.NewRecorder()
	req := httptest.NewRequest("GET",
		"/api/v/"+s.Manifests.Artifact.ArtifactVersion+"/regulators/resolve?"+q.Encode(), nil)
	s.Routes().ServeHTTP(rr, req)
	require.Equal(t, 200, rr.Code, "body=%s", rr.Body.String())

	var resp resolveResponse
	require.NoError(t, json.Unmarshal(rr.Body.Bytes(), &resp))
	require.False(t, resp.Truncated)
	// Case-normalized + deduped: YBR289W once, YML007W once.
	require.Equal(t, []string{"YBR289W", "YML007W"}, resp.Regulators)
}

// TestRegulatorsResolve_IntersectAndExplicit verifies that combining
// intersect with an explicit list returns the intersection (keeping only
// explicit tags that exist in the intersection).
func TestRegulatorsResolve_IntersectAndExplicit(t *testing.T) {
	s := newTestServer(t)
	// YBR289W is in the callingcards INTERSECT hackett result (see Intersect test).
	q := url.Values{
		"intersect":  []string{"callingcards,hackett"},
		"regulators": []string{"YBR289W,FAKE_TAG"},
	}
	rr := httptest.NewRecorder()
	req := httptest.NewRequest("GET",
		"/api/v/"+s.Manifests.Artifact.ArtifactVersion+"/regulators/resolve?"+q.Encode(), nil)
	s.Routes().ServeHTTP(rr, req)
	require.Equal(t, 200, rr.Code, "body=%s", rr.Body.String())

	var resp resolveResponse
	require.NoError(t, json.Unmarshal(rr.Body.Bytes(), &resp))
	require.Contains(t, resp.Regulators, "YBR289W")
	require.NotContains(t, resp.Regulators, "FAKE_TAG")
}

// TestRegulatorsResolve_BadPrefix verifies that aliases other than
// `binding.` / `perturbation.` are rejected with 400.
func TestRegulatorsResolve_BadPrefix(t *testing.T) {
	s := newTestServer(t)
	q := url.Values{"common": []string{"foo.callingcards:bar.hackett"}}
	rr := httptest.NewRecorder()
	req := httptest.NewRequest("GET",
		"/api/v/"+s.Manifests.Artifact.ArtifactVersion+"/regulators/resolve?"+q.Encode(), nil)
	s.Routes().ServeHTTP(rr, req)
	require.Equal(t, 400, rr.Code, "body=%s", rr.Body.String())
	require.Contains(t, rr.Body.String(), "unknown dataset prefix")
}

// TestRegulatorsResolve_OrderInvariantCacheKey verifies that
// `?intersect=A,B` and `?intersect=B,A` produce byte-identical response
// bodies (the canonical cache key collapses the two requests).
func TestRegulatorsResolve_OrderInvariantCacheKey(t *testing.T) {
	s := newTestServer(t)

	q1 := url.Values{"intersect": []string{"callingcards,hackett"}}
	rr1 := httptest.NewRecorder()
	req1 := httptest.NewRequest("GET",
		"/api/v/"+s.Manifests.Artifact.ArtifactVersion+"/regulators/resolve?"+q1.Encode(), nil)
	s.Routes().ServeHTTP(rr1, req1)
	require.Equal(t, 200, rr1.Code)

	q2 := url.Values{"intersect": []string{"hackett,callingcards"}}
	rr2 := httptest.NewRecorder()
	req2 := httptest.NewRequest("GET",
		"/api/v/"+s.Manifests.Artifact.ArtifactVersion+"/regulators/resolve?"+q2.Encode(), nil)
	s.Routes().ServeHTTP(rr2, req2)
	require.Equal(t, 200, rr2.Code)

	require.Equal(t, rr1.Body.Bytes(), rr2.Body.Bytes())
}

// TestRegulatorsResolve_CommonAndIntersectSameKey verifies that
// `?common=A:B` and `?intersect=A,B` produce byte-identical response bodies.
func TestRegulatorsResolve_CommonAndIntersectSameKey(t *testing.T) {
	s := newTestServer(t)

	q1 := url.Values{"intersect": []string{"callingcards,hackett"}}
	rr1 := httptest.NewRecorder()
	req1 := httptest.NewRequest("GET",
		"/api/v/"+s.Manifests.Artifact.ArtifactVersion+"/regulators/resolve?"+q1.Encode(), nil)
	s.Routes().ServeHTTP(rr1, req1)
	require.Equal(t, 200, rr1.Code)

	q2 := url.Values{"common": []string{"callingcards:hackett"}}
	rr2 := httptest.NewRecorder()
	req2 := httptest.NewRequest("GET",
		"/api/v/"+s.Manifests.Artifact.ArtifactVersion+"/regulators/resolve?"+q2.Encode(), nil)
	s.Routes().ServeHTTP(rr2, req2)
	require.Equal(t, 200, rr2.Code)

	require.Equal(t, rr1.Body.Bytes(), rr2.Body.Bytes())
}

// TestRegulatorsResolve_PrefixDataTypeMismatch verifies that a prefix
// mismatch (binding.<perturbation-dataset>) is rejected with 400 rather
// than silently re-mapped.
func TestRegulatorsResolve_PrefixDataTypeMismatch(t *testing.T) {
	s := newTestServer(t)
	q := url.Values{"intersect": []string{"binding.hackett"}}
	rr := httptest.NewRecorder()
	req := httptest.NewRequest("GET",
		"/api/v/"+s.Manifests.Artifact.ArtifactVersion+"/regulators/resolve?"+q.Encode(), nil)
	s.Routes().ServeHTTP(rr, req)
	require.Equal(t, 400, rr.Code, "body=%s", rr.Body.String())
	require.Contains(t, rr.Body.String(), "does not match dataset")
}

// TestRegulatorsResolve_DatasetCountCap verifies that more datasets than
// the manifest contains is rejected with 400 by the dedupe+cap step
// (mirrors binding/perturbation DoS posture).
func TestRegulatorsResolve_DatasetCountCap(t *testing.T) {
	s := newTestServer(t)
	n := len(s.Whitelist.AllDatasets())
	names := make([]string, 0, n+1)
	for i := 0; i < n+1; i++ {
		names = append(names, fmt.Sprintf("ds_%d", i))
	}
	q := url.Values{"intersect": []string{strings.Join(names, ",")}}
	rr := httptest.NewRecorder()
	req := httptest.NewRequest("GET",
		"/api/v/"+s.Manifests.Artifact.ArtifactVersion+"/regulators/resolve?"+q.Encode(), nil)
	s.Routes().ServeHTTP(rr, req)
	require.Equal(t, 400, rr.Code, "body=%s", rr.Body.String())
	require.Contains(t, rr.Body.String(), "exceeds maximum")
}
