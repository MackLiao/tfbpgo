package api

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"strings"
	"time"

	"github.com/BrentLab/tfbpshiny-go/backend/internal/cache"
	"github.com/BrentLab/tfbpshiny-go/backend/internal/db"
	"github.com/BrentLab/tfbpshiny-go/backend/internal/domain"
)

// correlationSemaphore serializes the all-pairs correlation DB execution
// shared by /binding/corr and /perturbation/correlations (both run through
// buildCorrResponse). The all-pairs query is one UNION-ALL over C(N,2) self-join
// + corr() branches — heavy and single-DuckDB-query — so without this a single
// broad correlation (e.g. all 6 perturbation datasets = 15 branches) would hold
// a pool connection for its whole duration; two concurrent ones would take both
// of the 2 pool connections and starve the rest of the site. Size 1 leaves one
// connection free at all times. Mirrors comparisonSemaphore / exportSemaphore.
var correlationSemaphore = make(chan struct{}, 1)

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
	body, hit, shared, err := s.Cache.GetOrLoad(r.Context(), chiRoutePattern(r), key, func(loadCtx context.Context) ([]byte, error) {
		return s.buildCorrResponse(loadCtx, dataType, method, col, dsList, filters)
	})
	MarkCacheHit(r.Context(), hit)
	s.recordCacheOutcome(r, hit, shared)
	s.writeCachedJSON(w, r, body, hit, err)
}

// buildCorrResponse renders ONE UNION-ALL query over every (dbA, dbB) pair
// in sorted(dsList) choose 2 and executes it as a single SelectContext call.
// Each inner per-pair SQL is the existing corr_pair_{method}.sql template;
// the outer wrapper projects an extra `pair_key = '{db_a}__{db_b}'` column
// that the Go handler partitions on after the result lands.
//
// Why one query: with MaxOpenConns=2 on a t3.small, N=4 active datasets used
// to mean 6 sequential DB roundtrips (and a singleflight-held cache slot
// blocking other waiters for the duration). One UNION-ALL is what Shiny's
// corr_all_pairs_sql does — see
// reference/tfbpshiny/modules/binding/queries.py:331-390. Cache HIT path is
// unchanged; this only affects cold-cache requests.
//
// Pairs are emitted in stable sorted (i < j) order so the JSON byte body —
// and therefore the cache value — is deterministic across param-ordering
// permutations of the input CSV.
func (s *Server) buildCorrResponse(
	ctx context.Context,
	dataType, method, col string,
	datasets []string,
	filters domain.FiltersByDB,
) ([]byte, error) {
	resp := domain.CorrResponse{Method: method, Col: col}
	pairOrder := sortedPairs(datasets)
	if len(pairOrder) == 0 {
		// Defensive: serveCorr enforces len(datasets) >= 2 so this branch
		// is unreachable in production. Returning an empty pairs array
		// keeps the wire shape consistent if a future caller bypasses
		// validation.
		return json.Marshal(resp)
	}

	// Pre-resolve every per-pair piece (col/extraWhere/args). Each step can
	// still fail individually (manifest miss, malformed filter) — wrap with
	// pair context so the structured log stays actionable.
	specs := make([]pairSpec, 0, len(pairOrder))
	pairCols := make([][2]string, 0, len(pairOrder)) // (colA, colB) for the response envelope
	for _, pair := range pairOrder {
		dbA, dbB := pair[0], pair[1]
		rowA, _ := s.Whitelist.Dataset(dbA)
		rowB, _ := s.Whitelist.Dataset(dbB)
		colA, err := resolveMeasurementCol(rowA, col)
		if err != nil {
			return nil, fmt.Errorf("corr pair %s/%s: %w", dbA, dbB, err)
		}
		colB, err := resolveMeasurementCol(rowB, col)
		if err != nil {
			return nil, fmt.Errorf("corr pair %s/%s: %w", dbA, dbB, err)
		}
		extraWhereA, argsA, err := buildSquirrelWhere(filters[dbA])
		if err != nil {
			return nil, fmt.Errorf("corr pair %s/%s: %w", dbA, dbB, err)
		}
		extraWhereB, argsB, err := buildSquirrelWhere(filters[dbB])
		if err != nil {
			return nil, fmt.Errorf("corr pair %s/%s: %w", dbA, dbB, err)
		}
		specs = append(specs, pairSpec{
			dbA: dbA, dbB: dbB,
			colA: colA, colB: colB,
			extraWhereA: extraWhereA, extraWhereB: extraWhereB,
			argsA: argsA, argsB: argsB,
		})
		pairCols = append(pairCols, [2]string{colA, colB})
	}

	sqlStr, args := renderCorrUnionAllSQL(method, dataType, specs)

	dbCtx, cancel := context.WithTimeout(ctx, db.QueryTimeout)
	defer cancel()

	// Serialize the heavy all-pairs correlation DB execution so it can never
	// hold both pool connections (correlation analogue of comparison Fix A).
	// Honor the request deadline while waiting rather than piling onto the pool.
	select {
	case correlationSemaphore <- struct{}{}:
		defer func() { <-correlationSemaphore }()
	case <-dbCtx.Done():
		return nil, dbCtx.Err()
	}

	t0 := time.Now()
	rows := []domain.CorrPairPointWithKey{}
	err := s.Pool.DB.SelectContext(dbCtx, &rows, sqlStr, args...)
	elapsed := time.Since(t0)
	AddDBMillis(ctx, elapsed.Milliseconds())
	if s.Metrics != nil {
		// Single observation labelled "corr_union_{method}" so the
		// per-pair vs UNION-ALL transition is visible in metrics
		// (separate label space from the legacy "corr_pair_{method}").
		s.Metrics.DBDuration.
			WithLabelValues(dataType + "/corr_union_" + method).
			Observe(elapsed.Seconds())
	}
	if err != nil {
		return nil, fmt.Errorf("corr union (%d pairs): %w", len(specs), err)
	}

	// Partition by pair_key. Build an index from key → response slot so we
	// preserve sorted(datasets)-choose-2 order in resp.Pairs regardless of
	// the row order DuckDB returns from the UNION-ALL.
	keyToSlot := make(map[string]int, len(specs))
	resp.Pairs = make([]domain.CorrPair, len(specs))
	for i, sp := range specs {
		key := sp.dbA + "__" + sp.dbB
		keyToSlot[key] = i
		resp.Pairs[i] = domain.CorrPair{
			DBA: sp.dbA, DBB: sp.dbB,
			ColA: pairCols[i][0], ColB: pairCols[i][1],
			Points: []domain.CorrPairPoint{},
		}
	}
	for _, row := range rows {
		slot, ok := keyToSlot[row.PairKey]
		if !ok {
			// Should be impossible — every row's pair_key was emitted by
			// our own outer SELECT projection. Treat as data corruption.
			return nil, fmt.Errorf("corr union: unexpected pair_key %q", row.PairKey)
		}
		// DuckDB corr() returns NaN on a zero-variance group (constant values
		// on either side → covariance/stddev 0/0); the SQL filters NaN/Inf
		// *inputs* but not the *output*. Drop those rows — mirrors the Python
		// reference's df.dropna(subset=["correlation"]) (workspace.py:274) and
		// keeps the response JSON-serializable (encoding/json rejects NaN/Inf).
		if math.IsNaN(row.Correlation) || math.IsInf(row.Correlation, 0) {
			continue
		}
		resp.Pairs[slot].Points = append(resp.Pairs[slot].Points, row.CorrPairPoint)
	}

	// B-2/P-4: attach the regulator display-name map for the regulators that
	// actually appear in the response, so the frontend can label + sort the
	// picker and hovers by gene symbol (Shiny's sym_map).
	dm, err := s.regulatorDisplayMap(ctx, distinctCorrRegulators(resp.Pairs))
	if err != nil {
		return nil, fmt.Errorf("corr regulator display map: %w", err)
	}
	resp.RegulatorDisplay = dm

	return json.Marshal(resp)
}

