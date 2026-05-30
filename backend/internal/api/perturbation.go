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

// The measurement column for each perturbation dataset is sourced from
// dataset_manifest.effect_col (schema_version=3+). The previous Go-side
// pertMeasurementColumn map was removed in Phase 1.6 — see
// data_prep.manifests.DATASET_MEASUREMENT_COLUMNS for the canonical list.

func (s *Server) Perturbation(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	regulator := q.Get("regulator")
	if regulator == "" {
		writeJSONError(w, http.StatusBadRequest, "regulator required")
		return
	}
	dsList, err := dedupeAndCapCSV("datasets", splitCSV(q.Get("datasets")), len(s.Whitelist.AllDatasets()))
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}
	for _, name := range dsList {
		if err := s.Whitelist.CheckDataset(name); err != nil {
			writeJSONError(w, http.StatusBadRequest, err.Error())
			return
		}
		row, _ := s.Whitelist.Dataset(name)
		if row.DataType != "perturbation" {
			writeJSONError(w, http.StatusBadRequest, fmt.Sprintf("dataset %q is not perturbation", name))
			return
		}
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
	// The data tab is scoped by the `regulator` param, not by a filter; strip
	// any regulator_locus_tag the common-regulators flow propagated via the
	// shared ?filters= (mirrors the /corr handlers) so it neither 400s the
	// field-check nor double-constrains the query.
	if filters != nil {
		for dbName := range filters {
			filters[dbName] = stripRegulatorFilter(filters[dbName])
		}
	}
	for dbName, fs := range filters {
		for fld := range fs {
			if err := s.Whitelist.CheckField(dbName, fld); err != nil {
				writeJSONError(w, http.StatusBadRequest, err.Error())
				return
			}
		}
	}

	canonFilters := ""
	if filters != nil {
		b, _ := json.Marshal(filters)
		canonFilters = string(b)
	}
	canon := canonValues(map[string]any{
		"regulator": regulator,
		"datasets":  dsList,
		"filters":   canonFilters,
	})
	key := cache.Key(s.Manifests.Artifact.ArtifactVersion, r.Method, r.URL.Path, canon)
	body, hit, shared, err := s.Cache.GetOrLoad(r.Context(), chiRoutePattern(r), key, func() ([]byte, error) {
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
		row, ok := s.Whitelist.Dataset(ds)
		if !ok || row.EffectCol == "" {
			return nil, fmt.Errorf("no effect_col in manifest for dataset %q", ds)
		}
		col := row.EffectCol
		extraWhere, args, err := buildSquirrelWhere(filters[ds])
		if err != nil {
			return nil, err
		}
		sqlStr := strings.NewReplacer(
			"{{table}}", quotedIdent(ds),
			"{{col}}", quotedIdent(col),
			"{{extra_where}}", extraWhere,
		).Replace(tmpl)

		dbCtx, cancel := context.WithTimeout(ctx, db.QueryTimeout)
		t0 := time.Now()
		rows := []domain.PerturbationRow{}
		err = s.Pool.DB.SelectContext(dbCtx, &rows, sqlStr, append([]any{reg}, args...)...)
		cancel()
		elapsed := time.Since(t0)
		AddDBMillis(ctx, elapsed.Milliseconds())
		if s.Metrics != nil {
			s.Metrics.DBDuration.WithLabelValues("perturbation/data").Observe(elapsed.Seconds())
		}
		if err != nil {
			return nil, err
		}
		resp.Datasets = append(resp.Datasets, domain.PerturbationDatasetResult{DBName: ds, Column: col, Rows: rows})
	}
	return json.Marshal(resp)
}
