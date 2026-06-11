package api

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	sq "github.com/Masterminds/squirrel"

	"github.com/BrentLab/tfbpshiny-go/backend/internal/cache"
	"github.com/BrentLab/tfbpshiny-go/backend/internal/db"
	"github.com/BrentLab/tfbpshiny-go/backend/internal/domain"
	"github.com/BrentLab/tfbpshiny-go/backend/internal/queries"
)

// CCTargetBlacklist mirrors the Python constant CC_TARGET_BLACKLIST.
var CCTargetBlacklist = []string{"YOR201C", "YOR202W", "YOR203W", "YCL018W", "YEL021W"}

// harbisonDedupCTE builds the special-case binding CTE for harbison. An
// optional `extraWhere` (already prefixed with " AND " when non-empty) is
// appended inside the WHERE clause so user-supplied filters apply to the
// dedup step as well — symmetric with the non-harbison branch.
func harbisonDedupCTE(extraWhere string) string {
	return `
SELECT
    CAST(sample_id AS VARCHAR) AS binding_sample_id,
    regulator_locus_tag,
    target_locus_tag,
    MIN(pvalue) AS pvalue
FROM harbison
WHERE condition = 'YPD'` + extraWhere + `
GROUP BY sample_id, regulator_locus_tag, target_locus_tag
`
}

type bindingConfig struct {
	SampleCol     string
	RankCol       string
	RankAsc       bool
	TargetBlackOK bool
	HarbisonDedup bool
}

var bindingConfigs = map[string]bindingConfig{
	"callingcards": {SampleCol: "sample_id", RankCol: "poisson_pval", RankAsc: true, TargetBlackOK: true},
	"harbison":     {SampleCol: "sample_id", RankCol: "pvalue", RankAsc: true, HarbisonDedup: true},
	"chec_m2025":   {SampleCol: "sample_id", RankCol: "enrichment", RankAsc: false},
	"rossi":        {SampleCol: "sample_id", RankCol: "enrichment", RankAsc: false},
}

type pertConfig struct{ HackettTimeFilter bool }

var pertConfigs = map[string]pertConfig{
	"hackett":               {HackettTimeFilter: true},
	"hughes_overexpression": {},
	"hughes_knockout":       {},
	"hu_reimand":            {},
	"kemmeren":              {},
	"degron":                {},
}

func (s *Server) ComparisonTopN(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	maxDS := len(s.Whitelist.AllDatasets())
	bindingDS, err := dedupeAndCapCSV("binding", splitCSV(q.Get("binding")), maxDS)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}
	pertDS, err := dedupeAndCapCSV("perturbation", splitCSV(q.Get("perturbation")), maxDS)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}
	for _, n := range append(append([]string{}, bindingDS...), pertDS...) {
		if err := s.Whitelist.CheckDataset(n); err != nil {
			writeJSONError(w, http.StatusBadRequest, err.Error())
			return
		}
	}
	// C-2 parity: datasets without a TopN config are SKIPPED (with a warning)
	// and the remaining pairs render — matching Shiny's workspace.py, which
	// filters pairs to configured datasets and logs the rest rather than
	// failing the whole request. If nothing configured remains, buildTopNResponse
	// returns an empty result.
	bindingDS = keepConfigured(r, bindingDS, "binding", func(d string) bool {
		_, ok := bindingConfigs[d]
		return ok
	})
	pertDS = keepConfigured(r, pertDS, "perturbation", func(d string) bool {
		_, ok := pertConfigs[d]
		return ok
	})

	// C-5/C-6 parity: top_n clamps to [1, max] (0 -> 1, not the default), and a
	// malformed effect/pvalue silently falls back to the default rather than
	// 400-ing — matching Shiny's permissive sidebar parsing (sidebar.py:45-89).
	topN := clampTopN(q.Get("top_n"), 25)
	effectThr := parseFloatOr(q.Get("effect"), 0.0)
	pvalThr := parseFloatOr(q.Get("pvalue"), 0.05)

	rawFilters := q.Get("filters")
	if err := validateLength("filters", rawFilters, MaxFiltersBytes); err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}
	filters, err := parseFilters(rawFilters)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}
	// P0-2: accept the propagated regulator_locus_tag WHERE field (the
	// common-regulators flow writes it to every active dataset, which then
	// reaches Comparison via the shared ?filters=).
	if err := s.checkFilterFields(filters); err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}

	canonFilters := ""
	if filters != nil {
		b, _ := json.Marshal(filters)
		canonFilters = string(b)
	}
	canon := canonValues(map[string]any{
		"binding":      bindingDS,
		"perturbation": pertDS,
		"top_n":        topN,
		"effect":       effectThr,
		"pvalue":       pvalThr,
		"filters":      canonFilters,
	})
	key := cache.Key(s.Manifests.Artifact.ArtifactVersion, r.Method, r.URL.Path, canon)
	body, hit, shared, err := s.Cache.GetOrLoad(r.Context(), chiRoutePattern(r), key, func(loadCtx context.Context) ([]byte, error) {
		return s.buildTopNResponse(loadCtx, bindingDS, pertDS, topN, effectThr, pvalThr, filters)
	})
	MarkCacheHit(r.Context(), hit)
	s.recordCacheOutcome(r, hit, shared)
	s.writeCachedJSON(w, r, body, hit, err)
}

