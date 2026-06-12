package api

// Tests for the log10pval measurement-column option (BIND-1/BIND-3/PERT-1).
//
//   - resolveMeasurementCol("log10pval"): the neglog10p > log10p > pvalue >
//     effect fallback chain, mirroring Shiny's get_measurement_column
//     (reference/tfbpshiny/modules/binding/queries.py:26-56).
//   - applyLog10PTransform / transformScatterPoints: the -log10(p) display
//     transform, mirroring _apply_log10p_transform (workspace.py:504-535) and
//     its Pearson-only / per-side gating (workspace.py:1175-1185).

import (
	"encoding/json"
	"math"
	"net/url"
	"testing"

	"github.com/BrentLab/tfbpshiny-go/backend/internal/db"
	"github.com/BrentLab/tfbpshiny-go/backend/internal/domain"
	"github.com/stretchr/testify/require"
)

// ---------- resolveMeasurementCol("log10pval") fallback chain ----------

func TestResolveMeasurementCol_Log10Pval(t *testing.T) {
	cases := []struct {
		name string
		row  db.DatasetRow
		want string
	}{
		{
			// rossi/chec_m2025 ship a precomputed log10(p) column — the most
			// direct available source after a (nonexistent) neglog10p.
			name: "log10p source (rossi/chec)",
			row: db.DatasetRow{
				DBName: "rossi", EffectCol: "enrichment",
				PValueCol: "poisson_pval", Log10PCol: "log_poisson_pval",
			},
			want: "log_poisson_pval",
		},
		{
			// neglog10p wins over everything when present (no dataset ships one
			// today, but the chain must honor it).
			name: "neglog10p wins",
			row: db.DatasetRow{
				DBName: "synthetic", EffectCol: "enrichment",
				PValueCol: "poisson_pval", Log10PCol: "log_poisson_pval",
				NegLog10PCol: "neg_log_poisson_pval",
			},
			want: "neg_log_poisson_pval",
		},
		{
			// callingcards/harbison have no log10p variant → fall back to the
			// raw p-value column. Still works end-to-end (the scatter transform
			// then uses the "pval" source).
			name: "pvalue fallback (callingcards)",
			row: db.DatasetRow{
				DBName: "callingcards", EffectCol: "callingcards_enrichment",
				PValueCol: "poisson_pval",
			},
			want: "poisson_pval",
		},
		{
			// hackett has no p-value of any kind → fall back to the effect col.
			name: "effect fallback (hackett)",
			row: db.DatasetRow{
				DBName: "hackett", EffectCol: "log2_shrunken_timecourses",
			},
			want: "log2_shrunken_timecourses",
		},
	}
	for _, c := range cases {
		c := c
		t.Run(c.name, func(t *testing.T) {
			got, err := resolveMeasurementCol(c.row, "log10pval")
			require.NoError(t, err)
			require.Equal(t, c.want, got)
		})
	}
}

func TestResolveMeasurementCol_Log10Pval_NoColumnsErrors(t *testing.T) {
	_, err := resolveMeasurementCol(db.DatasetRow{DBName: "empty"}, "log10pval")
	require.Error(t, err, "all columns empty → error, not a silent empty identifier")
}

// ---------- log10pSourceFor: per-dataset source classification ----------

func TestLog10PSourceFor(t *testing.T) {
	cases := []struct {
		name string
		row  db.DatasetRow
		want log10pSource
	}{
		{"neglog10p", db.DatasetRow{NegLog10PCol: "neg_lp", Log10PCol: "lp", PValueCol: "p"}, srcNegLog10P},
		{"log10p", db.DatasetRow{Log10PCol: "log_poisson_pval", PValueCol: "poisson_pval"}, srcLog10P},
		{"pval", db.DatasetRow{PValueCol: "poisson_pval"}, srcPval},
		{"none", db.DatasetRow{EffectCol: "log2_shrunken_timecourses"}, srcNone},
	}
	for _, c := range cases {
		c := c
		t.Run(c.name, func(t *testing.T) {
			require.Equal(t, c.want, log10pSourceFor(c.row))
		})
	}
}

// ---------- applyLog10PTransform: the four sources + the cap ----------

