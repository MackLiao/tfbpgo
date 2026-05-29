package api

// Tests for /api/v/{v}/binding/corr and /binding/scatter.
//
// The committed fixture has exactly ONE binding dataset (callingcards) and
// ONE perturbation dataset (hackett), so a multi-dataset binding happy
// path cannot be exercised here — that coverage lives in the SQL-level
// numerical-parity tests at
// backend/internal/queries/correlation_parity_test.go (Task A2), which
// run the templates directly against the same fixture.
//
// These handler tests focus on the validation surface, the regulator-
// filter strip, and cache-key canonicalization.

import (
	"encoding/json"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/BrentLab/tfbpshiny-go/backend/internal/domain"
	"github.com/stretchr/testify/require"
)

func corrPath(s *Server) string {
	return "/api/v/" + s.Manifests.Artifact.ArtifactVersion + "/binding/corr"
}

func scatterPath(s *Server) string {
	return "/api/v/" + s.Manifests.Artifact.ArtifactVersion + "/binding/scatter"
}

func doGET(t *testing.T, s *Server, path string, q url.Values) *httptest.ResponseRecorder {
	t.Helper()
	rr := httptest.NewRecorder()
	req := httptest.NewRequest("GET", path+"?"+q.Encode(), nil)
	s.Routes().ServeHTTP(rr, req)
	return rr
}

// B-1 parity: the scatter path keeps NULL/NaN/±Inf targets (no SQL finite
// filter). harbison.effect carries an IEEE-NaN cell at (YBR289W, YAL001C), so a
// callingcards×harbison Pearson scatter on YBR289W must (a) NOT 500 on the NaN
// (it serializes as JSON null via SafeFloat), and (b) actually include a null
// valB point — a row the OLD filtered SQL would have dropped.
func TestBindingScatter_KeepsNonFiniteAsNull(t *testing.T) {
	s := newTestServer(t)
	q := url.Values{
		"regulator": []string{"YBR289W"},
		"method":    []string{"pearson"},
		"col":       []string{"effect"},
		"pair":      []string{"callingcards,harbison"},
	}
	rr := doGET(t, s, scatterPath(s), q)
	require.Equalf(t, 200, rr.Code, "NaN scatter must serialize as null, not 500; body=%s", rr.Body.String())

	var resp struct {
		R      json.RawMessage `json:"r"`
		Points []struct {
			ValA json.RawMessage `json:"valA"`
			ValB json.RawMessage `json:"valB"`
		} `json:"points"`
	}
	require.NoError(t, json.Unmarshal(rr.Body.Bytes(), &resp))
	require.NotEmpty(t, resp.Points)
	nullValB := 0
	for _, p := range resp.Points {
		if string(p.ValB) == "null" {
			nullValB++
		}
	}
	require.GreaterOrEqual(t, nullValB, 1,
		"the harbison NaN effect cell must appear as a null valB point, not be filtered out")
}

// ---------- /binding/corr validation ----------

func TestBindingCorr_RejectsMissingMethod(t *testing.T) {
	s := newTestServer(t)
	q := url.Values{"datasets": []string{"callingcards,callingcards"}, "col": []string{"effect"}}
	rr := doGET(t, s, corrPath(s), q)
	require.Equal(t, 400, rr.Code)
	require.Contains(t, rr.Body.String(), "method")
}

func TestBindingCorr_RejectsUnknownMethod(t *testing.T) {
	s := newTestServer(t)
	q := url.Values{
		"datasets": []string{"callingcards,callingcards"},
		"method":   []string{"kendall"},
		"col":      []string{"effect"},
	}
	rr := doGET(t, s, corrPath(s), q)
	require.Equal(t, 400, rr.Code)
	require.Contains(t, rr.Body.String(), "kendall")
}

func TestBindingCorr_RejectsMissingCol(t *testing.T) {
	s := newTestServer(t)
	q := url.Values{
		"datasets": []string{"callingcards,callingcards"},
		"method":   []string{"pearson"},
	}
	rr := doGET(t, s, corrPath(s), q)
	require.Equal(t, 400, rr.Code)
	require.Contains(t, rr.Body.String(), "col")
}

