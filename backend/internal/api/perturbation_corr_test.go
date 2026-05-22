package api

// Symmetric tests for /api/v/{v}/perturbation/correlations and
// /perturbation/scatter. The fixture has exactly one perturbation
// dataset (hackett), so the same caveats from binding_corr_test apply
// — full multi-dataset numerical parity lives in the SQL-level
// correlation_parity_test.go.

import (
	"encoding/json"
	"net/http/httptest"
	"net/url"
	"testing"

	"github.com/BrentLab/tfbpshiny-go/backend/internal/domain"
	"github.com/stretchr/testify/require"
)

func pertCorrPath(s *Server) string {
	return "/api/v/" + s.Manifests.Artifact.ArtifactVersion + "/perturbation/correlations"
}

func pertScatterPath(s *Server) string {
	return "/api/v/" + s.Manifests.Artifact.ArtifactVersion + "/perturbation/scatter"
}

func TestPerturbationCorrelations_RejectsBindingDataset(t *testing.T) {
	s := newTestServer(t)
	q := url.Values{
		"datasets": []string{"hackett,callingcards"},
		"method":   []string{"pearson"},
		"col":      []string{"effect"},
	}
	rr := httptest.NewRecorder()
	req := httptest.NewRequest("GET", pertCorrPath(s)+"?"+q.Encode(), nil)
	s.Routes().ServeHTTP(rr, req)
	require.Equal(t, 400, rr.Code)
	require.Contains(t, rr.Body.String(), "not perturbation")
}

func TestPerturbationCorrelations_RejectsLessThanTwoDatasets(t *testing.T) {
	s := newTestServer(t)
	q := url.Values{
		"datasets": []string{"hackett"},
		"method":   []string{"spearman"},
		"col":      []string{"effect"},
	}
	rr := httptest.NewRecorder()
	req := httptest.NewRequest("GET", pertCorrPath(s)+"?"+q.Encode(), nil)
	s.Routes().ServeHTTP(rr, req)
	require.Equal(t, 400, rr.Code)
}

func TestPerturbationCorrelations_RejectsUnknownMethod(t *testing.T) {
	s := newTestServer(t)
	q := url.Values{
		"datasets": []string{"hackett,hackett"},
		"method":   []string{"bogus"},
		"col":      []string{"effect"},
	}
	rr := httptest.NewRecorder()
	req := httptest.NewRequest("GET", pertCorrPath(s)+"?"+q.Encode(), nil)
	s.Routes().ServeHTTP(rr, req)
	require.Equal(t, 400, rr.Code)
}

func TestPerturbationScatter_RejectsBindingInPair(t *testing.T) {
	s := newTestServer(t)
	q := url.Values{
		"regulator": []string{"YBR289W"},
		"pair":      []string{"hackett,callingcards"},
		"method":    []string{"pearson"},
		"col":       []string{"effect"},
	}
	rr := httptest.NewRecorder()
	req := httptest.NewRequest("GET", pertScatterPath(s)+"?"+q.Encode(), nil)
	s.Routes().ServeHTTP(rr, req)
	require.Equal(t, 400, rr.Code)
	require.Contains(t, rr.Body.String(), "not perturbation")
}

// Self-pair (hackett × hackett) happy path. As with the binding side, this
// renders the full template + JSON path against the fixture without
// requiring a second perturbation dataset.
func TestPerturbationScatter_HappyPath_SelfPair(t *testing.T) {
	s := newTestServer(t)
	q := url.Values{
		"regulator": []string{"YBR289W"},
		"pair":      []string{"hackett,hackett"},
		"method":    []string{"spearman"},
		"col":       []string{"effect"},
	}
	rr := httptest.NewRecorder()
	req := httptest.NewRequest("GET", pertScatterPath(s)+"?"+q.Encode(), nil)
	s.Routes().ServeHTTP(rr, req)
	require.Equal(t, 200, rr.Code, rr.Body.String())

	var resp domain.ScatterResponse
	require.NoError(t, json.Unmarshal(rr.Body.Bytes(), &resp))
	require.Equal(t, "spearman", resp.Method)
	require.Equal(t, "hackett", resp.DBA)
	require.Equal(t, "hackett", resp.DBB)
	// hackett has exactly one sample per regulator → INNER JOIN on
	// target yields one row per shared target with val_a == val_b
	// (same row both sides) → Pearson on ranks = 1.0 exactly.
	require.NotEmpty(t, resp.Points)
	require.InDelta(t, 1.0, resp.R, 1e-9,
		"hackett self-pair (1 sample/reg) → val_a==val_b → r=1")
}

// Regulator-filter strip: include `regulator_locus_tag` in the filters
// JSON for a scatter request and confirm the response is identical to
// the same request with that filter omitted. This proves the strip
// happens — without it, the inner subquery would emit
// `WHERE regulator = ? AND regulator IN (...)` which would prune all
// rows when the IN-list disagrees with the bound regulator (and on the
// self-pair fixture, any non-empty IN list either matches everything or
// nothing, so the rowcounts MUST match the unfiltered request to prove
// the strip was applied).
func TestPerturbationScatter_StripsRegulatorFromFilters(t *testing.T) {
	s := newTestServer(t)
	base := url.Values{
		"regulator": []string{"YBR289W"},
		"pair":      []string{"hackett,hackett"},
		"method":    []string{"pearson"},
		"col":       []string{"effect"},
	}
	rrBase := httptest.NewRecorder()
	reqBase := httptest.NewRequest("GET", pertScatterPath(s)+"?"+base.Encode(), nil)
	s.Routes().ServeHTTP(rrBase, reqBase)
	require.Equal(t, 200, rrBase.Code, rrBase.Body.String())

	withReg := url.Values{}
	for k, v := range base {
		withReg[k] = v
	}
	// Pass a regulator_locus_tag filter that, if NOT stripped, would
	// short-circuit no rows (a regulator that isn't YBR289W).
	withReg.Set("filters", `{"hackett":{"regulator_locus_tag":{"type":"categorical","value":["YOL051W"]}}}`)
	rrFiltered := httptest.NewRecorder()
	reqFiltered := httptest.NewRequest("GET", pertScatterPath(s)+"?"+withReg.Encode(), nil)
	s.Routes().ServeHTTP(rrFiltered, reqFiltered)
	require.Equal(t, 200, rrFiltered.Code, rrFiltered.Body.String())

	// Parse both and compare row counts — if the strip works, both
	// responses see the same N rows for regulator=YBR289W. If the strip
	// were missing, the filtered response would see 0 rows because the
	// regulator_locus_tag IN-list excludes YBR289W.
	var base0, filt domain.ScatterResponse
	require.NoError(t, json.Unmarshal(rrBase.Body.Bytes(), &base0))
	require.NoError(t, json.Unmarshal(rrFiltered.Body.Bytes(), &filt))
	require.Equal(t, len(base0.Points), len(filt.Points),
		"regulator_locus_tag filter MUST be stripped before binding (Shiny workspace.py:536-540)")
	require.NotEmpty(t, base0.Points, "fixture should have rows for YBR289W")
}