func (s *Server) buildTopNResponse(
	ctx context.Context,
	bindingDS, pertDS []string,
	topN int, effectThr, pvalThr float64,
	filters domain.FiltersByDB,
) ([]byte, error) {
	tmpl := queries.Get("comparison/topn.sql")
	parts := []string{}
	args := []any{}

	for _, b := range bindingDS {
		bcfg, ok := bindingConfigs[b]
		if !ok {
			return nil, fmt.Errorf("no binding config for %q", b)
		}
		for _, p := range pertDS {
			pcfg, ok := pertConfigs[p]
			if !ok {
				return nil, fmt.Errorf("no perturbation config for %q", p)
			}
			pairSQL, pairArgs, err := s.buildOnePair(tmpl, b, p, bcfg, pcfg, topN, effectThr, pvalThr, filters)
			if err != nil {
				return nil, err
			}
			parts = append(parts, "SELECT * FROM ("+pairSQL+")")
			args = append(args, pairArgs...)
		}
	}
	if len(parts) == 0 {
		return json.Marshal(domain.TopNResponse{TopN: topN, EffectThreshold: effectThr, PValueThreshold: pvalThr})
	}
	full := strings.Join(parts, "\nUNION ALL\n")
	// Deterministic total order over the assembled UNION so the serialized JSON
	// (and version-scoped cache bytes) is a pure function of the inputs and does
	// not flap under preserve_insertion_order=false. pair_key discriminates the
	// per-pair blocks; the remaining columns are that pair's GROUP BY key.
	full += "\nORDER BY pair_key, binding_sample_id, regulator_locus_tag, perturbation_sample_id"
	dbCtx, cancel := context.WithTimeout(ctx, db.QueryTimeout)
	defer cancel()
	t0 := time.Now()
	rows := []domain.TopNRow{}
	if err := s.Pool.DB.SelectContext(dbCtx, &rows, full, args...); err != nil {
		return nil, err
	}
	elapsed := time.Since(t0)
	AddDBMillis(ctx, elapsed.Milliseconds())
	if s.Metrics != nil {
		s.Metrics.DBDuration.WithLabelValues("comparison/topn").Observe(elapsed.Seconds())
	}
	return json.Marshal(domain.TopNResponse{
		TopN: topN, EffectThreshold: effectThr, PValueThreshold: pvalThr, Rows: rows,
	})
}

