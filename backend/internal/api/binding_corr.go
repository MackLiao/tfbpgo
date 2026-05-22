package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/BrentLab/tfbpshiny-go/backend/internal/cache"
	"github.com/BrentLab/tfbpshiny-go/backend/internal/db"
	"github.com/BrentLab/tfbpshiny-go/backend/internal/domain"
)

// BindingCorr serves /api/v/{v}/binding/corr — per-regulator correlation
// (Pearson or Spearman, raw values or ranks) between every pair drawn from
// `sorted(datasets) choose 2`. Datasets must all be data_type=binding.
//
// Per-pair execution decision: v1 issues one DuckDB query per pair (vs the
// UNION-ALL roundtrip used by Shiny's corr_all_pairs_sql). For N <= 4
// binding datasets that's <= 6 sequential queries; each pair is small
// (per-regulator group, joined on shared targets). Document here so future
// readers know to revisit if cutover load tests show per-handler latency
// regressions — the UNION approach would amortize planner overhead but
// complicates partial-failure handling and DuckDB's TEMP-spill accounting.
func (s *Server) BindingCorr(w http.ResponseWriter, r *http.Request) {
	s.serveCorr(w, r, "binding")
}

// BindingScatter serves /api/v/{v}/binding/scatter — per-target (val_a,
// val_b) for one regulator across one pair of binding datasets. Returns
// a Pearson r computed server-side from the result rows (matches Shiny's
// r=corr(_val_a,_val_b) in workspace.py). For method=spearman, the SQL
// returns ranks → Pearson-on-ranks = Spearman by construction.
func (s *Server) BindingScatter(w http.ResponseWriter, r *http.Request) {
	s.serveScatter(w, r, "binding")
}

// serveCorr is the shared body of BindingCorr and PerturbationCorrelations.
// dataType is "binding" or "perturbation" and selects both (1) the SQL
// template directory and (2) the required Whitelist.Dataset.DataType.
func (s *Server) serveCorr(w http.ResponseWriter, r *http.Request, dataType string) {
	q := r.URL.Query()

	method := q.Get("method")
	if err := validateCorrMethod(method); err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}
	col := q.Get("col")
	if err := validateCorrCol(col); err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}

	dsList, err := dedupeAndCapCSV("datasets", splitCSV(q.Get("datasets")), len(s.Whitelist.AllDatasets()))
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}
	if len(dsList) < 2 {
		writeJSONError(w, http.StatusBadRequest, "datasets requires at least 2 entries")
		return
	}
	for _, name := range dsList {
		if err := s.Whitelist.CheckDataset(name); err != nil {
			writeJSONError(w, http.StatusBadRequest, err.Error())
			return
		}
		row, _ := s.Whitelist.Dataset(name)
		if row.DataType != dataType {
			writeJSONError(w, http.StatusBadRequest,
				fmt.Sprintf("dataset %q is not %s", name, dataType))
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
	// Symmetric with serveScatter: strip regulator_locus_tag from each
	// per-side filter dict BEFORE the field-whitelist check. Shiny's
	// /corr page populates the regulator via a different control than
	// the field-filters dict, so a caller that round-trips the same
	// `filters=` JSON across endpoints would otherwise hit a 400 on
	// CheckField (regulator_locus_tag is a real column but not a
	// field_manifest entry). Mirrors workspace.py:536-540 logic.
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
		"datasets": dsList,
		"method":   method,
		"col":      col,
		"filters":  canonFilters,
	})
	key := cache.Key(s.Manifests.Artifact.ArtifactVersion, r.Method, r.URL.Path, canon)
	body, hit, shared, err := s.Cache.GetOrLoad(r.Context(), key, func() ([]byte, error) {
		return s.buildCorrResponse(r.Context(), dataType, method, col, dsList, filters)
	})
	MarkCacheHit(r.Context(), hit)
	s.recordCacheOutcome(r, hit, shared)
	s.writeCachedJSON(w, r, body, hit, err)
}

