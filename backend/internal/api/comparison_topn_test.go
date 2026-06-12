package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/BrentLab/tfbpshiny-go/backend/internal/cache"
	"github.com/BrentLab/tfbpshiny-go/backend/internal/db"
	"github.com/BrentLab/tfbpshiny-go/backend/internal/domain"
	"github.com/BrentLab/tfbpshiny-go/backend/internal/queries"
	_ "github.com/marcboeker/go-duckdb/v2"
	"github.com/stretchr/testify/require"
)

// newServerWithFixtureWhitelist returns a Server wired with an in-memory
// Whitelist covering every dataset referenced by bindingConfigs /
// pertConfigs, populated with their production effect_col / pvalue_col.
// Used by the SQL-rendering tests that need a real Whitelist but do not
// need to open the DuckDB fixture (which only contains callingcards +
// hackett rows in dataset_manifest).
func newServerWithFixtureWhitelist(t *testing.T) *Server {
	t.Helper()
	m := &db.Manifests{
		Datasets: []db.DatasetRow{
			// binding
			{DBName: "callingcards", DataType: "binding", EffectCol: "callingcards_enrichment", PValueCol: "poisson_pval"},
			{DBName: "harbison", DataType: "binding", EffectCol: "effect", PValueCol: "pvalue"},
			{DBName: "rossi", DataType: "binding", EffectCol: "enrichment", PValueCol: "poisson_pval"},
			{DBName: "chec_m2025", DataType: "binding", EffectCol: "enrichment", PValueCol: "poisson_pval"},
			// perturbation
			{DBName: "degron", DataType: "perturbation", EffectCol: "log2FoldChange", PValueCol: "padj"},
			{DBName: "hughes_overexpression", DataType: "perturbation", EffectCol: "mean_norm_log2fc", PValueCol: ""},
			{DBName: "hughes_knockout", DataType: "perturbation", EffectCol: "mean_norm_log2fc", PValueCol: ""},
			{DBName: "kemmeren", DataType: "perturbation", EffectCol: "Madj", PValueCol: "pval"},
			{DBName: "hackett", DataType: "perturbation", EffectCol: "log2_shrunken_timecourses", PValueCol: ""},
			{DBName: "hu_reimand", DataType: "perturbation", EffectCol: "effect", PValueCol: "pval"},
		},
	}
	wl, err := db.NewWhitelist(m)
	require.NoError(t, err)
	return &Server{Manifests: m, Whitelist: wl}
}

func TestComparisonTopN_RejectsUnknownBindingDataset(t *testing.T) {
	s := newTestServer(t)
	q := url.Values{"binding": []string{"unknown"}, "perturbation": []string{"hackett"}}
	rr := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/v/"+s.Manifests.Artifact.ArtifactVersion+"/comparison/topn?"+q.Encode(), nil)
	s.Routes().ServeHTTP(rr, req)
	require.Equal(t, 400, rr.Code)
}

func TestComparisonTopN_RejectsUnknownPerturbationDataset(t *testing.T) {
	s := newTestServer(t)
	q := url.Values{"binding": []string{"callingcards"}, "perturbation": []string{"unknown"}}
	rr := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/v/"+s.Manifests.Artifact.ArtifactVersion+"/comparison/topn?"+q.Encode(), nil)
	s.Routes().ServeHTTP(rr, req)
	require.Equal(t, 400, rr.Code)
}

// stripSQLComments removes -- single-line comments from a SQL string. The
// topn.sql template has a header that mentions {{binding_cte_body}} etc.
// inside `--` comments, so the str.Replacer also rewrites those, inflating
// any `?` count. Bound parameters are only counted from executable SQL.
func stripSQLComments(s string) string {
	out := []string{}
	for _, line := range strings.Split(s, "\n") {
		if i := strings.Index(line, "--"); i >= 0 {
			line = line[:i]
		}
		out = append(out, line)
	}
	return strings.Join(out, "\n")
}

// TestComparisonTopN_PlaceholderCountInvariant_RegressionPair pins the bug
// fix for arg-ordering inside buildOnePair. With the buggy ordering, args
// were appended in the wrong order so effThr was bound to `WHERE rnk <= ?`
// and topN was bound to a threshold comparator — silently returning wrong
// results. We now assert that for the specific pairs called out in the
// review, the rendered SQL has exactly as many `?` as there are args.
func TestComparisonTopN_PlaceholderCountInvariant_RegressionPair(t *testing.T) {
	tmpl := queries.Get("comparison/topn.sql")
	srv := newServerWithFixtureWhitelist(t)

	pairs := []struct {
		binding, pert string
	}{
		{"callingcards", "hackett"},
		{"harbison", "kemmeren"},
	}
	for _, p := range pairs {
		bcfg := bindingConfigs[p.binding]
		pcfg := pertConfigs[p.pert]
		rendered, args, err := srv.buildOnePair(
			tmpl, p.binding, p.pert, bcfg, pcfg,
			25, 0.0, 0.05, "", domain.FiltersByDB{},
		)
		require.NoError(t, err, "pair %s/%s", p.binding, p.pert)
		got := strings.Count(stripSQLComments(rendered), "?")
		require.Equalf(t, len(args), got,
			"pair %s/%s: rendered SQL has %d ? but args has %d entries",
			p.binding, p.pert, got, len(args))
	}
}