func TestBindingCorr_RejectsUnknownCol(t *testing.T) {
	s := newTestServer(t)
	q := url.Values{
		"datasets": []string{"callingcards,callingcards"},
		"method":   []string{"pearson"},
		"col":      []string{"weird"},
	}
	rr := doGET(t, s, corrPath(s), q)
	require.Equal(t, 400, rr.Code)
	require.Contains(t, rr.Body.String(), "weird")
}

func TestBindingCorr_RejectsLessThanTwoDatasets(t *testing.T) {
	s := newTestServer(t)
	q := url.Values{
		"datasets": []string{"callingcards"},
		"method":   []string{"pearson"},
		"col":      []string{"effect"},
	}
	rr := doGET(t, s, corrPath(s), q)
	require.Equal(t, 400, rr.Code)
	require.Contains(t, rr.Body.String(), "at least 2")
}

func TestBindingCorr_RejectsPerturbationDataset(t *testing.T) {
	s := newTestServer(t)
	// hackett is perturbation in the fixture.
	q := url.Values{
		"datasets": []string{"callingcards,hackett"},
		"method":   []string{"pearson"},
		"col":      []string{"effect"},
	}
	rr := doGET(t, s, corrPath(s), q)
	require.Equal(t, 400, rr.Code)
	require.Contains(t, rr.Body.String(), "hackett")
	require.Contains(t, rr.Body.String(), "not binding")
}

func TestBindingCorr_RejectsUnknownDataset(t *testing.T) {
	s := newTestServer(t)
	q := url.Values{
		"datasets": []string{"callingcards,never_heard_of_it"},
		"method":   []string{"pearson"},
		"col":      []string{"effect"},
	}
	rr := doGET(t, s, corrPath(s), q)
	require.Equal(t, 400, rr.Code)
}

// Invalid filter JSON on the scatter endpoint (which accepts the same
// `filters=` shape as /corr) — uses hackett,hackett self-pair on the
// perturbation side... but since this is the binding-side test file,
// stage it on the binding scatter handler with a callingcards self-pair.
func TestBindingScatter_RejectsInvalidFilterJSON(t *testing.T) {
	s := newTestServer(t)
	q := url.Values{
		"regulator": []string{"YBR289W"},
		"pair":      []string{"callingcards,callingcards"},
		"method":    []string{"pearson"},
		"col":       []string{"effect"},
		"filters":   []string{"{not-json}"},
	}
	rr := doGET(t, s, scatterPath(s), q)
	require.Equal(t, 400, rr.Code)
	require.Contains(t, rr.Body.String(), "filters")
}

// ---------- /binding/scatter validation ----------

func TestBindingScatter_RejectsMissingRegulator(t *testing.T) {
	s := newTestServer(t)
	q := url.Values{
		"pair":   []string{"callingcards,callingcards"},
		"method": []string{"pearson"},
		"col":    []string{"effect"},
	}
	rr := doGET(t, s, scatterPath(s), q)
	require.Equal(t, 400, rr.Code)
	require.Contains(t, rr.Body.String(), "regulator")
}

func TestBindingScatter_RejectsPairWithOneEntry(t *testing.T) {
	s := newTestServer(t)
	q := url.Values{
		"regulator": []string{"YBR289W"},
		"pair":      []string{"callingcards"},
		"method":    []string{"pearson"},
		"col":       []string{"effect"},
	}
	rr := doGET(t, s, scatterPath(s), q)
	require.Equal(t, 400, rr.Code)
	require.Contains(t, rr.Body.String(), "exactly 2")
}

func TestBindingScatter_RejectsPairWithThreeEntries(t *testing.T) {
	s := newTestServer(t)
	q := url.Values{
		"regulator": []string{"YBR289W"},
		"pair":      []string{"callingcards,callingcards,callingcards"},
		"method":    []string{"pearson"},
		"col":       []string{"effect"},
	}
	// dedupeAndCapCSV collapses duplicates, so pass three different names
	// to exercise the >2 branch.
	q.Set("pair", "callingcards,hackett,unknown")
	rr := doGET(t, s, scatterPath(s), q)
	require.Equal(t, 400, rr.Code)
}

