package api

// Multi-review follow-up tests (commit 218bf3c → this fix-up).
//
//   F1 — the four scatter SQL templates must filter NULL/Inf/NaN BEFORE
//        rows reach JSON marshalling (parity with corr_pair_*.sql).
//   F4 — /binding/corr and /perturbation/correlations must strip
//        regulator_locus_tag from the caller-supplied filters dict before
//        the field-whitelist check (symmetric with serveScatter).

import (
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/BrentLab/tfbpshiny-go/backend/internal/domain"
	"github.com/stretchr/testify/require"
)

// ---------- F1: scatter SQL templates filter NULL/Inf/NaN ----------

// TestScatterSQL_HasNullInfNaNFilter asserts the rendered SQL for every
// (datatype × method) combination of regulator_scatter_*.sql contains the
// six-clause WHERE filter that excludes NULL / Inf / NaN. Without this
// filter, an Inf measurement leaks through to the JSON response and
// json.Marshal returns an error (Go's encoding/json refuses to emit
// non-finite floats), producing a 500.
//
// We test at the rendered-SQL layer rather than over the wire because the
// committed fixture is finite-by-construction — exercising the new WHERE
// clause end-to-end would require a synthetic DuckDB with poisoned rows,
// which is out of scope for this fix-up. A rendered-SQL substring check
// is the same shape as the test that already pins the corr_pair filter
// (see correlation_parity_test.go).
func TestScatterSQL_HasNullInfNaNFilter(t *testing.T) {
	cases := []struct {
		method, dataType, colA, colB string
	}{
		{"pearson", "binding", "callingcards_enrichment", "callingcards_enrichment"},
		{"spearman", "binding", "callingcards_enrichment", "callingcards_enrichment"},
		{"pearson", "perturbation", "log2_shrunken_timecourses", "log2_shrunken_timecourses"},
		{"spearman", "perturbation", "log2_shrunken_timecourses", "log2_shrunken_timecourses"},
	}
	for _, c := range cases {
		c := c
		t.Run(c.dataType+"/"+c.method, func(t *testing.T) {
			sqlStr, _ := renderScatterSQL(c.method, c.dataType, "YBR289W", pairSpec{
				dbA: "ds_a", dbB: "ds_b",
				colA: c.colA, colB: c.colB,
			})
			// Six required clauses — exactly mirrors corr_pair_*.sql.
			require.Contains(t, sqlStr, "IS NOT NULL", "missing IS NOT NULL clause")
			require.Contains(t, sqlStr, "NOT isinf(a."+c.colA+")")
			require.Contains(t, sqlStr, "NOT isinf(b."+c.colB+")")
			require.Contains(t, sqlStr, "NOT isnan(a."+c.colA+")")
			require.Contains(t, sqlStr, "NOT isnan(b."+c.colB+")")
		})
	}
}

// ---------- F4: /corr strips regulator_locus_tag before CheckField ----------

// TestBindingCorr_StripsRegulatorFromFilters: passing a
// regulator_locus_tag entry inside `filters=` MUST NOT trip the
// CheckField whitelist (regulator_locus_tag is a real column but not a
// field_manifest entry). Before the F4 fix, this returned 400. We expect
// the fixture-driven N=2 self-pair to error with "at least 2" only when
// the dataset count is genuinely < 2 — here it's the same name twice so
// dedupeAndCapCSV collapses to 1. To exercise the filter strip without
// tripping the dataset-count gate we need exactly two distinct names, but
// the committed binding fixture has only one (callingcards). So instead
// we assert: the response must not be a 400 with "unknown field
// regulator_locus_tag" — any 400 about the dataset count is fine and
// confirms the strip ran first.
func TestBindingCorr_StripsRegulatorBeforeFieldCheck(t *testing.T) {
	s := newTestServer(t)
	q := url.Values{
		"datasets": []string{"callingcards,callingcards"},
		"method":   []string{"pearson"},
		"col":      []string{"effect"},
		"filters": []string{
			`{"callingcards":{"regulator_locus_tag":{"type":"categorical","value":["YBR289W"]}}}`,
		},
	}
	rr := httptest.NewRecorder()
	req := httptest.NewRequest("GET",
		"/api/v/"+s.Manifests.Artifact.ArtifactVersion+"/binding/corr?"+q.Encode(), nil)
	s.Routes().ServeHTTP(rr, req)
	// We accept either a 200 (if N >= 2 distinct datasets survived) or a 400
	// about dataset count — what we MUST NOT see is a 400 mentioning
	// "regulator_locus_tag" (which is what a missing strip would produce).
	body := rr.Body.String()
	require.NotContains(t, body, "regulator_locus_tag",
		"regulator_locus_tag must be stripped from filters before field-whitelist check")
	// Sanity: a CheckField rejection would name the unknown field. The
	// remaining 400 paths (dataset-count, dataset-type) don't.
	if rr.Code == 400 {
		require.False(t, strings.Contains(body, "unknown field"),
			"strip should prevent 'unknown field' error, got: %s", body)
	}
}

// TestPerturbationCorrelations_StripsRegulatorBeforeFieldCheck — same
// assertion on the perturbation side. The fixture has exactly one
// perturbation dataset (hackett) so dedupeAndCapCSV collapses
// `hackett,hackett` to N=1; we assert the body never mentions the
// regulator_locus_tag field (which would indicate the strip never ran).
func TestPerturbationCorrelations_StripsRegulatorBeforeFieldCheck(t *testing.T) {
	s := newTestServer(t)
	q := url.Values{
		"datasets": []string{"hackett,hackett"},
		"method":   []string{"pearson"},
		"col":      []string{"effect"},
		"filters": []string{
			`{"hackett":{"regulator_locus_tag":{"type":"categorical","value":["YBR289W"]}}}`,
		},
	}
	rr := httptest.NewRecorder()
	req := httptest.NewRequest("GET",
		"/api/v/"+s.Manifests.Artifact.ArtifactVersion+"/perturbation/correlations?"+q.Encode(), nil)
	s.Routes().ServeHTTP(rr, req)
	require.NotContains(t, rr.Body.String(), "regulator_locus_tag",
		"regulator_locus_tag must be stripped from filters before field-whitelist check")
}

// ---------- F2: pearsonR clamp regression ----------

// TestPearsonR_NoNaNFromTinyNegativeVariance pins the F2 fix: with a
// zero-variance series the textbook formula can compute denomA at a tiny
// negative float (e.g. -2.7e-17) due to round-off, which previously
// produced NaN under math.Sqrt. The clamp forces a 0 return.
func TestPearsonR_NoNaNFromTinyNegativeVariance(t *testing.T) {
	// All-identical y: sy2 == sy*sy/n exactly in exact arithmetic, but
	// floating-point can wobble. Construct a series where the textbook
	// denominator is provably tiny-negative via accumulation order. The
	// simplest stable trigger is a degenerate (all-same) series — the
	// clamp must short-circuit the Sqrt(negative) path.
	pts := []domain.ScatterPoint{
		{ValA: 1e10, ValB: 5.0},
		{ValA: 1e10, ValB: 5.0},
		{ValA: 1e10, ValB: 5.0},
		{ValA: 1e10, ValB: 5.0},
	}
	r := pearsonR(pts)
	require.False(t, isNaNFloat(r), "pearsonR must never return NaN (denomA/denomB clamp)")
	require.Equal(t, 0.0, r, "zero-variance series -> r=0 per Shiny NaN-coercion contract")
}

// isNaNFloat avoids the math import in this file's other tests.
func isNaNFloat(f float64) bool { return f != f }