// TestComparisonTopN_PlaceholderCountInvariant_AllPairs sanity-checks every
// supported binding × perturbation combination (4 × 6 = 24 pairs).
// TestComparisonTopN_HarbisonDropsFilters pins C-1: the harbison dedup branch
// DROPS user-supplied binding filters (matching Shiny's queries.py:233-234,
// which sets binding_cte_body = binding_dedup_cte verbatim and never builds a
// filter WHERE). The MIN(pvalue) dedup aggregation is incompatible with
// per-row filters. A filter on harbison must therefore not change the rendered
// pair SQL or its args at all.
func TestComparisonTopN_HarbisonDropsFilters(t *testing.T) {
	tmpl := queries.Get("comparison/topn.sql")
	srv := newServerWithFixtureWhitelist(t)
	bcfg := bindingConfigs["harbison"]
	pcfg := pertConfigs["kemmeren"]

	plain, plainArgs, err := srv.buildOnePair(
		tmpl, "harbison", "kemmeren", bcfg, pcfg, 25, 0.0, 0.05, "", nil,
	)
	require.NoError(t, err)

	filters := domain.FiltersByDB{
		"harbison": map[string]domain.FilterSpec{
			"condition": {Type: "categorical", Value: []byte(`["NOT_A_REAL_CONDITION"]`)},
		},
	}
	withFilter, withArgs, err := srv.buildOnePair(
		tmpl, "harbison", "kemmeren", bcfg, pcfg, 25, 0.0, 0.05, "", filters,
	)
	require.NoError(t, err)

	// Identical rendered SQL + args: the harbison filter was dropped.
	require.Equal(t, plain, withFilter,
		"harbison dedup branch must ignore filters[harbison] (C-1)")
	require.Equal(t, plainArgs, withArgs)
	require.NotContains(t, withFilter, "NOT_A_REAL_CONDITION")
}

// C-5: top_n clamps 0/negative UP to 1 (Shiny's max(1, val)), not to the
// default; empty/unparseable falls back to the default; > max clamps down.
func TestClampTopN_ParityClamping(t *testing.T) {
	require.Equal(t, 1, clampTopN("0", 25))
	require.Equal(t, 1, clampTopN("-5", 25))
	require.Equal(t, 25, clampTopN("", 25))
	require.Equal(t, 25, clampTopN("abc", 25))
	require.Equal(t, TopNMax, clampTopN("99999", 25))
	require.Equal(t, 50, clampTopN("50", 25))
}

// C-5/C-6: a malformed effect/pvalue threshold silently falls back to the
// default rather than 400-ing.
func TestParseFloatOr_FallsBackOnError(t *testing.T) {
	require.Equal(t, 0.05, parseFloatOr("", 0.05))
	require.Equal(t, 0.05, parseFloatOr("not-a-number", 0.05))
	require.InDelta(t, 0.123, parseFloatOr("0.123", 0.05), 1e-12)
}

// C-2: keepConfigured drops datasets without a TopN config (and would log a
// warning) rather than failing the whole request.
func TestKeepConfigured_SkipsUnconfigured(t *testing.T) {
	req := httptest.NewRequest("GET", "/", nil)
	got := keepConfigured(req, []string{"a", "b", "c"}, "binding", func(d string) bool { return d != "b" })
	require.Equal(t, []string{"a", "c"}, got)
}

// SQL-2: execution-level numerical parity for the TopN query — the single most
// complex query in the app, which previously had ZERO value coverage (all
// prior tests were SQL-substring / placeholder-count checks). This runs the
// full callingcards×hackett pair end-to-end through the DB and pins the
// responsive-ratio invariants (n / n_responsive / responsive_ratio = n_resp/n).
func TestComparisonTopN_ExecutionParity_CallingcardsHackett(t *testing.T) {
	s := newTestServer(t)
	rr := httptest.NewRecorder()
	q := url.Values{}
	q.Set("binding", "callingcards")
	q.Set("perturbation", "hackett")
	q.Set("top_n", "25")
	reqURL := "/api/v/" + s.Manifests.Artifact.ArtifactVersion + "/comparison/topn?" + q.Encode()
	s.Routes().ServeHTTP(rr, httptest.NewRequest("GET", reqURL, nil))
	require.Equal(t, 200, rr.Code, rr.Body.String())

	var resp domain.TopNResponse
	require.NoError(t, json.Unmarshal(rr.Body.Bytes(), &resp))
	require.Equal(t, 25, resp.TopN)
	// dto_expanded wires cc_0_a→h_0 and cc_1_a→h_1, so the pair produces rows.
	require.NotEmpty(t, resp.Rows, "callingcards×hackett TopN must produce rows")
	for _, row := range resp.Rows {
		require.Equal(t, "callingcards__hackett", row.PairKey)
		require.Greater(t, row.N, int64(0), "n must be positive")
		require.GreaterOrEqual(t, row.NResponsive, int64(0))
		require.LessOrEqual(t, row.NResponsive, row.N, "n_responsive <= n")
		// responsive_ratio == n_responsive / n, in [0, 1].
		ratio := float64(row.ResponsiveRatio)
		require.InDelta(t, float64(row.NResponsive)/float64(row.N), ratio, 1e-9,
			"responsive_ratio must equal n_responsive/n")
		require.GreaterOrEqual(t, ratio, 0.0)
		require.LessOrEqual(t, ratio, 1.0)
	}
}