// buildCorrResponse runs one corr_pair_{method}.sql per (dbA, dbB) pair drawn
// from sorted(dsList) choose 2. Pairs are appended in stable sorted order so
// the JSON byte body (and therefore the cache value) is deterministic across
// param-ordering permutations.
func (s *Server) buildCorrResponse(
	ctx context.Context,
	dataType, method, col string,
	datasets []string,
	filters domain.FiltersByDB,
) ([]byte, error) {
	resp := domain.CorrResponse{Method: method, Col: col}
	// runPair executes one (dbA, dbB) query. Extracted into a closure so the
	// per-pair `defer cancel()` runs at iteration boundaries — matches the
	// pattern in buildScatterResponse and avoids the loop-local cancel()
	// pitfall where the timeout context outlives its useful scope.
	runPair := func(dbA, dbB string) error {
		rowA, _ := s.Whitelist.Dataset(dbA)
		rowB, _ := s.Whitelist.Dataset(dbB)
		colA, err := resolveMeasurementCol(rowA, col)
		if err != nil {
			return fmt.Errorf("corr pair %s/%s: %w", dbA, dbB, err)
		}
		colB, err := resolveMeasurementCol(rowB, col)
		if err != nil {
			return fmt.Errorf("corr pair %s/%s: %w", dbA, dbB, err)
		}
		extraWhereA, argsA, err := buildSquirrelWhere(filters[dbA])
		if err != nil {
			return fmt.Errorf("corr pair %s/%s: %w", dbA, dbB, err)
		}
		extraWhereB, argsB, err := buildSquirrelWhere(filters[dbB])
		if err != nil {
			return fmt.Errorf("corr pair %s/%s: %w", dbA, dbB, err)
		}
		sqlStr, args := renderCorrPairSQL(method, dataType, pairSpec{
			dbA: dbA, dbB: dbB,
			colA: colA, colB: colB,
			extraWhereA: extraWhereA, extraWhereB: extraWhereB,
			argsA: argsA, argsB: argsB,
		})

		dbCtx, cancel := context.WithTimeout(ctx, db.QueryTimeout)
		defer cancel()
		t0 := time.Now()
		points := []domain.CorrPairPoint{}
		err = s.Pool.DB.SelectContext(dbCtx, &points, sqlStr, args...)
		elapsed := time.Since(t0)
		AddDBMillis(ctx, elapsed.Milliseconds())
		if s.Metrics != nil {
			s.Metrics.DBDuration.
				WithLabelValues(dataType + "/corr_pair_" + method).
				Observe(elapsed.Seconds())
		}
		if err != nil {
			return fmt.Errorf("corr pair %s/%s: %w", dbA, dbB, err)
		}
		resp.Pairs = append(resp.Pairs, domain.CorrPair{
			DBA: dbA, DBB: dbB,
			ColA: colA, ColB: colB,
			Points: points,
		})
		return nil
	}
	for _, pair := range sortedPairs(datasets) {
		if err := runPair(pair[0], pair[1]); err != nil {
			return nil, err
		}
	}
	return json.Marshal(resp)
}