func TestBindingScatter_RejectsPerturbationDatasetInPair(t *testing.T) {
	s := newTestServer(t)
	q := url.Values{
		"regulator": []string{"YBR289W"},
		"pair":      []string{"callingcards,hackett"},
		"method":    []string{"pearson"},
		"col":       []string{"effect"},
	}
	rr := doGET(t, s, scatterPath(s), q)
	require.Equal(t, 400, rr.Code)
	require.Contains(t, rr.Body.String(), "not binding")
}

func TestBindingScatter_RejectsUnknownMethod(t *testing.T) {
	s := newTestServer(t)
	q := url.Values{
		"regulator": []string{"YBR289W"},
		"pair":      []string{"callingcards,callingcards"},
		"method":    []string{"kendall"},
		"col":       []string{"effect"},
	}
	rr := doGET(t, s, scatterPath(s), q)
	require.Equal(t, 400, rr.Code)
}

// ---------- /binding/scatter happy path (single-dataset self-pair) ----------

// Self-pair (callingcards × callingcards) is a degenerate but valid input:
// the SQL renders, the rows are perfectly correlated by construction, and
// it exercises the full handler+SQL+JSON path without requiring a second
// binding dataset in the fixture.
func TestBindingScatter_HappyPath_SelfPair(t *testing.T) {
	s := newTestServer(t)
	q := url.Values{
		"regulator": []string{"YBR289W"},
		"pair":      []string{"callingcards,callingcards"},
		"method":    []string{"pearson"},
		"col":       []string{"effect"},
	}
	rr := doGET(t, s, scatterPath(s), q)
	require.Equal(t, 200, rr.Code, rr.Body.String())
	require.Equal(t, "application/json", rr.Header().Get("Content-Type"))

	var resp domain.ScatterResponse
	require.NoError(t, json.Unmarshal(rr.Body.Bytes(), &resp))
	require.Equal(t, "pearson", resp.Method)
	require.Equal(t, "callingcards", resp.DBA)
	require.Equal(t, "callingcards", resp.DBB)
	require.NotEmpty(t, resp.Points)
	// callingcards self-pair INNER JOIN on target produces a CROSS over
	// the 2 cc samples on each side: each target appears 2×2=4 times with
	// the 4 (val_a, val_b) combinations of the two samples' values. So r
	// is NOT exactly 1.0 — it's the Pearson coefficient over those 4
	// permutations × 5 targets = 20 rows. Just sanity-check it's a
	// finite value within [-1, 1] and the rowcount matches.
	require.Equal(t, 20, len(resp.Points), "2 cc samples × 2 cc samples × 5 shared targets")
	require.GreaterOrEqual(t, resp.R, -1.0)
	require.LessOrEqual(t, resp.R, 1.0)
}

// ---------- Cache-key canonicalization ----------

// Issue the same logical /binding/scatter request with the query-param keys
// rearranged in the raw URL string. The second response must come from the
// cache because canonValues sorts/normalizes inputs into a cache key that is
// independent of the URL's surface ordering. We can't peek at server-side
// counters without plumbing, so we assert via the X-Cache response header
// set by writeCachedJSON.
func TestBindingScatter_CacheCanonicalization(t *testing.T) {
	s := newTestServer(t)
	path := scatterPath(s)

	// First request: one param ordering in the raw query string.
	raw1 := "regulator=YBR289W&pair=callingcards%2Ccallingcards&method=pearson&col=effect"
	rr1 := httptest.NewRecorder()
	req1 := httptest.NewRequest("GET", path+"?"+raw1, nil)
	s.Routes().ServeHTTP(rr1, req1)
	require.Equal(t, 200, rr1.Code, rr1.Body.String())
	require.Equal(t, "MISS", rr1.Header().Get("X-Cache"))

	// Second request: same logical params, permuted ordering and re-encoded
	// CSV value. The cache key is built from canonValues (allowlisted keys,
	// sorted []string values), not from the raw query string, so the second
	// must HIT despite the different surface form.
	raw2 := "col=effect&method=pearson&pair=callingcards,callingcards&regulator=YBR289W"
	rr2 := httptest.NewRecorder()
	req2 := httptest.NewRequest("GET", path+"?"+raw2, nil)
	s.Routes().ServeHTTP(rr2, req2)
	require.Equal(t, 200, rr2.Code, rr2.Body.String())
	require.Equal(t, "HIT", rr2.Header().Get("X-Cache"),
		"permuted-param request must hit the cache (canonicalization)")
	require.Equal(t, rr1.Body.String(), rr2.Body.String())

	// Sanity: ensure the two raw query strings actually differ — otherwise
	// we'd be testing the trivial identical-request HIT case.
	require.NotEqual(t, raw1, raw2,
		"raw query strings must differ; otherwise we aren't proving canonicalization")
}