// TestComparisonTopN_MultiPairAssemblyOrder pins the per-pair execution
// rewrite: /comparison/topn now runs + caches each (binding, perturbation) pair
// as its own query (instead of one big UNION ALL) and concatenates them in
// pair_key order, each pair ordered by its remaining GROUP BY columns. The
// assembled stream MUST therefore be globally non-decreasing in
// (pair_key, binding_sample_id, regulator_locus_tag, perturbation_sample_id) —
// byte-for-byte the order the old single-UNION `ORDER BY ...` produced. The
// snapshot/golden URLs only exercise single-pair requests, so this is the
// multi-pair ordering guard.
func TestComparisonTopN_MultiPairAssemblyOrder(t *testing.T) {
	s := newTestServer(t)
	rr := httptest.NewRecorder()
	q := url.Values{}
	q.Set("binding", "harbison,callingcards") // deliberately NOT pair_key order
	q.Set("perturbation", "kemmeren,hackett")
	q.Set("top_n", "25")
	reqURL := "/api/v/" + s.Manifests.Artifact.ArtifactVersion + "/comparison/topn?" + q.Encode()
	s.Routes().ServeHTTP(rr, httptest.NewRequest("GET", reqURL, nil))
	require.Equal(t, 200, rr.Code, rr.Body.String())

	var resp domain.TopNResponse
	require.NoError(t, json.Unmarshal(rr.Body.Bytes(), &resp))
	require.NotEmpty(t, resp.Rows, "multi-pair request must produce rows")

	// Null-joined key compares the 4-tuple lexicographically (0x00 < any value
	// char, so it is a clean separator) and is a string testify can order.
	sortKey := func(r domain.TopNRow) string {
		return strings.Join([]string{
			r.PairKey, r.BindingSampleID, r.RegulatorLocusTag, r.PerturbationSampleID,
		}, "\x00")
	}
	distinctPairs := map[string]bool{}
	for i, row := range resp.Rows {
		distinctPairs[row.PairKey] = true
		if i == 0 {
			continue
		}
		require.LessOrEqual(t, sortKey(resp.Rows[i-1]), sortKey(row),
			"rows must be globally ordered by (pair_key, binding_sample_id, "+
				"regulator_locus_tag, perturbation_sample_id); row %d breaks it", i)
	}
	// More than one pair_key proves the multi-pair assembly actually ran (not a
	// single dominant pair), and request order (harbison/kemmeren first) did not
	// leak into the output order.
	require.Greater(t, len(distinctPairs), 1, "expected multiple pair_keys in a 4-pair request")
}

// TestComparisonTopN_HackettFilterParity pins the A4 fix: when the
// perturbation dataset has hackett_time_filter=true, user-supplied
// filters[pDB] MUST NOT be applied to the perturbation CTE — Shiny does
// this at reference/tfbpshiny/modules/comparison/queries.py:432. Before
// the fix the Go path applied filters unconditionally, producing
// silently divergent output.
//
// Pre-fix this test FAILS: the rendered SQL contains the hackett "time"
// filter clause in the perturbation block. Post-fix it PASSES: the
// hackett-side filter is dropped while binding-side filters still appear
// (regression guard against accidentally dropping all filters).
func TestComparisonTopN_HackettFilterParity(t *testing.T) {
	tmpl := queries.Get("comparison/topn.sql")
	srv := newServerWithFixtureWhitelist(t)
	bcfg := bindingConfigs["callingcards"]
	pcfg := pertConfigs["hackett"]

	filters := domain.FiltersByDB{
		"hackett": map[string]domain.FilterSpec{
			"time": {Type: "numeric", Value: []byte(`[40, 50]`)},
		},
		// Binding-side filter — guard against the fix accidentally dropping
		// filters for the binding dataset too.
		"callingcards": map[string]domain.FilterSpec{
			"target_locus_tag": {Type: "categorical", Value: []byte(`["YBR289W"]`)},
		},
	}
	rendered, _, err := srv.buildOnePair(
		tmpl, "callingcards", "hackett", bcfg, pcfg,
		25, 0.0, 0.05, "", filters,
	)
	require.NoError(t, err)
	// The hackett-side filter MUST be absent from the rendered SQL after
	// the A4 parity fix; this assertion fails pre-fix.
	require.NotContainsf(t, rendered, `"time"`,
		"hackett perturbation filter must be dropped when "+
			"hackett_time_filter=true (parity with queries.py:432); got SQL:\n%s",
		rendered)
	// Binding-side filter on callingcards MUST still appear — regression
	// guard that we only dropped the hackett-side filter, not all filters.
	require.Containsf(t, rendered, `"target_locus_tag"`,
		"binding-side filter must still be applied; got SQL:\n%s", rendered)
}

