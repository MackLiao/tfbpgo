package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
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

// HarbisonDedupCTE is the special-case binding CTE for harbison.
const HarbisonDedupCTE = `
SELECT
    CAST(sample_id AS VARCHAR) AS binding_sample_id,
    regulator_locus_tag,
    target_locus_tag,
    MIN(pvalue) AS pvalue
FROM harbison
WHERE condition = 'YPD'
GROUP BY sample_id, regulator_locus_tag, target_locus_tag
`

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
	bindingDS := splitCSV(q.Get("binding"))
	pertDS := splitCSV(q.Get("perturbation"))
	for _, n := range append(append([]string{}, bindingDS...), pertDS...) {
		if err := s.Whitelist.CheckDataset(n); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
	}
	// Validate dataset is configured for topn (binding vs perturbation map).
	for _, b := range bindingDS {
		if _, ok := bindingConfigs[b]; !ok {
			http.Error(w, fmt.Sprintf("no binding config for %q", b), http.StatusBadRequest)
			return
		}
	}
	for _, p := range pertDS {
		if _, ok := pertConfigs[p]; !ok {
			http.Error(w, fmt.Sprintf("no perturbation config for %q", p), http.StatusBadRequest)
			return
		}
	}

	topN := atoiOr(q.Get("top_n"), 25)
	effectThr, _ := strconv.ParseFloat(orDefault(q.Get("effect"), "0.0"), 64)
	pvalThr, _ := strconv.ParseFloat(orDefault(q.Get("pvalue"), "0.05"), 64)

	filters, err := parseFilters(q.Get("filters"))
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	for ds, fs := range filters {
		for fld := range fs {
			if err := s.Whitelist.CheckField(ds, fld); err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
		}
	}

	key := cache.Key(s.Manifests.Artifact.ArtifactVersion, r.Method, r.URL.Path, q)
	body, hit, err := s.Cache.GetOrLoad(r.Context(), key, func() ([]byte, error) {
		return s.buildTopNResponse(r.Context(), bindingDS, pertDS, topN, effectThr, pvalThr, filters)
	})
	MarkCacheHit(r.Context(), hit)
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
	dbCtx, cancel := context.WithTimeout(ctx, db.QueryTimeout)
	defer cancel()
	t0 := time.Now()
	rows := []domain.TopNRow{}
	if err := s.Pool.DB.SelectContext(dbCtx, &rows, full, args...); err != nil {
		return nil, err
	}
	AddDBMillis(ctx, time.Since(t0).Milliseconds())
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
		bindingCTE = HarbisonDedupCTE
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
			bcfg.SampleCol, bcfg.RankCol, bDB, whereStr,
		)
	}

	// rank direction
	rankDir := "ASC"
	if !bcfg.RankAsc {
		rankDir = "DESC"
	}

	// responsive expression — depends on perturbation dataset's effect/pvalue cols
	respExpr := buildResponsiveExpr(pDB, effectThr, pvalThr, &args)

	// pert filter where
	pWhere, pArgs, err := buildSquirrelWhereRaw(filters[pDB])
	if err != nil {
		return "", nil, err
	}
	pertWhereStr := ""
	if pWhere != "" {
		pertWhereStr = "WHERE " + pWhere
	}

	pertJoin := ""
	if pcfg.HackettTimeFilter {
		pertJoin = "JOIN hackett_analysis_set has ON CAST(p.sample_id AS VARCHAR) = CAST(has.sample_id AS VARCHAR) AND has.time = 45"
	}

	// top_n is the only ? not yet appended
	args = append(args, topN)
	// then the bound args from the pert WHERE
	if len(pArgs) > 0 {
		args = append(args, pArgs...)
	}

	pairKey := bDB + "__" + pDB
	out := strings.NewReplacer(
		"{{binding_cte_body}}", bindingCTE,
		"{{rank_col}}", bcfg.RankCol,
		"{{rank_dir}}", rankDir,
		"{{perturbation_view}}", pDB,
		"{{responsive_expr}}", respExpr,
		"{{pert_join}}", pertJoin,
		"{{pert_filter_where}}", pertWhereStr,
		"{{pair_key}}", pairKey,
	).Replace(tmpl)
	return out, args, nil
}

func buildResponsiveExpr(pDB string, effThr, pvalThr float64, args *[]any) string {
	col := pertMeasurementColumn[pDB]
	pvalCol := ""
	switch pDB {
	case "degron":
		pvalCol = "pvalue"
	case "kemmeren":
		pvalCol = "pval"
	case "hu_reimand":
		pvalCol = "pval"
	}
	if col != "" && pvalCol != "" {
		*args = append(*args, effThr, pvalThr)
		return fmt.Sprintf("CASE WHEN ABS(p.%s) > ? AND p.%s < ? THEN 1 ELSE 0 END", col, pvalCol)
	}
	if col != "" {
		*args = append(*args, effThr)
		return fmt.Sprintf("CASE WHEN ABS(p.%s) > ? THEN 1 ELSE 0 END", col)
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
		switch spec.Type {
		case "categorical":
			var vals []string
			if err := json.Unmarshal(spec.Value, &vals); err != nil {
				return "", nil, err
			}
			and = append(and, sq.Eq{`"` + field + `"`: vals})
		case "numeric":
			var rng [2]float64
			if err := json.Unmarshal(spec.Value, &rng); err != nil {
				return "", nil, err
			}
			and = append(and, sq.GtOrEq{`"` + field + `"`: rng[0]})
			and = append(and, sq.LtOrEq{`"` + field + `"`: rng[1]})
		case "bool":
			var b bool
			if err := json.Unmarshal(spec.Value, &b); err != nil {
				return "", nil, err
			}
			and = append(and, sq.Eq{`"` + field + `"`: b})
		}
	}
	return and.ToSql()
}

func atoiOr(s string, d int) int {
	if v, err := strconv.Atoi(s); err == nil {
		return v
	}
	return d
}

func orDefault(s, d string) string {
	if s == "" {
		return d
	}
	return s
}
