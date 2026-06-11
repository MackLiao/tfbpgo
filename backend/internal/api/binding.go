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

// The measurement column for each binding dataset is sourced from
// dataset_manifest.effect_col (schema_version=3+). The previous Go-side
// bindingMeasurementColumn map was removed in Phase 1.6 — see
// data_prep.manifests.DATASET_MEASUREMENT_COLUMNS for the canonical list.

func (s *Server) Binding(w http.ResponseWriter, r *http.Request) {
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
		if row.DataType != "binding" {
			writeJSONError(w, http.StatusBadRequest, fmt.Sprintf("dataset %q is not binding", name))
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

	// Canonicalize the cache key from only the inputs that drive the
	// response, post-validation. This prevents cache fragmentation from
	// param ordering (datasets=A,B vs B,A) and blocks junk-key fuzzing.
	canonFilters := ""
	if filters != nil {
		// Re-marshal so semantically equal filter JSON with different key
		// orderings hashes to the same cache key — Go's encoding/json
		// emits map keys sorted.
		b, _ := json.Marshal(filters)
		canonFilters = string(b)
	}
	canon := canonValues(map[string]any{
		"regulator": regulator,
		"datasets":  dsList,
		"filters":   canonFilters,
	})
	key := cache.Key(s.Manifests.Artifact.ArtifactVersion, r.Method, r.URL.Path, canon)
	body, hit, shared, err := s.Cache.GetOrLoad(r.Context(), chiRoutePattern(r), key, func(loadCtx context.Context) ([]byte, error) {
		return s.buildBindingResponse(loadCtx, regulator, dsList, filters)
	})
	MarkCacheHit(r.Context(), hit)
	s.recordCacheOutcome(r, hit, shared)
	s.writeCachedJSON(w, r, body, hit, err)
}

func (s *Server) buildBindingResponse(ctx context.Context, reg string, datasets []string, filters domain.FiltersByDB) ([]byte, error) {
	tmpl := queries.Get("binding/data.sql")
	resp := domain.BindingResponse{Regulator: reg}
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
		rows := []domain.BindingRow{}
		err = s.Pool.DB.SelectContext(dbCtx, &rows, sqlStr, append([]any{reg}, args...)...)
		cancel()
		elapsed := time.Since(t0)
		AddDBMillis(ctx, elapsed.Milliseconds())
		if s.Metrics != nil {
			s.Metrics.DBDuration.WithLabelValues("binding/data").Observe(elapsed.Seconds())
		}
		if err != nil {
			return nil, err
		}
		resp.Datasets = append(resp.Datasets, domain.BindingDatasetResult{DBName: ds, Column: col, Rows: rows})
	}
	return json.Marshal(resp)
}

func buildSquirrelWhere(fs map[string]domain.FilterSpec) (string, []any, error) {
	if len(fs) == 0 {
		return "", nil, nil
	}
	and := sq.And{}
	for field, spec := range fs {
		// quotedIdent is the SQL-build-time tripwire: callers must have
		// CheckField'd every filter field, but if a future handler forgets,
		// an un-whitelisted identifier panics here instead of reaching SQL.
		col := quotedIdent(field)
		switch spec.Type {
		case "categorical":
			var vals []string
			if err := json.Unmarshal(spec.Value, &vals); err != nil {
				return "", nil, fmt.Errorf("filter %q: %w", field, err)
			}
			and = append(and, sq.Eq{col: vals})
		case "numeric":
			var rng [2]float64
			if err := json.Unmarshal(spec.Value, &rng); err != nil {
				return "", nil, fmt.Errorf("filter %q: %w", field, err)
			}
			// SQL-4 parity: TRY_CAST to DOUBLE before the range compare
			// (Shiny queries.py:111-115) — metadata columns are VARCHAR-stored,
			// so a bare >=/<= would compare lexicographically.
			expr := `TRY_CAST(` + col + ` AS DOUBLE)`
			and = append(and, sq.And{
				sq.GtOrEq{expr: rng[0]},
				sq.LtOrEq{expr: rng[1]},
			})
		case "bool":
			var b bool
			if err := json.Unmarshal(spec.Value, &b); err != nil {
				return "", nil, fmt.Errorf("filter %q: %w", field, err)
			}
			and = append(and, sq.Eq{col: b})
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

// validFilterTypes is the closed set of legal FilterSpec.Type values. Any
// other value at parse time is a client-side malformed request and must
// surface as a 400 — never reach the SQL builder where it would otherwise
// surface as a 500 from the cache loader.
var validFilterTypes = map[string]struct{}{
	"categorical": {},
	"numeric":     {},
	"bool":        {},
}

func parseFilters(raw string) (domain.FiltersByDB, error) {
	if raw == "" {
		return nil, nil
	}
	var out domain.FiltersByDB
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		return nil, fmt.Errorf("filters: %w", err)
	}
	for ds, fields := range out {
		for fld, spec := range fields {
			if _, ok := validFilterTypes[spec.Type]; !ok {
				return nil, fmt.Errorf("filters[%s][%s]: unknown type %q", ds, fld, spec.Type)
			}
		}
	}
	return out, nil
}