// TestBuildSquirrelWhereRaw_RejectsUnknownType pins the H3 fix: an
// unknown filter spec.Type used to silently produce an empty WHERE
// clause (dropping the user-requested filter). It now returns an error.
func TestBuildSquirrelWhereRaw_RejectsUnknownType(t *testing.T) {
	fs := map[string]domain.FilterSpec{
		"some_field": {Type: "bogus", Value: []byte(`"x"`)},
	}
	_, _, err := buildSquirrelWhereRaw(fs)
	require.Error(t, err)
	require.Contains(t, err.Error(), "bogus")
}

func TestComparisonTopN_PlaceholderCountInvariant_AllPairs(t *testing.T) {
	tmpl := queries.Get("comparison/topn.sql")
	srv := newServerWithFixtureWhitelist(t)

	bindings := []string{"callingcards", "harbison", "chec_m2025", "rossi"}
	perts := []string{"hackett", "hughes_overexpression", "hughes_knockout", "hu_reimand", "kemmeren", "degron"}

	for _, b := range bindings {
		for _, p := range perts {
			bcfg := bindingConfigs[b]
			pcfg := pertConfigs[p]
			rendered, args, err := srv.buildOnePair(
				tmpl, b, p, bcfg, pcfg,
				25, 0.0, 0.05, "", domain.FiltersByDB{},
			)
			require.NoError(t, err, "pair %s/%s", b, p)
			got := strings.Count(stripSQLComments(rendered), "?")
			require.Equalf(t, len(args), got,
				"pair %s/%s: rendered SQL has %d ? but args has %d entries",
				b, p, got, len(args))
		}
	}
}

// TestBuildResponsiveExpr_TwoTermCaseForKemmeren pins the production
// two-term CASE for a perturbation dataset that carries both effect_col
// and pvalue_col in dataset_manifest (kemmeren: Madj / pval).
func TestBuildResponsiveExpr_TwoTermCaseForKemmeren(t *testing.T) {
	srv := newServerWithFixtureWhitelist(t)
	args := []any{}
	expr := buildResponsiveExpr(srv, "kemmeren", 0.5, 0.05, &args)
	require.Equal(t,
		`CASE WHEN ABS(p."Madj") > ? AND p."pval" < ? THEN 1 ELSE 0 END`,
		expr,
	)
	require.Equal(t, []any{0.5, 0.05}, args)
}

// TestBuildResponsiveExpr_OneTermCaseForHackett pins the one-term
// branch: hackett has effect_col but empty pvalue_col.
func TestBuildResponsiveExpr_OneTermCaseForHackett(t *testing.T) {
	srv := newServerWithFixtureWhitelist(t)
	args := []any{}
	expr := buildResponsiveExpr(srv, "hackett", 0.5, 0.05, &args)
	require.Equal(t,
		`CASE WHEN ABS(p."log2_shrunken_timecourses") > ? THEN 1 ELSE 0 END`,
		expr,
	)
	require.Equal(t, []any{0.5}, args)
}

// TestBuildResponsiveExpr_UnknownDatasetFallback covers the final
// branch — an unknown pDB returns the responsive-column fallback and
// appends no args.
func TestBuildResponsiveExpr_UnknownDatasetFallback(t *testing.T) {
	srv := newServerWithFixtureWhitelist(t)
	args := []any{}
	expr := buildResponsiveExpr(srv, "no_such_dataset", 0.5, 0.05, &args)
	require.Equal(t, "CAST(p.responsive AS INTEGER)", expr)
	require.Empty(t, args)
}

// TestComparisonTopN_RenderedTwoTermCasePresent locks the rendered SQL
// for callingcards × kemmeren — the topn template should embed the
// two-term CASE with `Madj` and `pval`, each double-quoted via quotedIdent
// (defense-in-depth so a future reserved-keyword measurement column parses).
func TestComparisonTopN_RenderedTwoTermCasePresent(t *testing.T) {
	tmpl := queries.Get("comparison/topn.sql")
	srv := newServerWithFixtureWhitelist(t)
	bcfg := bindingConfigs["callingcards"]
	pcfg := pertConfigs["kemmeren"]
	rendered, _, err := srv.buildOnePair(
		tmpl, "callingcards", "kemmeren", bcfg, pcfg,
		25, 0.0, 0.05, "", domain.FiltersByDB{},
	)
	require.NoError(t, err)
	require.Contains(t,
		rendered,
		`CASE WHEN ABS(p."Madj") > ? AND p."pval" < ? THEN 1 ELSE 0 END`,
	)
}

// CMP-4/CMP-5: resolveResponsivenessThresholds maps a (preset, perturbation)
// to the reference DEFAULT_RESPONSIVENESS_PRESETS author thresholds, with the
// "*" fallback for unlisted datasets and passthrough of the request defaults
// when the preset is empty/unknown.
func TestResolveResponsivenessThresholds(t *testing.T) {
	cases := []struct {
		preset, pDB       string
		defEff, defPval   float64
		wantEff, wantPval float64
	}{
		{"Stringent", "kemmeren", 0.0, 0.05, 0.77, 0.05},
		{"Stringent", "degron", 0.0, 0.05, 0.38, 0.1},
		{"Stringent", "no_such", 0.0, 0.05, 1.0, 0.05}, // "*" fallback
		{"Relaxed", "hackett", 0.0, 0.05, 0.0, 1.0},
		{"Relaxed", "kemmeren", 0.0, 0.05, 0.0, 0.05}, // "*" fallback
		{"", "kemmeren", 0.3, 0.07, 0.3, 0.07},        // no preset → passthrough
		{"Bogus", "kemmeren", 0.3, 0.07, 0.3, 0.07},   // unknown → passthrough
	}
	for _, c := range cases {
		eff, pval := resolveResponsivenessThresholds(c.preset, c.pDB, c.defEff, c.defPval)
		require.InDeltaf(t, c.wantEff, eff, 1e-12, "preset=%q pDB=%q effect", c.preset, c.pDB)
		require.InDeltaf(t, c.wantPval, pval, 1e-12, "preset=%q pDB=%q pvalue", c.preset, c.pDB)
	}
}