// buildOnePair instantiates one per-pair SQL block and returns it with its positional args.
func (s *Server) buildOnePair(
	tmpl, bDB, pDB string,
	bcfg bindingConfig, pcfg pertConfig,
	topN int, effectThr, pvalThr float64,
	filters domain.FiltersByDB,
) (string, []any, error) {
	args := []any{}

	// binding CTE body
	var bindingCTE string
	if bcfg.HarbisonDedup {
		// C-1 parity: Shiny sets binding_cte_body = binding_dedup_cte VERBATIM
		// and never calls _build_filter_where for binding in the harbison dedup
		// branch (queries.py:233-234) — the MIN(pvalue) dedup aggregation is
		// incompatible with per-row filters, so filters[harbison] is dropped.
		// Match that exactly (do NOT inject filters[bDB] here).
		bindingCTE = harbisonDedupCTE("")
	} else {
		extra := []string{}
		if bcfg.TargetBlackOK && len(CCTargetBlacklist) > 0 {
			placeholders := strings.Repeat("?,", len(CCTargetBlacklist))
			placeholders = placeholders[:len(placeholders)-1]
			extra = append(extra, "target_locus_tag NOT IN ("+placeholders+")")
			for _, t := range CCTargetBlacklist {
				args = append(args, t)
			}
		}
		bWhere, bArgs, err := buildSquirrelWhereRaw(filters[bDB])
		if err != nil {
			return "", nil, err
		}
		if bWhere != "" {
			extra = append(extra, bWhere)
			args = append(args, bArgs...)
		}
		whereStr := ""
		if len(extra) > 0 {
			whereStr = "WHERE " + strings.Join(extra, " AND ")
		}
		bindingCTE = fmt.Sprintf(
			"SELECT CAST(%s AS VARCHAR) AS binding_sample_id, regulator_locus_tag, target_locus_tag, %s FROM %s %s",
			quotedIdent(bcfg.SampleCol), quotedIdent(bcfg.RankCol), quotedIdent(bDB), whereStr,
		)
	}

	// rank direction
	rankDir := "ASC"
	if !bcfg.RankAsc {
		rankDir = "DESC"
	}

	// SQL placeholder order in topn.sql:
	//   1. binding-CTE args (already appended above)
	//   2. ? for `WHERE rnk <= ?` (top_n_binding CTE)
	//   3. ? placeholders inside {{responsive_expr}}
	//   4. ? placeholders in {{pert_filter_where}}
	args = append(args, topN)

	// responsive expression — depends on perturbation dataset's effect/pvalue cols
	respExpr := buildResponsiveExpr(s, pDB, effectThr, pvalThr, &args)

	// pert filter where.
	//
	// Hackett-filter parity: mirror
	// reference/tfbpshiny/modules/comparison/queries.py:432
	//   p_filters = None if p_cfg.get("hackett_time_filter") else filters.get(p_db)
	// When the perturbation dataset is hackett-shaped (hackett_time_filter=true)
	// Shiny deliberately drops user filters[pDB] from the perturbation CTE —
	// the hackett-analysis-set JOIN already constrains the row set, and
	// applying e.g. a `time` numeric range here would double-filter and
	// produce silently divergent output. See docs/parity/comparison.md §7.2.
	var pertFilters map[string]domain.FilterSpec
	if !pcfg.HackettTimeFilter {
		pertFilters = filters[pDB]
	}
	pWhere, pArgs, err := buildSquirrelWhereRaw(pertFilters)
	if err != nil {
		return "", nil, err
	}
	pertWhereStr := ""
	if pWhere != "" {
		pertWhereStr = "WHERE " + pWhere
	}
	if len(pArgs) > 0 {
		args = append(args, pArgs...)
	}

	pertJoin := ""
	if pcfg.HackettTimeFilter {
		pertJoin = "JOIN hackett_analysis_set has ON CAST(p.sample_id AS VARCHAR) = CAST(has.sample_id AS VARCHAR) AND has.time = 45"
	}

	pairKey := bDB + "__" + pDB
	out := strings.NewReplacer(
		"{{binding_cte_body}}", bindingCTE,
		"{{rank_col}}", quotedIdent(bcfg.RankCol),
		"{{rank_dir}}", rankDir,
		"{{perturbation_view}}", quotedIdent(pDB),
		"{{responsive_expr}}", respExpr,
		"{{pert_join}}", pertJoin,
		"{{pert_filter_where}}", pertWhereStr,
		"{{pair_key}}", pairKey,
	).Replace(tmpl)
	return out, args, nil
}