func TestApplyLog10PTransform_AllSources(t *testing.T) {
	const eps = 1e-12
	cases := []struct {
		name string
		in   float64
		src  log10pSource
		want float64
	}{
		// pval: raw p → -log10(p). p=0.01 → 2.0; p=1.0 → 0.0.
		{"pval p=0.01", 0.01, srcPval, 2.0},
		{"pval p=1.0", 1.0, srcPval, 0.0},
		// pval cap: p below floor (1e-10) is clipped → exactly the cap (10).
		{"pval below floor capped", 1e-20, srcPval, 10.0},
		{"pval at floor", 1e-10, srcPval, 10.0},
		// log10p: value = log10(p) → negate then cap. log10(0.01) = -2 → 2.0.
		{"log10p -2 -> 2", -2.0, srcLog10P, 2.0},
		{"log10p 0 -> 0", 0.0, srcLog10P, 0.0},
		// log10p cap: log10(p) very negative → -value would exceed 10 → capped.
		{"log10p -15 capped at 10", -15.0, srcLog10P, 10.0},
		// neglog10p: value already = -log10(p) → upper cap only.
		{"neglog10p 3 -> 3", 3.0, srcNegLog10P, 3.0},
		{"neglog10p 12 capped at 10", 12.0, srcNegLog10P, 10.0},
		// none: pass through unchanged (no p-value variant exists).
		{"none passthrough", 4.2, srcNone, 4.2},
		{"none passthrough negative", -7.3, srcNone, -7.3},
	}
	for _, c := range cases {
		c := c
		t.Run(c.name, func(t *testing.T) {
			got := applyLog10PTransform(c.in, c.src)
			require.InDelta(t, c.want, got, eps)
		})
	}
}

// TestApplyLog10PTransform_NonFinitePassthrough pins the B-1 contract: a
// non-finite input stays non-finite (it serializes as JSON null, a plot gap),
// rather than being coerced. NaN below the floor is NOT clipped (NaN compares
// false), and -log10(NaN)=NaN.
func TestApplyLog10PTransform_NonFinitePassthrough(t *testing.T) {
	require.True(t, math.IsNaN(applyLog10PTransform(math.NaN(), srcPval)))
	require.True(t, math.IsNaN(applyLog10PTransform(math.NaN(), srcLog10P)))
	require.True(t, math.IsNaN(applyLog10PTransform(math.NaN(), srcNegLog10P)))
	require.True(t, math.IsNaN(applyLog10PTransform(math.NaN(), srcNone)))
	// +Inf p-value → -log10(+Inf) = -Inf (still non-finite → JSON null).
	require.True(t, math.IsInf(applyLog10PTransform(math.Inf(1), srcPval), -1))
}

// ---------- transformScatterPoints: per-side independence ----------

// TestTransformScatterPoints_PerSideIndependent: db_a and db_b may resolve to
// different sources, so the transform must apply each side's own source.
func TestTransformScatterPoints_PerSideIndependent(t *testing.T) {
	pts := []domain.ScatterPoint{
		{ValA: 0.01, ValB: -2.0}, // A is raw pval (→2.0), B is log10p (→2.0)
		{ValA: 1.0, ValB: 0.0},   // A=1.0 (→0.0), B=log10(1)=0 (→0.0)
	}
	transformScatterPoints(pts, srcPval, srcLog10P)
	require.InDelta(t, 2.0, float64(pts[0].ValA), 1e-12)
	require.InDelta(t, 2.0, float64(pts[0].ValB), 1e-12)
	require.InDelta(t, 0.0, float64(pts[1].ValA), 1e-12)
	require.InDelta(t, 0.0, float64(pts[1].ValB), 1e-12)
}

// ---------- Spearman-skip: handler must NOT transform ranks ----------

// TestBindingScatter_Log10Pval_Spearman_RanksUntransformed: with
// method=spearman the scatter returns RANK() integers and the handler must NOT
// apply the -log10 transform (reference workspace.py:1182-1185). We exercise a
// callingcards self-pair (its log10pval resolves to poisson_pval, source=pval)
// and assert the returned values are integral ranks, not -log10 of a rank.
func TestBindingScatter_Log10Pval_Spearman_RanksUntransformed(t *testing.T) {
	s := newTestServer(t)
	q := url.Values{
		"regulator": []string{"YBR289W"},
		"pair":      []string{"callingcards,callingcards"},
		"method":    []string{"spearman"},
		"col":       []string{"log10pval"},
	}
	rr := doGET(t, s, scatterPath(s), q)
	require.Equal(t, 200, rr.Code, rr.Body.String())
	resp := decodeScatter(t, rr.Body.Bytes())
	require.NotEmpty(t, resp.Points)
	// Spearman ranks are positive integers (RANK() OVER ...). If the transform
	// had leaked in, the values would be -log10(rank) (e.g. 0, -0.30, -0.47…),
	// i.e. <= 0 and non-integral. Assert every value is an integer >= 1.
	for _, p := range resp.Points {
		va, vb := float64(p.ValA), float64(p.ValB)
		require.GreaterOrEqual(t, va, 1.0, "spearman ValA must be an untransformed rank")
		require.GreaterOrEqual(t, vb, 1.0, "spearman ValB must be an untransformed rank")
		require.Equal(t, math.Trunc(va), va, "rank must be integral (no transform)")
		require.Equal(t, math.Trunc(vb), vb, "rank must be integral (no transform)")
	}
}

