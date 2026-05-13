package api

// TODO: happy-path tests land in Task 21 (parity) once fixtures with
// production columns (poisson_pval, harbison, etc.) exist.

import (
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/BrentLab/tfbpshiny-go/backend/internal/domain"
	"github.com/BrentLab/tfbpshiny-go/backend/internal/queries"
	"github.com/stretchr/testify/require"
)

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
	srv := &Server{}

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
func TestComparisonTopN_PlaceholderCountInvariant_AllPairs(t *testing.T) {
	tmpl := queries.Get("comparison/topn.sql")
	srv := &Server{}

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