// serveScatter is the shared body of BindingScatter and PerturbationScatter.
func (s *Server) serveScatter(w http.ResponseWriter, r *http.Request, dataType string) {
	q := r.URL.Query()

	regulator := q.Get("regulator")
	if regulator == "" {
		writeJSONError(w, http.StatusBadRequest, "regulator required")
		return
	}
	method := q.Get("method")
	if err := validateCorrMethod(method); err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}
	col := q.Get("col")
	if err := validateCorrCol(col); err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}

	// Do NOT use dedupeAndCapCSV here: self-pairs (e.g. pair=A,A) are a
	// legitimate input shape — they exercise the scatter UI's "compare a
	// dataset to itself" flow and the SQL templates render fine. The
	// raw length cap of 2 already bounds the parameter.
	pair := splitCSV(q.Get("pair"))
	if len(pair) != 2 {
		writeJSONError(w, http.StatusBadRequest, "pair requires exactly 2 dataset entries")
		return
	}
	for _, name := range pair {
		if err := s.Whitelist.CheckDataset(name); err != nil {
			writeJSONError(w, http.StatusBadRequest, err.Error())
			return
		}
		row, _ := s.Whitelist.Dataset(name)
		if row.DataType != dataType {
			writeJSONError(w, http.StatusBadRequest,
				fmt.Sprintf("dataset %q is not %s", name, dataType))
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
	// Strip regulator_locus_tag from per-side filter dicts BEFORE the
	// whitelist-field check. Rationale: scatter binds the regulator as
	// a positional `?` in the SQL template, so it doesn't need (and
	// shouldn't have) a redundant filter clause. `regulator_locus_tag`
	// is a real column on every dataset table, but it isn't an entry
	// in field_manifest (which enumerates user-selectable filters
	// only), so leaving it in the dict would surface as "unknown
	// field" 400 from CheckField. The strip mirrors Shiny's
	// workspace.py:536-540 logic.
	if filters != nil {
		for db := range filters {
			filters[db] = stripRegulatorFilter(filters[db])
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
		// pair is order-sensitive (dbA vs dbB) — preserve the user's order
		// by joining with a delimiter rather than relying on canonValues's
		// []string-sort behavior.
		"pair":    pair[0] + "," + pair[1],
		"method":  method,
		"col":     col,
		"filters": canonFilters,
	})
	key := cache.Key(s.Manifests.Artifact.ArtifactVersion, r.Method, r.URL.Path, canon)
	body, hit, shared, err := s.Cache.GetOrLoad(r.Context(), key, func() ([]byte, error) {
		return s.buildScatterResponse(r.Context(), dataType, method, col, regulator, pair, filters)
	})
	MarkCacheHit(r.Context(), hit)
	s.recordCacheOutcome(r, hit, shared)
	s.writeCachedJSON(w, r, body, hit, err)
}

func (s *Server) buildScatterResponse(
	ctx context.Context,
	dataType, method, col, regulator string,
	pair []string,
	filters domain.FiltersByDB,
) ([]byte, error) {
	dbA, dbB := pair[0], pair[1]
	rowA, _ := s.Whitelist.Dataset(dbA)
	rowB, _ := s.Whitelist.Dataset(dbB)
	colA, err := resolveMeasurementCol(rowA, col)
	if err != nil {
		return nil, fmt.Errorf("scatter %s pair %s/%s: %w", regulator, dbA, dbB, err)
	}
	colB, err := resolveMeasurementCol(rowB, col)
	if err != nil {
		return nil, fmt.Errorf("scatter %s pair %s/%s: %w", regulator, dbA, dbB, err)
	}

	// regulator_locus_tag was already stripped in serveScatter (before the
	// whitelist-field check). We strip again here defensively in case
	// buildScatterResponse is ever called from a path that didn't pre-strip
	// (e.g. a future internal caller). The strip is idempotent and
	// allocation-free when the key is absent.
	fsA := stripRegulatorFilter(filters[dbA])
	fsB := stripRegulatorFilter(filters[dbB])
	extraWhereA, argsA, err := buildSquirrelWhere(fsA)
	if err != nil {
		return nil, fmt.Errorf("scatter %s pair %s/%s: %w", regulator, dbA, dbB, err)
	}
	extraWhereB, argsB, err := buildSquirrelWhere(fsB)
	if err != nil {
		return nil, fmt.Errorf("scatter %s pair %s/%s: %w", regulator, dbA, dbB, err)
	}

	sqlStr, args := renderScatterSQL(method, dataType, regulator, pairSpec{
		dbA: dbA, dbB: dbB,
		colA: colA, colB: colB,
		extraWhereA: extraWhereA, extraWhereB: extraWhereB,
		argsA: argsA, argsB: argsB,
	})

	dbCtx, cancel := context.WithTimeout(ctx, db.QueryTimeout)
	defer cancel()
	t0 := time.Now()
	points := []domain.ScatterPoint{}
	if err := s.Pool.DB.SelectContext(dbCtx, &points, sqlStr, args...); err != nil {
		return nil, fmt.Errorf("scatter %s pair %s/%s: %w", regulator, dbA, dbB, err)
	}
	elapsed := time.Since(t0)
	AddDBMillis(ctx, elapsed.Milliseconds())
	if s.Metrics != nil {
		s.Metrics.DBDuration.
			WithLabelValues(dataType + "/regulator_scatter_" + method).
			Observe(elapsed.Seconds())
	}

	resp := domain.ScatterResponse{
		Regulator: regulator,
		DBA:       dbA,
		DBB:       dbB,
		ColA:      colA,
		ColB:      colB,
		Method:    method,
		R:         pearsonR(points),
		Points:    points,
	}
	return json.Marshal(resp)
}