// distinctCorrRegulators collects the unique regulator_locus_tag values across
// every pair's points, in first-seen order.
func distinctCorrRegulators(pairs []domain.CorrPair) []string {
	seen := map[string]struct{}{}
	out := []string{}
	for _, p := range pairs {
		for _, pt := range p.Points {
			if _, ok := seen[pt.RegulatorLocusTag]; ok {
				continue
			}
			seen[pt.RegulatorLocusTag] = struct{}{}
			out = append(out, pt.RegulatorLocusTag)
		}
	}
	return out
}

// regulatorDisplayMap looks up "SYMBOL (LOCUS_TAG)" display names for the given
// locus tags from regulator_display_names (B-2/P-4). Returns an empty (non-nil)
// map for no tags. Tags absent from the table are simply omitted. Values are
// passed as positional bind args (never interpolated), so the IN-list is safe.
func (s *Server) regulatorDisplayMap(ctx context.Context, tags []string) (map[string]string, error) {
	out := make(map[string]string, len(tags))
	if len(tags) == 0 {
		return out, nil
	}
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(tags)), ",")
	q := "SELECT regulator_locus_tag, display_name FROM regulator_display_names " +
		"WHERE regulator_locus_tag IN (" + placeholders + ")"
	args := make([]any, len(tags))
	for i, t := range tags {
		args[i] = t
	}
	dbCtx, cancel := context.WithTimeout(ctx, db.QueryTimeout)
	defer cancel()
	var rows []struct {
		Tag     string `db:"regulator_locus_tag"`
		Display string `db:"display_name"`
	}
	if err := s.Pool.DB.SelectContext(dbCtx, &rows, q, args...); err != nil {
		return nil, err
	}
	for _, r := range rows {
		out[r.Tag] = r.Display
	}
	return out, nil
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
	body, hit, shared, err := s.Cache.GetOrLoad(r.Context(), chiRoutePattern(r), key, func(loadCtx context.Context) ([]byte, error) {
		return s.buildScatterResponse(loadCtx, dataType, method, col, regulator, pair, filters)
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

	// log10pval display transform (BIND-3/PERT-1): for col=log10pval the scatter
	// shows -log10(p), with each side transformed per its own dataset's source
	// column. Applied ONLY for Pearson — Spearman scatter values are RANK()
	// integers, to which the transform does not apply (reference branches on the
	// same condition: workspace.py:1175-1185). Done BEFORE pearsonR so the
	// returned `r` matches the reference, which computes r on the transformed
	// series (workspace.py:1190). Correlation inputs in /corr stay UNtransformed.
	if col == "log10pval" && method != "spearman" {
		transformScatterPoints(points, log10pSourceFor(rowA), log10pSourceFor(rowB))
	}

	resp := domain.ScatterResponse{
		Regulator: regulator,
		DBA:       dbA,
		DBB:       dbB,
		ColA:      colA,
		ColB:      colB,
		Method:    method,
		R:         domain.SafeFloat(pearsonR(points)),
		Points:    points,
	}
	return json.Marshal(resp)
}
