package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	sq "github.com/Masterminds/squirrel"

	"github.com/BrentLab/tfbpshiny-go/backend/internal/cache"
	"github.com/BrentLab/tfbpshiny-go/backend/internal/db"
	"github.com/BrentLab/tfbpshiny-go/backend/internal/domain"
	"github.com/BrentLab/tfbpshiny-go/backend/internal/queries"
)

// bindingMeasurementColumn mirrors DATASET_COLUMNS in the Python module.
// Phase 1 hard-codes this; a follow-up plan moves it into dataset_manifest.
var bindingMeasurementColumn = map[string]string{
	"callingcards": "callingcards_enrichment",
	"harbison":     "effect",
	"rossi":        "enrichment",
	"chec_m2025":   "enrichment",
}

func (s *Server) Binding(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	regulator := q.Get("regulator")
	if regulator == "" {
		http.Error(w, `{"error":"regulator required"}`, http.StatusBadRequest)
		return
	}
	dsList := splitCSV(q.Get("datasets"))
	for _, name := range dsList {
		if err := s.Whitelist.CheckDataset(name); err != nil {
			http.Error(w, fmt.Sprintf(`{"error":%q}`, err.Error()), http.StatusBadRequest)
			return
		}
		row, _ := s.Whitelist.Dataset(name)
		if row.DataType != "binding" {
			http.Error(w, fmt.Sprintf(`{"error":"dataset %q is not binding"}`, name), http.StatusBadRequest)
			return
		}
	}

	filters, err := parseFilters(q.Get("filters"))
	if err != nil {
		http.Error(w, fmt.Sprintf(`{"error":%q}`, err.Error()), http.StatusBadRequest)
		return
	}
	for dbName, fs := range filters {
		for fld := range fs {
			if err := s.Whitelist.CheckField(dbName, fld); err != nil {
				http.Error(w, fmt.Sprintf(`{"error":%q}`, err.Error()), http.StatusBadRequest)
				return
			}
		}
	}

	key := cache.Key(s.Manifests.Artifact.ArtifactVersion, r.Method, r.URL.Path, r.URL.Query())
	body, hit, shared, err := s.Cache.GetOrLoad(r.Context(), key, func() ([]byte, error) {
		return s.buildBindingResponse(r.Context(), regulator, dsList, filters)
	})
	MarkCacheHit(r.Context(), hit)
	s.recordCacheOutcome(r, hit, shared)
	s.writeCachedJSON(w, r, body, hit, err)
}

func (s *Server) buildBindingResponse(ctx context.Context, reg string, datasets []string, filters domain.FiltersByDB) ([]byte, error) {
	tmpl := queries.Get("binding/data.sql")
	resp := domain.BindingResponse{Regulator: reg}
	for _, ds := range datasets {
		col, ok := bindingMeasurementColumn[ds]
		if !ok {
			return nil, fmt.Errorf("no measurement column mapped for dataset %q", ds)
		}
		extraWhere, args, err := buildSquirrelWhere(filters[ds])
		if err != nil {
			return nil, err
		}
		sqlStr := strings.NewReplacer(
			"{{table}}", quoteIdent(ds),
			"{{col}}", quoteIdent(col),
			"{{extra_where}}", extraWhere,
		).Replace(tmpl)

		dbCtx, cancel := context.WithTimeout(ctx, db.QueryTimeout)
		t0 := time.Now()
		rows := []domain.BindingRow{}
		err = s.Pool.DB.SelectContext(dbCtx, &rows, sqlStr, append([]any{reg}, args...)...)
		cancel()
		AddDBMillis(ctx, time.Since(t0).Milliseconds())
		if err != nil {
			return nil, err
		}
		resp.Datasets = append(resp.Datasets, domain.BindingDatasetResult{DBName: ds, Column: col, Rows: rows})
	}
	return json.Marshal(resp)
}

// quoteIdent does NOT escape — caller MUST have already whitelisted.
func quoteIdent(s string) string { return s }

func buildSquirrelWhere(fs map[string]domain.FilterSpec) (string, []any, error) {
	if len(fs) == 0 {
		return "", nil, nil
	}
	and := sq.And{}
	for field, spec := range fs {
		switch spec.Type {
		case "categorical":
			var vals []string
			if err := json.Unmarshal(spec.Value, &vals); err != nil {
				return "", nil, fmt.Errorf("filter %q: %w", field, err)
			}
			and = append(and, sq.Eq{`"` + field + `"`: vals})
		case "numeric":
			var rng [2]float64
			if err := json.Unmarshal(spec.Value, &rng); err != nil {
				return "", nil, fmt.Errorf("filter %q: %w", field, err)
			}
			and = append(and, sq.And{
				sq.GtOrEq{`"` + field + `"`: rng[0]},
				sq.LtOrEq{`"` + field + `"`: rng[1]},
			})
		case "bool":
			var b bool
			if err := json.Unmarshal(spec.Value, &b); err != nil {
				return "", nil, fmt.Errorf("filter %q: %w", field, err)
			}
			and = append(and, sq.Eq{`"` + field + `"`: b})
		default:
			return "", nil, fmt.Errorf("filter %q: unknown type %q", field, spec.Type)
		}
	}
	sqlStr, args, err := and.ToSql()
	if err != nil {
		return "", nil, err
	}
	return " AND (" + sqlStr + ")", args, nil
}

func splitCSV(s string) []string {
	if s == "" {
		return nil
	}
	parts := strings.Split(s, ",")
	out := parts[:0]
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}

func parseFilters(raw string) (domain.FiltersByDB, error) {
	if raw == "" {
		return nil, nil
	}
	var out domain.FiltersByDB
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		return nil, fmt.Errorf("filters: %w", err)
	}
	return out, nil
}