// TestBindingScatter_Log10Pval_Pearson_AppliesTransform: with method=pearson
// and col=log10pval the callingcards values (raw poisson_pval, in [0,1]) must
// come back as -log10(p) >= 0 (capped at 10), confirming the server-side
// transform ran. Raw p-values in [0,1] would otherwise be <= 1.
func TestBindingScatter_Log10Pval_Pearson_AppliesTransform(t *testing.T) {
	s := newTestServer(t)
	q := url.Values{
		"regulator": []string{"YBR289W"},
		"pair":      []string{"callingcards,callingcards"},
		"method":    []string{"pearson"},
		"col":       []string{"log10pval"},
	}
	rr := doGET(t, s, scatterPath(s), q)
	require.Equal(t, 200, rr.Code, rr.Body.String())
	resp := decodeScatter(t, rr.Body.Bytes())
	require.NotEmpty(t, resp.Points)
	sawAboveOne := false
	for _, p := range resp.Points {
		va := float64(p.ValA)
		if math.IsNaN(va) {
			continue
		}
		require.GreaterOrEqual(t, va, 0.0, "-log10(p) is non-negative for p in (0,1]")
		require.LessOrEqual(t, va, log10pCap+1e-9, "transform must cap at 10")
		if va > 1.0 {
			sawAboveOne = true
		}
	}
	require.True(t, sawAboveOne,
		"at least one transformed value should exceed 1.0 (raw p in [0,1] never would)")
}

// TestPerturbationScatter_Log10Pval_EffectFallback: hackett has no p-value, so
// log10pval resolves to the effect col and the source is "none" → no transform.
// The self-pair must still 200 and return the raw effect values unchanged.
func TestPerturbationScatter_Log10Pval_EffectFallback(t *testing.T) {
	s := newTestServer(t)
	q := url.Values{
		"regulator": []string{"YBR289W"},
		"pair":      []string{"hackett,hackett"},
		"method":    []string{"pearson"},
		"col":       []string{"log10pval"},
	}
	path := "/api/v/" + s.Manifests.Artifact.ArtifactVersion + "/perturbation/scatter"
	rr := doGET(t, s, path, q)
	require.Equal(t, 200, rr.Code, rr.Body.String())
	resp := decodeScatter(t, rr.Body.Bytes())
	require.Equal(t, "log2_shrunken_timecourses", resp.ColA,
		"hackett log10pval resolves to the effect col (no p-value variant)")
	require.NotEmpty(t, resp.Points)
}

// ---------- log10pAxisLabel: per-side axis-label measure ----------

func TestLog10PAxisLabel(t *testing.T) {
	cases := []struct {
		name        string
		reqCol      string
		method      string
		resolvedCol string
		src         log10pSource
		want        string
	}{
		// col=log10pval, pearson, a p-value source → "-log10(p)".
		{"pearson pval source", "log10pval", "pearson", "poisson_pval", srcPval, "-log10(p)"},
		{"pearson log10p source", "log10pval", "pearson", "log_poisson_pval", srcLog10P, "-log10(p)"},
		{"pearson neglog10p source", "log10pval", "pearson", "neg_lp", srcNegLog10P, "-log10(p)"},
		// col=log10pval, pearson, effect-fallback side (source=none) → column name.
		{"pearson none -> column", "log10pval", "pearson", "log2_shrunken_timecourses", srcNone, "log2_shrunken_timecourses"},
		// col=log10pval, spearman → "rank by p-value" regardless of source.
		{"spearman pval", "log10pval", "spearman", "poisson_pval", srcPval, "rank by p-value"},
		{"spearman none", "log10pval", "spearman", "log2_shrunken_timecourses", srcNone, "rank by p-value"},
		// col != log10pval → column name (current behavior), even for spearman.
		{"effect pearson -> column", "effect", "pearson", "callingcards_enrichment", srcPval, "callingcards_enrichment"},
		{"pvalue spearman -> column", "pvalue", "spearman", "poisson_pval", srcPval, "poisson_pval"},
	}
	for _, c := range cases {
		c := c
		t.Run(c.name, func(t *testing.T) {
			require.Equal(t, c.want, log10pAxisLabel(c.reqCol, c.method, c.resolvedCol, c.src))
		})
	}
}