// ---------- stripRegulatorFilter unit test ----------

func TestStripRegulatorFilter_RemovesKeyWhenPresent(t *testing.T) {
	in := map[string]domain.FilterSpec{
		"regulator_locus_tag": {Type: "categorical", Value: []byte(`["YBR289W"]`)},
		"sample_id":           {Type: "categorical", Value: []byte(`["cc_0_a"]`)},
	}
	out := stripRegulatorFilter(in)
	_, hasReg := out["regulator_locus_tag"]
	require.False(t, hasReg, "regulator_locus_tag should be stripped")
	_, hasSample := out["sample_id"]
	require.True(t, hasSample, "non-regulator fields must be preserved")
	// Original map must be untouched (callers iterate over filters later).
	_, origHasReg := in["regulator_locus_tag"]
	require.True(t, origHasReg, "stripRegulatorFilter must not mutate the input map")
}

func TestStripRegulatorFilter_NoopWhenKeyAbsent(t *testing.T) {
	in := map[string]domain.FilterSpec{
		"sample_id": {Type: "categorical", Value: []byte(`["cc_0_a"]`)},
	}
	out := stripRegulatorFilter(in)
	require.Len(t, out, 1)
	_, ok := out["sample_id"]
	require.True(t, ok)
}

func TestStripRegulatorFilter_NilSafe(t *testing.T) {
	require.Nil(t, stripRegulatorFilter(nil))
}

// ---------- isPValueCol unit test ----------

func TestIsPValueCol(t *testing.T) {
	cases := []struct {
		col  string
		want bool
	}{
		{"poisson_pval", true},
		{"pvalue", true},
		{"PVALUE", true},
		{"some_pvalue_col", true},
		{"callingcards_enrichment", false},
		{"log2_shrunken_timecourses", false},
		{"", false},
	}
	for _, c := range cases {
		got := isPValueCol(c.col)
		require.Equal(t, c.want, got, "isPValueCol(%q)", c.col)
	}
}

// ---------- orderExpr unit test ----------

func TestOrderExpr(t *testing.T) {
	// p-value cols → val_* ASC.
	require.Equal(t, "val_a ASC", orderExpr("a", "poisson_pval"))
	require.Equal(t, "val_b ASC", orderExpr("b", "pvalue"))
	// effect cols → ABS(val_*) DESC.
	require.Equal(t, "ABS(val_a) DESC", orderExpr("a", "callingcards_enrichment"))
	require.Equal(t, "ABS(val_b) DESC", orderExpr("b", "log2_shrunken_timecourses"))
}

// ---------- sortedPairs unit test ----------

func TestSortedPairs(t *testing.T) {
	// Input order should not affect output; (i < j) ordering on sorted names.
	got1 := sortedPairs([]string{"c", "a", "b"})
	got2 := sortedPairs([]string{"b", "c", "a"})
	require.Equal(t, [][2]string{{"a", "b"}, {"a", "c"}, {"b", "c"}}, got1)
	require.Equal(t, got1, got2)

	// Less than 2 → no pairs.
	require.Len(t, sortedPairs([]string{"a"}), 0)
	require.Len(t, sortedPairs(nil), 0)

	// 4 datasets → 6 pairs (4 choose 2).
	got3 := sortedPairs([]string{"d", "a", "c", "b"})
	require.Len(t, got3, 6)
	// First pair must be (a, b).
	require.Equal(t, [2]string{"a", "b"}, got3[0])
}