// CMP-4/CMP-5: with ?preset=Stringent the per-dataset author thresholds are
// bound into the rendered SQL instead of the request's numeric effect/pvalue.
// kemmeren's Stringent effect threshold (0.77) must appear in the args while
// the unpresetted call binds the default (0.0).
func TestComparisonTopN_PresetBindsAuthorThresholds(t *testing.T) {
	tmpl := queries.Get("comparison/topn.sql")
	srv := newServerWithFixtureWhitelist(t)
	bcfg := bindingConfigs["callingcards"]
	pcfg := pertConfigs["kemmeren"]

	_, defArgs, err := srv.buildOnePair(
		tmpl, "callingcards", "kemmeren", bcfg, pcfg,
		25, 0.0, 0.05, "", domain.FiltersByDB{},
	)
	require.NoError(t, err)
	require.Contains(t, defArgs, 0.0, "default preset binds effect=0.0")
	require.NotContains(t, defArgs, 0.77)

	_, strArgs, err := srv.buildOnePair(
		tmpl, "callingcards", "kemmeren", bcfg, pcfg,
		25, 0.0, 0.05, "Stringent", domain.FiltersByDB{},
	)
	require.NoError(t, err)
	require.Contains(t, strArgs, 0.77, "Stringent binds kemmeren effect=0.77")
}

// CMP-2: the 11 promoter-set variant binding datasets are configured for
// comparison topn (so keepConfigured no longer silently drops them). The
// `_peaks` variants rank by peak_score DESC.
func TestComparisonTopN_VariantBindingConfigsPresent(t *testing.T) {
	for _, db := range []string{
		"callingcards_mindel", "callingcards_500bp", "callingcards_intergenic",
		"rossi_mindel", "rossi_500bp", "rossi_intergenic", "rossi_peaks",
		"chec_m2025_mindel", "chec_m2025_500bp", "chec_m2025_intergenic", "chec_m2025_peaks",
	} {
		cfg, ok := bindingConfigs[db]
		require.Truef(t, ok, "missing bindingConfig for variant %q", db)
		require.Equal(t, "sample_id", cfg.SampleCol)
	}
	require.Equal(t, "peak_score", bindingConfigs["rossi_peaks"].RankCol)
	require.False(t, bindingConfigs["rossi_peaks"].RankAsc)
	require.Equal(t, "peak_score", bindingConfigs["chec_m2025_peaks"].RankCol)
	require.True(t, bindingConfigs["callingcards_mindel"].TargetBlackOK)
}

// TestComparisonTopN_RejectsTooManyDatasetPairs pins fix B: selecting many
// datasets produces a B×P pair explosion (up to 24 pairs) that one UNION query
// on the 2-conn pool cannot finish inside the 30s budget, freezing the page and
// starving the site. The handler must reject the request fast with a clear
// message BEFORE running any DB work when pairs exceed the cap.
func TestComparisonTopN_RejectsTooManyDatasetPairs(t *testing.T) {
	s := newTestServer(t)
	s.MaxComparisonPairs = 1 // force a low cap; fixture has 2 binding × 2 pert
	q := url.Values{
		"binding":      {"callingcards,harbison"},
		"perturbation": {"hackett,kemmeren"}, // 2×2 = 4 pairs > 1
	}
	rr := httptest.NewRecorder()
	req := httptest.NewRequest("GET",
		"/api/v/"+s.Manifests.Artifact.ArtifactVersion+"/comparison/topn?"+q.Encode(), nil)
	s.Routes().ServeHTTP(rr, req)
	require.Equal(t, http.StatusBadRequest, rr.Code)
	require.Contains(t, rr.Body.String(), "pairs")
}

// TestComparisonTopN_AllowsWithinCap guards that a normal small comparison
// (1 pair) is not rejected by the cap.
func TestComparisonTopN_AllowsWithinCap(t *testing.T) {
	s := newTestServer(t)
	q := url.Values{"binding": {"callingcards"}, "perturbation": {"hackett"}}
	rr := httptest.NewRecorder()
	req := httptest.NewRequest("GET",
		"/api/v/"+s.Manifests.Artifact.ArtifactVersion+"/comparison/topn?"+q.Encode(), nil)
	s.Routes().ServeHTTP(rr, req)
	require.Equal(t, http.StatusOK, rr.Code)
}