// TestBindingScatter_Log10Pval_Pearson_AxisLabels: the response must carry
// "-log10(p)" as the axis-label measure for a p-value-source side under
// pearson+log10pval (callingcards self-pair → poisson_pval, source=pval).
func TestBindingScatter_Log10Pval_Pearson_AxisLabels(t *testing.T) {
	s := newTestServer(t)
	q := url.Values{
		"regulator": []string{"YBR289W"},
		"pair":      []string{"callingcards,callingcards"},
		"method":    []string{"pearson"},
		"col":       []string{"log10pval"},
	}
	rr := doGET(t, s, scatterPath(s), q)
	require.Equal(t, 200, rr.Code, rr.Body.String())
	resp := decodeScatter(t, rr.Body.Bytes())
	require.Equal(t, "-log10(p)", resp.AxisLabelA)
	require.Equal(t, "-log10(p)", resp.AxisLabelB)
}

// TestBindingScatter_Log10Pval_Spearman_AxisLabels: under spearman+log10pval
// the measure is "rank by p-value" on both sides.
func TestBindingScatter_Log10Pval_Spearman_AxisLabels(t *testing.T) {
	s := newTestServer(t)
	q := url.Values{
		"regulator": []string{"YBR289W"},
		"pair":      []string{"callingcards,callingcards"},
		"method":    []string{"spearman"},
		"col":       []string{"log10pval"},
	}
	rr := doGET(t, s, scatterPath(s), q)
	require.Equal(t, 200, rr.Code, rr.Body.String())
	resp := decodeScatter(t, rr.Body.Bytes())
	require.Equal(t, "rank by p-value", resp.AxisLabelA)
	require.Equal(t, "rank by p-value", resp.AxisLabelB)
}

// TestPerturbationScatter_Log10Pval_AxisLabel_EffectFallback: hackett has no
// p-value, so under pearson+log10pval its source is "none" and the axis-label
// measure falls back to the resolved column name (NOT "-log10(p)").
func TestPerturbationScatter_Log10Pval_AxisLabel_EffectFallback(t *testing.T) {
	s := newTestServer(t)
	q := url.Values{
		"regulator": []string{"YBR289W"},
		"pair":      []string{"hackett,hackett"},
		"method":    []string{"pearson"},
		"col":       []string{"log10pval"},
	}
	path := "/api/v/" + s.Manifests.Artifact.ArtifactVersion + "/perturbation/scatter"
	rr := doGET(t, s, path, q)
	require.Equal(t, 200, rr.Code, rr.Body.String())
	resp := decodeScatter(t, rr.Body.Bytes())
	require.Equal(t, "log2_shrunken_timecourses", resp.AxisLabelA,
		"effect-fallback side keeps its column name, not -log10(p)")
	require.Equal(t, "log2_shrunken_timecourses", resp.AxisLabelB)
}

// TestBindingScatter_Effect_AxisLabelIsColumn: with col=effect the axis-label
// measure is the resolved column name (current/legacy behavior preserved).
func TestBindingScatter_Effect_AxisLabelIsColumn(t *testing.T) {
	s := newTestServer(t)
	q := url.Values{
		"regulator": []string{"YBR289W"},
		"pair":      []string{"callingcards,callingcards"},
		"method":    []string{"pearson"},
		"col":       []string{"effect"},
	}
	rr := doGET(t, s, scatterPath(s), q)
	require.Equal(t, 200, rr.Code, rr.Body.String())
	resp := decodeScatter(t, rr.Body.Bytes())
	require.Equal(t, "callingcards_enrichment", resp.AxisLabelA)
	require.Equal(t, resp.ColA, resp.AxisLabelA)
}

func decodeScatter(t *testing.T, body []byte) domain.ScatterResponse {
	t.Helper()
	var resp domain.ScatterResponse
	require.NoError(t, json.Unmarshal(body, &resp))
	return resp
}
