package api

import (
	"encoding/json"
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
	tags := make([]string, 0, 31)
	for i := 0; i < 31; i++ {
		tags = append(tags, "YBR000W")
	}
	// Use distinct tags to avoid dedup hiding the cap (handler caps on raw split count).
	distinct := make([]string, 0, 31)
	for i := 0; i < 31; i++ {
		distinct = append(distinct, "YBR"+padLeft(i, 3)+"W")
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

// padLeft renders n as a base-10 string left-padded with zeros to width.
func padLeft(n, width int) string {
	s := ""
	if n == 0 {
		s = "0"
	}
	for n > 0 {
		s = string(rune('0'+(n%10))) + s
		n /= 10
	}
	for len(s) < width {
		s = "0" + s
	}
	return s
}
