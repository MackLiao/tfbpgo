package api

// TODO: happy-path tests land in Task 21 (parity) once fixtures with
// production columns (poisson_pval, harbison, etc.) exist.

import (
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/BrentLab/tfbpshiny-go/backend/internal/db"
	"github.com/BrentLab/tfbpshiny-go/backend/internal/domain"
	"github.com/BrentLab/tfbpshiny-go/backend/internal/queries"
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
			{DBName: "degron", DataType: "perturbation", EffectCol: "log2FoldChange", PValueCol: "pvalue"},
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
			25, 0.0, 0.05, domain.FiltersByDB{},
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
// TestComparisonTopN_HarbisonAppliesFilters pins the H2 fix: when the
// dedup branch fires for harbison, user-supplied filter values must still
// surface as positional args in the rendered SQL, matching the
// non-harbison branch. Before the fix, filters[harbison] was silently
// dropped.
func TestComparisonTopN_HarbisonAppliesFilters(t *testing.T) {
	tmpl := queries.Get("comparison/topn.sql")
	srv := newServerWithFixtureWhitelist(t)
	bcfg := bindingConfigs["harbison"]
	pcfg := pertConfigs["kemmeren"]

	filters := domain.FiltersByDB{
		"harbison": map[string]domain.FilterSpec{
			"pvalue": {Type: "numeric", Value: []byte(`[0, 0.01]`)},
		},
	}
	rendered, args, err := srv.buildOnePair(
		tmpl, "harbison", "kemmeren", bcfg, pcfg,
		25, 0.0, 0.05, filters,
	)
	require.NoError(t, err)
	require.NotEmpty(t, args)
	// The filter `pvalue BETWEEN 0 AND 0.01` injects two numeric args
	// (the GtOrEq lower bound and the LtOrEq upper bound) inside the
	// harbison dedup CTE.
	require.True(t,
		strings.Contains(rendered, `"pvalue"`),
		"rendered SQL must reference pvalue from filters: %s", rendered)
	got := strings.Count(stripSQLComments(rendered), "?")
	require.Equal(t, len(args), got,
		"args count must match placeholders after H2 fix")
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
		25, 0.0, 0.05, filters,
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
				25, 0.0, 0.05, domain.FiltersByDB{},
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
		25, 0.0, 0.05, domain.FiltersByDB{},
	)
	require.NoError(t, err)
	require.Contains(t,
		rendered,
		`CASE WHEN ABS(p."Madj") > ? AND p."pval" < ? THEN 1 ELSE 0 END`,
	)
}