// TestComparisonTopN_NonFiniteThresholdDoesNotPanic500 pins the parseFloatOr
// NaN/Inf guard. strconv.ParseFloat accepts "NaN"/"Inf"/"±Inf" with err==nil; a
// non-finite threshold would flow into domain.TopNResponse (a plain float64
// with no custom marshaller) and make json.Marshal fail with "unsupported
// value: NaN" → a client-triggerable 500 + ERROR log, even on the early-return
// path before any DB work. A non-finite ?effect=/?pvalue= must fall back to the
// default and return 200, never a 5xx.
func TestComparisonTopN_NonFiniteThresholdDoesNotPanic500(t *testing.T) {
	s := newTestServer(t)
	cases := []url.Values{
		{"binding": {"callingcards"}, "perturbation": {"hackett"}, "effect": {"NaN"}},
		{"binding": {"callingcards"}, "perturbation": {"hackett"}, "effect": {"Inf"}},
		{"binding": {"callingcards"}, "perturbation": {"hackett"}, "effect": {"-Inf"}},
		{"binding": {"callingcards"}, "perturbation": {"hackett"}, "pvalue": {"NaN"}},
		{"binding": {"callingcards"}, "perturbation": {"hackett"}, "pvalue": {"+Inf"}},
	}
	for _, q := range cases {
		rr := httptest.NewRecorder()
		req := httptest.NewRequest("GET",
			"/api/v/"+s.Manifests.Artifact.ArtifactVersion+"/comparison/topn?"+q.Encode(), nil)
		s.Routes().ServeHTTP(rr, req)
		require.Equalf(t, http.StatusOK, rr.Code,
			"params %v must fall back to default and 200, not 500", q)
	}
}

// TestResponsivenessPresets_AllHaveStarFallback enforces the invariant the
// cache-key drop in topnCacheCanonEntries relies on: when a preset is set,
// effect/pvalue are dropped from the key because resolveResponsivenessThresholds
// ignores them — which is only sound if every preset can resolve a threshold for
// ANY perturbation dataset via its "*" fallback. A preset missing "*" would make
// the dropped effect/pvalue silently load-bearing for an unlisted dataset, so
// two requests differing only in effect/pvalue would collide on one cache entry.
func TestResponsivenessPresets_AllHaveStarFallback(t *testing.T) {
	require.NotEmpty(t, responsivenessPresets)
	for name, m := range responsivenessPresets {
		_, ok := m["*"]
		require.Truef(t, ok,
			"preset %q must define a \"*\" fallback (the cache-key effect/pvalue drop depends on it)", name)
	}
}

// TestBuildTopNResponse_SemaphoreFullBlocksUntilContextDeadline pins fix A: the
// comparison DB execution is gated by a semaphore so it can never hold both of
// the 2 pool connections. When the semaphore is already taken, a new comparison
// must wait — and honor the request deadline — instead of piling onto the pool.
func TestBuildTopNResponse_SemaphoreFullBlocksUntilContextDeadline(t *testing.T) {
	s := newTestServer(t)
	comparisonSemaphore <- struct{}{}        // occupy the single slot
	defer func() { <-comparisonSemaphore }() // release after the test

	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	start := time.Now()
	_, err := s.buildTopNResponse(ctx, []string{"callingcards"}, []string{"hackett"}, 25, 0.0, 0.05, "", nil)
	require.ErrorIs(t, err, context.DeadlineExceeded)
	require.GreaterOrEqual(t, time.Since(start), 150*time.Millisecond,
		"should have waited on the semaphore until the deadline, not run immediately")
}

// topNCacheKey routes through the PRODUCTION canon construction
// (topnCacheCanonEntries) and the real canonValues/cache.Key path, so the M7
// precedence test guards the handler's actual logic rather than a re-derivation:
// removing or inverting the `preset != ""` guard in topnCacheCanonEntries now
// fails this test instead of only its private copy.
func topNCacheKey(binding, perturbation []string, topN int, effectThr, pvalThr float64, preset, canonFilters string) string {
	canon := canonValues(topnCacheCanonEntries(binding, perturbation, topN, effectThr, pvalThr, preset, canonFilters))
	return cache.Key("v1", "GET", "/comparison/topn", canon)
}

// TestComparisonTopN_PresetCacheKeyPrecedence pins M7: when a known preset is set
// the request's effect/pvalue are ignored for the computation, so two requests
// that share the preset but differ in effect/pvalue MUST collapse to one cache
// key (no fragmentation). With no preset, effect/pvalue are load-bearing and the
// keys MUST differ.
func TestComparisonTopN_PresetCacheKeyPrecedence(t *testing.T) {
	binding := []string{"callingcards"}
	pert := []string{"kemmeren"}

	// With a preset, effect/pvalue must NOT influence the key.
	withPresetA := topNCacheKey(binding, pert, 25, 0.0, 0.05, "Stringent", "")
	withPresetB := topNCacheKey(binding, pert, 25, 0.9, 0.99, "Stringent", "")
	require.Equal(t, withPresetA, withPresetB,
		"same preset + different effect/pvalue must share one cache key (M7: preset overrides effect/pvalue)")

	// With no preset, effect/pvalue ARE load-bearing — keys must differ.
	noPresetA := topNCacheKey(binding, pert, 25, 0.0, 0.05, "", "")
	noPresetB := topNCacheKey(binding, pert, 25, 0.9, 0.99, "", "")
	require.NotEqual(t, noPresetA, noPresetB,
		"no preset + different effect/pvalue must produce distinct cache keys")

	// Sanity: a preset key and a no-preset key are never confused even when the
	// no-preset effect/pvalue happen to match the preset call's nominal values.
	require.NotEqual(t, withPresetA, noPresetA,
		"presence of preset must distinguish the key from the bare effect/pvalue path")
}