// ---------- C9: UNION-ALL consolidation ----------

// TestRenderCorrUnionAllSQL_OnePairUnionWrapper asserts the rendered SQL
// for N=1 pair is the inner template wrapped exactly once with the
// pair_key projection. We don't expect a literal "UNION ALL" token in the
// 1-pair case (joiner has nothing to join).
func TestRenderCorrUnionAllSQL_OnePairUnionWrapper(t *testing.T) {
	specs := []pairSpec{
		{dbA: "callingcards", dbB: "callingcards",
			colA: "callingcards_enrichment", colB: "callingcards_enrichment"},
	}
	sqlStr, args := renderCorrUnionAllSQL("pearson", "binding", specs)
	require.NotContains(t, sqlStr, "UNION ALL", "1 pair must not emit a UNION ALL joiner")
	require.Contains(t, sqlStr, "'callingcards__callingcards' AS pair_key")
	require.Contains(t, sqlStr, "SELECT *,") // outer wrapper present
	require.Empty(t, args, "no filters → no positional args")
}

// TestRenderCorrUnionAllSQL_MultiPairUnionShape: with N>=2 pairs the
// rendered SQL must contain (pairs-1) "UNION ALL" joiners and one
// pair_key projection per inner segment.
func TestRenderCorrUnionAllSQL_MultiPairUnionShape(t *testing.T) {
	specs := []pairSpec{
		{dbA: "a", dbB: "b", colA: "x", colB: "x"},
		{dbA: "a", dbB: "c", colA: "x", colB: "x"},
		{dbA: "b", dbB: "c", colA: "x", colB: "x"},
	}
	sqlStr, _ := renderCorrUnionAllSQL("pearson", "binding", specs)
	require.Equal(t, 2, strings.Count(sqlStr, "UNION ALL"),
		"3 pairs → 2 UNION ALL joiners (one between each adjacent pair)")
	require.Contains(t, sqlStr, "'a__b' AS pair_key")
	require.Contains(t, sqlStr, "'a__c' AS pair_key")
	require.Contains(t, sqlStr, "'b__c' AS pair_key")
}

// TestRenderCorrUnionAllSQL_ArgsConcatenatedInOrder pins the positional-
// binding contract: args are concatenated in pair-order, and within a
// pair, argsA precedes argsB (the same convention renderCorrPairSQL uses).
// DuckDB binds `?` placeholders left-to-right across the whole UNION
// statement, so any reordering would shift filter values to the wrong
// column.
func TestRenderCorrUnionAllSQL_ArgsConcatenatedInOrder(t *testing.T) {
	specs := []pairSpec{
		{dbA: "a", dbB: "b", colA: "x", colB: "x",
			extraWhereA: " AND foo = ?", extraWhereB: " AND bar IN (?, ?)",
			argsA: []any{"p0a"}, argsB: []any{"p0b1", "p0b2"}},
		{dbA: "a", dbB: "c", colA: "x", colB: "x",
			extraWhereA: " AND foo = ?", extraWhereB: " AND baz = ?",
			argsA: []any{"p1a"}, argsB: []any{"p1b"}},
	}
	_, args := renderCorrUnionAllSQL("pearson", "binding", specs)
	require.Equal(t,
		[]any{"p0a", "p0b1", "p0b2", "p1a", "p1b"},
		args,
		"args must be (pair0.A, pair0.B, pair1.A, pair1.B, …) in render order")
}

// ---------- 4xx response shape ----------

// Pins the same M1 invariant as TestBinding_4xxResponsesAreJSON: every 400
// path through the new handler must emit application/json with
// Cache-Control: no-store.
func TestBindingCorr_4xxResponsesAreJSON(t *testing.T) {
	s := newTestServer(t)
	rr := doGET(t, s, corrPath(s), url.Values{})
	require.Equal(t, 400, rr.Code)
	require.Equal(t, "application/json", rr.Header().Get("Content-Type"))
	require.Equal(t, "no-store", rr.Header().Get("Cache-Control"))
	require.True(t, strings.Contains(rr.Body.String(), `"error"`))
}
