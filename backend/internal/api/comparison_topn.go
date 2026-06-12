package api

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"sort"
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

// defaultMaxComparisonPairs bounds the (binding × perturbation) pairs one
// /comparison/topn request may compute when Server.MaxComparisonPairs is unset.
// With 4 binding × 6 perturbation configured, the unbounded max is 24 pairs in
// a single UNION query — far past the 30s budget on the 2-conn pool.
const defaultMaxComparisonPairs = 12

// comparisonSemaphore serializes the comparison/topn DB execution so a heavy
// multi-pair query can never occupy both of the 2 pool connections at once,
// leaving one connection for the rest of the site (mirrors exportSemaphore).
var comparisonSemaphore = make(chan struct{}, 1)

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

// bindingConfigs is the verbatim Go mirror of reference BINDING_CONFIGS
// (comparison/queries.py). The promoter-set variants (2026-06-11 parity
// re-audit) re-use their parent's rank column/direction; the `_peaks` variants
// rank by the original-authors' `peak_score` (higher = stronger, so DESC).
// Without these entries keepConfigured() silently drops variant pairs.
var bindingConfigs = map[string]bindingConfig{
	"callingcards":            {SampleCol: "sample_id", RankCol: "poisson_pval", RankAsc: true, TargetBlackOK: true},
	"callingcards_mindel":     {SampleCol: "sample_id", RankCol: "poisson_pval", RankAsc: true, TargetBlackOK: true},
	"callingcards_500bp":      {SampleCol: "sample_id", RankCol: "poisson_pval", RankAsc: true, TargetBlackOK: true},
	"callingcards_intergenic": {SampleCol: "sample_id", RankCol: "poisson_pval", RankAsc: true, TargetBlackOK: true},
	"harbison":                {SampleCol: "sample_id", RankCol: "pvalue", RankAsc: true, HarbisonDedup: true},
	"chec_m2025":              {SampleCol: "sample_id", RankCol: "enrichment", RankAsc: false},
	"chec_m2025_mindel":       {SampleCol: "sample_id", RankCol: "enrichment", RankAsc: false},
	"chec_m2025_500bp":        {SampleCol: "sample_id", RankCol: "enrichment", RankAsc: false},
	"chec_m2025_intergenic":   {SampleCol: "sample_id", RankCol: "enrichment", RankAsc: false},
	"chec_m2025_peaks":        {SampleCol: "sample_id", RankCol: "peak_score", RankAsc: false},
	"rossi":                   {SampleCol: "sample_id", RankCol: "enrichment", RankAsc: false},
	"rossi_mindel":            {SampleCol: "sample_id", RankCol: "enrichment", RankAsc: false},
	"rossi_500bp":             {SampleCol: "sample_id", RankCol: "enrichment", RankAsc: false},
	"rossi_intergenic":        {SampleCol: "sample_id", RankCol: "enrichment", RankAsc: false},
	"rossi_peaks":             {SampleCol: "sample_id", RankCol: "peak_score", RankAsc: false},
}

// responsivenessPresets mirrors reference DEFAULT_RESPONSIVENESS_PRESETS
// (vdb_init.py). Each preset maps a perturbation db_name to its
// (effectThreshold, pvalueThreshold); "*" is the fallback for datasets not
// listed. "Relaxed" is the reference default and equals the Go service's
// historical hard-coded (0.0, 0.05), so an unset ?preset= is unchanged.
var responsivenessPresets = map[string]map[string][2]float64{
	"Stringent": {
		"*":                     {1.0, 0.05},
		"degron":                {0.38, 0.1},
		"hackett":               {0.0, 1.0},
		"kemmeren":              {0.77, 0.05},
		"hu_reimand":            {0.0, 0.05},
		"hughes_overexpression": {1.0, 1.0},
		"hughes_knockout":       {1.0, 1.0},
	},
	"Relaxed": {
		"*":       {0.0, 0.05},
		"hackett": {0.0, 1.0},
	},
}