// TestComparisonTopN_BindingAndPertConfigCoverage is the M5 tripwire: every
// binding dataset and every perturbation dataset the production manifest knows
// about MUST have an entry in bindingConfigs / pertConfigs. Without this, a
// future variant added to the manifest would be silently dropped by
// keepConfigured() at request time instead of failing CI here.
//
// The canonical dataset list is sourced authoritatively from the same in-memory
// manifest newServerWithFixtureWhitelist builds (base datasets) AND the explicit
// promoter-set variant list below (the 11 variants from the 2026-06-11 parity
// re-audit), so adding a variant to bindingConfigs without registering it here —
// or vice versa — surfaces immediately.
func TestComparisonTopN_BindingAndPertConfigCoverage(t *testing.T) {
	srv := newServerWithFixtureWhitelist(t)

	// The 11 promoter-set variants (2026-06-11 parity re-audit). The base
	// datasets are sourced from the manifest below; these variants are not in
	// the fixture-whitelist manifest, so list them explicitly so the tripwire
	// still guards them.
	variantBinding := []string{
		"callingcards_mindel", "callingcards_500bp", "callingcards_intergenic",
		"rossi_mindel", "rossi_500bp", "rossi_intergenic", "rossi_peaks",
		"chec_m2025_mindel", "chec_m2025_500bp", "chec_m2025_intergenic", "chec_m2025_peaks",
	}

	// Base datasets, sourced authoritatively from the manifest the helper builds.
	bindingDS := append([]string{}, variantBinding...)
	var pertDS []string
	for _, d := range srv.Manifests.Datasets {
		switch d.DataType {
		case "binding":
			bindingDS = append(bindingDS, d.DBName)
		case "perturbation":
			pertDS = append(pertDS, d.DBName)
		default:
			t.Fatalf("manifest dataset %q has unexpected data_type %q", d.DBName, d.DataType)
		}
	}

	for _, b := range bindingDS {
		_, ok := bindingConfigs[b]
		require.Truef(t, ok, "binding dataset %q has no bindingConfig — keepConfigured would silently drop it", b)
	}
	for _, p := range pertDS {
		_, ok := pertConfigs[p]
		require.Truef(t, ok, "perturbation dataset %q has no pertConfig — keepConfigured would silently drop it", p)
	}

	// Explicit promoter-set coverage assertion: all 11 variants are present in
	// bindingConfigs (defense-in-depth on top of the loop above).
	for _, b := range variantBinding {
		_, ok := bindingConfigs[b]
		require.Truef(t, ok, "promoter-set variant %q missing from bindingConfigs", b)
	}
}

// TestComparisonTopN_DegronRendersPadjNotPvalue pins the R-3 latent-bug fix
// (M4-degron) at the SQL-rendering layer: degron carries PValueCol=padj in the
// manifest, so the responsive CASE expression must reference the double-quoted
// `padj` identifier and never the literal `pvalue`. newServerWithFixtureWhitelist
// already wires degron with EffectCol=log2FoldChange / PValueCol=padj. Fixture-
// free: this asserts on the rendered SQL only.
func TestComparisonTopN_DegronRendersPadjNotPvalue(t *testing.T) {
	tmpl := queries.Get("comparison/topn.sql")
	srv := newServerWithFixtureWhitelist(t)
	pcfg := pertConfigs["degron"]

	for _, b := range []string{"callingcards", "harbison"} {
		bcfg := bindingConfigs[b]
		rendered, _, err := srv.buildOnePair(
			tmpl, b, "degron", bcfg, pcfg,
			25, 0.0, 0.05, "", domain.FiltersByDB{},
		)
		require.NoErrorf(t, err, "pair %s/degron", b)
		require.Containsf(t, rendered, `p."padj"`,
			"degron responsive predicate must reference the padj column (double-quoted); got SQL:\n%s", rendered)
		require.NotContainsf(t, rendered, `p."pvalue"`,
			"degron must NOT reference a pvalue column (R-3 fix: pvalue->padj); got SQL:\n%s", rendered)
		// The two-term CASE with log2FoldChange + padj must be present verbatim.
		require.Containsf(t, rendered,
			`CASE WHEN ABS(p."log2FoldChange") > ? AND p."padj" < ? THEN 1 ELSE 0 END`,
			"degron two-term responsive CASE must use log2FoldChange/padj; got SQL:\n%s", rendered)
	}
}