// buildResponsiveExpr returns the SQL CASE expression that classifies a
// perturbation row as "responsive" given the dataset's effect_col and
// pvalue_col (both sourced from dataset_manifest in schema_version=3+).
//
// Semantics preserved from the previous hard-coded implementation:
//   - both effect_col and pvalue_col non-empty: two-term CASE on
//     ABS(effect) > effThr AND pvalue < pvalThr;
//   - effect_col non-empty, pvalue_col empty (hackett, hughes_*): one-term
//     CASE on ABS(effect) > effThr;
//   - neither set (unknown dataset, defensive): fall back to
//     CAST(p.responsive AS INTEGER) so the SQL still compiles.
func buildResponsiveExpr(s *Server, pDB string, effThr, pvalThr float64, args *[]any) string {
	col := ""
	pvalCol := ""
	// In production code paths the request handler always populates
	// s.Whitelist via newServer(). Tests must wire a real Whitelist via
	// newTestServer / newServerWithFixtureWhitelist; we deliberately do
	// not nil-guard here so a future bare-Server test fails loudly
	// instead of silently taking the responsive-column fallback.
	if row, ok := s.Whitelist.Dataset(pDB); ok {
		col = row.EffectCol
		pvalCol = row.PValueCol
	}
	if col != "" && pvalCol != "" {
		*args = append(*args, effThr, pvalThr)
		// whitelistedIdent re-verifies col / pvalCol against SafeIdentRE
		// at SQL-interpolation time. This is defense in depth on top of
		// the manifest-load gate in db.NewWhitelist (F1).
		return fmt.Sprintf(
			"CASE WHEN ABS(p.%s) > ? AND p.%s < ? THEN 1 ELSE 0 END",
			quotedIdent(col), quotedIdent(pvalCol),
		)
	}
	if col != "" {
		*args = append(*args, effThr)
		return fmt.Sprintf(
			"CASE WHEN ABS(p.%s) > ? THEN 1 ELSE 0 END",
			quotedIdent(col),
		)
	}
	return "CAST(p.responsive AS INTEGER)"
}

// buildSquirrelWhereRaw returns "field = ? AND ..." (no leading WHERE/AND), args.
func buildSquirrelWhereRaw(fs map[string]domain.FilterSpec) (string, []any, error) {
	if len(fs) == 0 {
		return "", nil, nil
	}
	and := sq.And{}
	for field, spec := range fs {
		// quotedIdent is the SQL-build-time tripwire: callers must have
		// checkFilterFields'd every filter field, but if a future handler
		// forgets, an un-whitelisted identifier panics here instead of
		// reaching SQL.
		col := quotedIdent(field)
		switch spec.Type {
		case "categorical":
			var vals []string
			if err := json.Unmarshal(spec.Value, &vals); err != nil {
				return "", nil, err
			}
			and = append(and, sq.Eq{col: vals})
		case "numeric":
			var rng [2]float64
			if err := json.Unmarshal(spec.Value, &rng); err != nil {
				return "", nil, err
			}
			// C-3/SQL-4 parity: TRY_CAST the column to DOUBLE before the range
			// compare (queries.py:129-134) — the metadata columns are stored as
			// VARCHAR, so a bare `>=`/`<=` does a lexicographic compare. Squirrel
			// treats the map key as a raw column expression.
			expr := `TRY_CAST(` + col + ` AS DOUBLE)`
			and = append(and, sq.GtOrEq{expr: rng[0]})
			and = append(and, sq.LtOrEq{expr: rng[1]})
		case "bool":
			var b bool
			if err := json.Unmarshal(spec.Value, &b); err != nil {
				return "", nil, err
			}
			and = append(and, sq.Eq{col: b})
		default:
			return "", nil, fmt.Errorf("filter %q: unknown type %q", field, spec.Type)
		}
	}
	return and.ToSql()
}

// keepConfigured returns the subset of `datasets` that pass `configured`,
// emitting a structured warning for each dropped dataset (C-2: skip
// unconfigured datasets rather than 400 the whole request, matching Shiny).
func keepConfigured(r *http.Request, datasets []string, side string, configured func(string) bool) []string {
	kept := make([]string, 0, len(datasets))
	for _, d := range datasets {
		if configured(d) {
			kept = append(kept, d)
			continue
		}
		slog.WarnContext(r.Context(), "comparison_topn_skip_unconfigured",
			"dataset", d, "side", side)
	}
	return kept
}