// resolveResponsivenessThresholds returns the (effect, pvalue) thresholds for a
// perturbation dataset. With a known preset, the per-dataset author thresholds
// win (falling back to the preset's "*"). With no/unknown preset, the request's
// numeric effect/pvalue are used uniformly (back-compat / Relaxed-equivalent).
func resolveResponsivenessThresholds(preset, pDB string, defEffect, defPval float64) (float64, float64) {
	m, ok := responsivenessPresets[preset]
	if !ok {
		return defEffect, defPval
	}
	if t, ok := m[pDB]; ok {
		return t[0], t[1]
	}
	if t, ok := m["*"]; ok {
		return t[0], t[1]
	}
	return defEffect, defPval
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

	// Fix B: reject the (binding × perturbation) pair explosion before any DB
	// work. Each pair is a heavy ranking branch in one UNION query on the
	// 2-conn pool; too many blow past the 30s budget, return nothing, and (with
	// the loader's WithoutCancel) keep running even after the client gives up —
	// starving the whole site. Fail fast with a clear, actionable message.
	maxPairs := s.MaxComparisonPairs
	if maxPairs <= 0 {
		maxPairs = defaultMaxComparisonPairs
	}
	if pairs := len(bindingDS) * len(pertDS); pairs > maxPairs {
		writeJSONError(w, http.StatusBadRequest, fmt.Sprintf(
			"too many comparisons: %d binding×perturbation pairs requested (max %d) — select fewer binding or perturbation datasets",
			pairs, maxPairs))
		return
	}

	// C-5/C-6 parity: top_n clamps to [1, max] (0 -> 1, not the default), and a
	// malformed effect/pvalue silently falls back to the default rather than
	// 400-ing — matching Shiny's permissive sidebar parsing (sidebar.py:45-89).
	topN := clampTopN(q.Get("top_n"), 25)
	effectThr := parseFloatOr(q.Get("effect"), 0.0)
	pvalThr := parseFloatOr(q.Get("pvalue"), 0.05)
	// CMP-4/CMP-5: an explicit responsiveness preset (Relaxed/Stringent) selects
	// per-dataset author thresholds. An unknown/empty value falls through to the
	// numeric effect/pvalue above (matching the historical, Relaxed-equivalent
	// behavior), so this is backward compatible.
	preset := q.Get("preset")
	if _, ok := responsivenessPresets[preset]; !ok {
		preset = ""
	}

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
	// M7: preset overrides effect/pvalue. When a known preset is set,
	// resolveResponsivenessThresholds IGNORES the request's numeric
	// effect/pvalue (the per-dataset author thresholds win), so two requests
	// differing only in effect/pvalue but sharing a preset compute identical
	// results. Keeping effect/pvalue in the cache key would fragment those into
	// distinct entries (one DB hit per (effect,pvalue) permutation for the same
	// answer). Drop them from the key when preset != ""; keep them otherwise.
	canon := canonValues(topnCacheCanonEntries(bindingDS, pertDS, topN, effectThr, pvalThr, preset, canonFilters))
	key := cache.Key(s.Manifests.Artifact.ArtifactVersion, r.Method, r.URL.Path, canon)
	body, hit, shared, err := s.Cache.GetOrLoad(r.Context(), chiRoutePattern(r), key, func(loadCtx context.Context) ([]byte, error) {
		return s.buildTopNResponse(loadCtx, bindingDS, pertDS, topN, effectThr, pvalThr, preset, filters)
	})
	MarkCacheHit(r.Context(), hit)
	s.recordCacheOutcome(r, hit, shared)
	s.writeCachedJSON(w, r, body, hit, err)
}

// topnCacheCanonEntries builds the canonical cache-key entries for a /comparison/topn
// request. M7: when a known preset is set, resolveResponsivenessThresholds ignores the
// request's numeric effect/pvalue (the per-dataset author thresholds win), so two
// requests differing only in effect/pvalue but sharing a preset compute identical
// results. Keeping effect/pvalue in the key would fragment those into distinct cache
// entries (one DB hit per (effect,pvalue) permutation for the same answer), so they are
// dropped when preset != "" and retained (load-bearing) otherwise. This is the SINGLE
// source of truth for the precedence: ComparisonTopN and the M7 precedence test both
// call it, so a regression to the guard fails the test instead of only the test's copy.
func topnCacheCanonEntries(
	bindingDS, pertDS []string,
	topN int, effectThr, pvalThr float64, preset, canonFilters string,
) map[string]any {
	canonEntries := map[string]any{
		"binding":      bindingDS,
		"perturbation": pertDS,
		"top_n":        topN,
		"preset":       preset,
		"filters":      canonFilters,
	}
	if preset == "" {
		canonEntries["effect"] = effectThr
		canonEntries["pvalue"] = pvalThr
	}
	return canonEntries
}