// TestComparisonTopN_IntersectingTargetsExcludesBindingOnlyTarget proves the
// intersecting_targets CTE (M4-intersect): a binding (regulator, target) whose
// target has NO perturbation row — even when it ranks within top_n — is excluded
// from the result, and responsive_ratio is computed over intersecting targets
// only.
//
// Approach chosen (real execution): we open a fresh in-memory DuckDB
// (sql.Open("duckdb", "")) and create minimal binding/perturbation/display
// tables with the EXACT column names the callingcards bindingConfig +
// degron pertConfig expect (sample_id / regulator_locus_tag / target_locus_tag /
// poisson_pval for binding; log2FoldChange / padj for the degron responsive
// expr). We render the pair SQL via the production buildOnePair and execute it
// against the in-memory DB — mirroring buildTopNResponse's own execution path
// (SELECT * FROM (...) wrapper, positional args). A faithful in-memory execution
// IS feasible, so we use it rather than the substring fallback. The CC target
// blacklist placeholders are honored by binding non-blacklisted target tags.
func TestComparisonTopN_IntersectingTargetsExcludesBindingOnlyTarget(t *testing.T) {
	db, err := sql.Open("duckdb", "")
	require.NoError(t, err)
	defer db.Close()

	ctx := context.Background()

	// Minimal schema. callingcards binding ranks by poisson_pval ASC; degron is
	// a non-hackett perturbation (no hackett_analysis_set join needed) carrying
	// log2FoldChange / padj.
	stmts := []string{
		`CREATE TABLE callingcards (
			sample_id VARCHAR,
			regulator_locus_tag VARCHAR,
			target_locus_tag VARCHAR,
			poisson_pval DOUBLE
		)`,
		`CREATE TABLE degron (
			sample_id VARCHAR,
			regulator_locus_tag VARCHAR,
			target_locus_tag VARCHAR,
			log2FoldChange DOUBLE,
			padj DOUBLE,
			responsive INTEGER
		)`,
		`CREATE TABLE regulator_display_names (
			regulator_locus_tag VARCHAR,
			display_name VARCHAR
		)`,
		// Binding: regulator R1 binds three targets. T_SHARED and T_RESP exist in
		// perturbation; T_ONLY is binding-only (no perturbation row) yet ranks #1
		// (smallest poisson_pval) — the pre-fix path would have given it a top_n
		// slot. The intersecting_targets CTE must drop it.
		`INSERT INTO callingcards VALUES
			('B1','R1','T_ONLY',   0.0001),
			('B1','R1','T_SHARED', 0.001),
			('B1','R1','T_RESP',   0.002)`,
		// Perturbation: T_SHARED (not responsive), T_RESP (responsive: big effect,
		// small padj). T_ONLY deliberately absent.
		`INSERT INTO degron VALUES
			('P1','R1','T_SHARED', 0.10, 0.50, 0),
			('P1','R1','T_RESP',   2.00, 0.01, 1)`,
		`INSERT INTO regulator_display_names VALUES ('R1','Reg One')`,
	}
	for _, s := range stmts {
		_, err := db.ExecContext(ctx, s)
		require.NoErrorf(t, err, "ddl: %s", s)
	}

	tmpl := queries.Get("comparison/topn.sql")
	srv := newServerWithFixtureWhitelist(t)
	bcfg := bindingConfigs["callingcards"]
	pcfg := pertConfigs["degron"]

	// top_n=1 so that, pre-fix, the binding-only T_ONLY (rank #1) would steal the
	// only slot. Post-fix the intersecting set is {T_SHARED, T_RESP}, both with
	// rnk <= some cutoff once T_ONLY is removed; use top_n=2 to admit both
	// intersecting targets (T_ONLY excluded purely by the intersect CTE, not by
	// the rank cutoff) so the responsive_ratio over the intersection is well
	// defined.
	pairSQL, args, err := srv.buildOnePair(
		tmpl, "callingcards", "degron", bcfg, pcfg,
		2, 0.0, 0.05, "", domain.FiltersByDB{},
	)
	require.NoError(t, err)

	// Mirror buildTopNResponse's single-pair execution: wrap in SELECT * FROM (...)
	// exactly as the handler assembles each UNION branch.
	full := "SELECT * FROM (" + pairSQL + ")"

	type topNRow struct {
		pairKey              string
		bindingSampleID      string
		regulatorLocusTag    string
		regulatorDisplayName sql.NullString
		perturbationSampleID string
		n                    int64
		nResponsive          int64
		responsiveRatio      float64
	}
	rows, err := db.QueryContext(ctx, full, args...)
	require.NoError(t, err)
	defer rows.Close()

	var got []topNRow
	for rows.Next() {
		var r topNRow
		require.NoError(t, rows.Scan(
			&r.pairKey, &r.bindingSampleID, &r.regulatorLocusTag,
			&r.regulatorDisplayName, &r.perturbationSampleID,
			&r.n, &r.nResponsive, &r.responsiveRatio,
		))
		got = append(got, r)
	}
	require.NoError(t, rows.Err())
	require.Len(t, got, 1, "expected exactly one (sample,regulator) group")

	row := got[0]
	require.Equal(t, "callingcards__degron", row.pairKey)
	// The intersecting targets are {T_SHARED, T_RESP}; T_ONLY is binding-only and
	// MUST be excluded, so n counts 2 targets, not 3.
	require.Equal(t, int64(2), row.n,
		"n must count only intersecting targets (T_SHARED, T_RESP) — T_ONLY excluded")
	require.Equal(t, int64(1), row.nResponsive, "only T_RESP is responsive")
	require.InDelta(t, 0.5, row.responsiveRatio, 1e-9,
		"responsive_ratio = 1 responsive / 2 intersecting targets")
}
