package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/BrentLab/tfbpshiny-go/backend/internal/cache"
	"github.com/BrentLab/tfbpshiny-go/backend/internal/db"
	"github.com/BrentLab/tfbpshiny-go/backend/internal/domain"
	"github.com/BrentLab/tfbpshiny-go/backend/internal/queries"
)

var pertMeasurementColumn = map[string]string{
	"degron":                "log2FoldChange",
	"hughes_overexpression": "mean_norm_log2fc",
	"hughes_knockout":       "mean_norm_log2fc",
	"kemmeren":              "Madj",
	"hackett":               "log2_shrunken_timecourses",
	"hu_reimand":            "effect",
}

func (s *Server) Perturbation(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	regulator := q.Get("regulator")
	if regulator == "" {
		http.Error(w, `{"error":"regulator required"}`, http.StatusBadRequest)
		return
	}
	dsList, err := dedupeAndCapCSV("datasets", splitCSV(q.Get("datasets")), len(s.Whitelist.AllDatasets()))
	if err != nil {
		http.Error(w, fmt.Sprintf(`{"error":%q}`, err.Error()), http.StatusBadRequest)
		return
	}
	for _, name := range dsList {
		if err := s.Whitelist.CheckDataset(name); err != nil {
			http.Error(w, fmt.Sprintf(`{"error":%q}`, err.Error()), http.StatusBadRequest)
			return
		}
		row, _ := s.Whitelist.Dataset(name)
		if row.DataType != "perturbation" {
			http.Error(w, fmt.Sprintf(`{"error":"dataset %q is not perturbation"}`, name), http.StatusBadRequest)
			return
		}
	}

	rawFilters := q.Get("filters")
	if err := validateLength("filters", rawFilters, MaxFiltersBytes); err != nil {
		http.Error(w, fmt.Sprintf(`{"error":%q}`, err.Error()), http.StatusBadRequest)
		return
	}
	filters, err := parseFilters(rawFilters)
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
		return s.buildPerturbationResponse(r.Context(), regulator, dsList, filters)
	})
	MarkCacheHit(r.Context(), hit)
	s.recordCacheOutcome(r, hit, shared)
	s.writeCachedJSON(w, r, body, hit, err)
}

func (s *Server) buildPerturbationResponse(ctx context.Context, reg string, datasets []string, filters domain.FiltersByDB) ([]byte, error) {
	tmpl := queries.Get("perturbation/data.sql")
	resp := domain.PerturbationResponse{Regulator: reg}
	for _, ds := range datasets {
		col, ok := pertMeasurementColumn[ds]
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
		rows := []domain.PerturbationRow{}
		err = s.Pool.DB.SelectContext(dbCtx, &rows, sqlStr, append([]any{reg}, args...)...)
		cancel()
		AddDBMillis(ctx, time.Since(t0).Milliseconds())
		if err != nil {
			return nil, err
		}
		resp.Datasets = append(resp.Datasets, domain.PerturbationDatasetResult{DBName: ds, Column: col, Rows: rows})
	}
	return json.Marshal(resp)
}