func (s *Server) buildTopNResponse(
	ctx context.Context,
	bindingDS, pertDS []string,
	topN int, effectThr, pvalThr float64, preset string,
	filters domain.FiltersByDB,
) ([]byte, error) {
	tmpl := queries.Get("comparison/topn.sql")

	// Enumerate the (binding, perturbation) pairs and sort by pair_key. Each
	// pair is executed + cached SEPARATELY rather than fused into one big
	// UNION ALL. Two reasons:
	//   1. Memory/speed: the combined UNION accumulated every pair's hash tables
	//      + window sorts at once and SPILLED to disk on the real artifact (a
	//      4-pair request took ~4.7s at memory_limit=800MB vs ~1.4s for the four
	//      pairs run separately — ~3x). Per-pair execution caps peak memory at a
	//      single pair's working set, so it does not spill regardless of the
	//      memory_limit.
	//   2. Cache hit rate: a per-pair cache key (scoped to that pair's two
	//      datasets + thresholds) lets overlapping requests reuse already-computed
	//      pairs — the Compare-Datasets matrix and the variant tabs, or
	//      adding/removing a single dataset, no longer trigger a full re-miss.
	// Sorting by pair_key here, plus a per-pair ORDER BY on the remaining columns
	// (in loadOnePairRows), reproduces the previous single-UNION global
	// `ORDER BY pair_key, binding_sample_id, regulator_locus_tag,
	// perturbation_sample_id` byte-for-byte.
	type pairRef struct{ b, p, key string }
	pairs := make([]pairRef, 0, len(bindingDS)*len(pertDS))
	for _, b := range bindingDS {
		if _, ok := bindingConfigs[b]; !ok {
			return nil, fmt.Errorf("no binding config for %q", b)
		}
		for _, p := range pertDS {
			if _, ok := pertConfigs[p]; !ok {
				return nil, fmt.Errorf("no perturbation config for %q", p)
			}
			pairs = append(pairs, pairRef{b: b, p: p, key: b + "__" + p})
		}
	}
	if len(pairs) == 0 {
		return json.Marshal(domain.TopNResponse{TopN: topN, EffectThreshold: effectThr, PValueThreshold: pvalThr})
	}
	sort.Slice(pairs, func(i, j int) bool { return pairs[i].key < pairs[j].key })

	// One absolute deadline shared across all pairs preserves the per-request
	// 30s DB budget (each per-pair load re-applies it after the cache layer
	// strips cancellation via context.WithoutCancel). Honor an earlier deadline
	// already on ctx, matching the previous WithTimeout(ctx, QueryTimeout).
	deadline := time.Now().Add(db.QueryTimeout)
	if d, ok := ctx.Deadline(); ok && d.Before(deadline) {
		deadline = d
	}

	rows := make([]domain.TopNRow, 0, len(pairs)*topN)
	for _, pr := range pairs {
		pairRows, err := s.loadOnePairRows(ctx, deadline, tmpl, pr.b, pr.p, topN, effectThr, pvalThr, preset, filters)
		if err != nil {
			return nil, err
		}
		rows = append(rows, pairRows...)
	}
	return json.Marshal(domain.TopNResponse{
		TopN: topN, EffectThreshold: effectThr, PValueThreshold: pvalThr, Rows: rows,
	})
}

// loadOnePairRows returns the topn rows for ONE (binding, perturbation) pair,
// cached under a per-pair key so overlapping multi-pair requests reuse
// already-computed pairs instead of a full whole-response re-miss. The pair is
// run as a standalone query (not a UNION branch) so it carries its own ORDER BY
// and keeps peak memory to a single pair's working set. The cache key + the SQL
// are scoped to just this pair's two datasets (buildOnePair only ever reads
// filters[b]/filters[p]), maximising cross-request reuse.
func (s *Server) loadOnePairRows(
	ctx context.Context, deadline time.Time, tmpl, b, p string,
	topN int, effectThr, pvalThr float64, preset string,
	filters domain.FiltersByDB,
) ([]domain.TopNRow, error) {
	bcfg := bindingConfigs[b]
	pcfg := pertConfigs[p]

	pairFilters := domain.FiltersByDB{}
	if f, ok := filters[b]; ok {
		pairFilters[b] = f
	}
	if f, ok := filters[p]; ok {
		pairFilters[p] = f
	}
	pairCanonFilters := ""
	if len(pairFilters) > 0 {
		bb, _ := json.Marshal(pairFilters)
		pairCanonFilters = string(bb)
	}
	canon := canonValues(topnCacheCanonEntries([]string{b}, []string{p}, topN, effectThr, pvalThr, preset, pairCanonFilters))
	key := cache.Key(s.Manifests.Artifact.ArtifactVersion, "GET", "/comparison/topn#pair", canon)

	body, _, _, err := s.Cache.GetOrLoad(ctx, "comparison/topn-pair", key, func(loadCtx context.Context) ([]byte, error) {
		pairSQL, pairArgs, err := s.buildOnePair(tmpl, b, p, bcfg, pcfg, topN, effectThr, pvalThr, preset, pairFilters)
		if err != nil {
			return nil, err
		}
		// Standalone pair query → its own ORDER BY (the previous combined query
		// could not, since ORDER BY inside a UNION branch is a syntax error). The
		// keys match the old global order's trailing columns; buildTopNResponse
		// concatenates pairs in pair_key order, reproducing it exactly.
		pairSQL = "SELECT * FROM (" + pairSQL + ") ORDER BY binding_sample_id, regulator_locus_tag, perturbation_sample_id"

		dbCtx, cancel := context.WithDeadline(loadCtx, deadline)
		defer cancel()
		// Serialize comparison DB execution (one connection at most) so a heavy
		// pair can never occupy both pool connections; honor the deadline while
		// waiting rather than queueing on the pool.
		select {
		case comparisonSemaphore <- struct{}{}:
			defer func() { <-comparisonSemaphore }()
		case <-dbCtx.Done():
			return nil, dbCtx.Err()
		}
		t0 := time.Now()
		rows := []domain.TopNRow{}
		if err := s.Pool.DB.SelectContext(dbCtx, &rows, pairSQL, pairArgs...); err != nil {
			return nil, err
		}
		elapsed := time.Since(t0)
		AddDBMillis(loadCtx, elapsed.Milliseconds())
		if s.Metrics != nil {
			s.Metrics.DBDuration.WithLabelValues("comparison/topn").Observe(elapsed.Seconds())
		}
		return json.Marshal(rows)
	})
	if err != nil {
		return nil, err
	}
	rows := []domain.TopNRow{}
	if err := json.Unmarshal(body, &rows); err != nil {
		return nil, err
	}
	return rows, nil
}

// buildOnePair instantiates one per-pair SQL block and returns it with its positional args.
func (s *Server) buildOnePair(
	tmpl, bDB, pDB string,
	bcfg bindingConfig, pcfg pertConfig,
	topN int, effectThr, pvalThr float64, preset string,
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

	// SQL placeholder order in topn.sql (the perturbation CTE now precedes
	// top_n_binding because of the intersect-before-rank reorder):
	//   1. binding-CTE args (already appended above)
	//   2. ? placeholders inside {{responsive_expr}}
	//   3. ? placeholders in {{pert_filter_where}}
	//   4. ? for `WHERE rnk <= ?` (top_n_binding CTE) — appended last, below.

	// responsive expression — thresholds resolve per perturbation dataset: a
	// known ?preset= (Relaxed/Stringent) selects the per-dataset author
	// thresholds (CMP-4/CMP-5); with no preset the request's numeric
	// effect/pvalue apply uniformly (historical, == Relaxed).
	eff, pval := resolveResponsivenessThresholds(preset, pDB, effectThr, pvalThr)
	respExpr := buildResponsiveExpr(s, pDB, eff, pval, &args)

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

	// top_n cutoff is the LAST placeholder: top_n_binding now sits below the
	// perturbation CTE in topn.sql (intersect-before-rank reorder).
	args = append(args, topN)

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
