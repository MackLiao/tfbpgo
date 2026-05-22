package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/BrentLab/tfbpshiny-go/backend/internal/cache"
	"github.com/BrentLab/tfbpshiny-go/backend/internal/db"
	"github.com/BrentLab/tfbpshiny-go/backend/internal/domain"
	"github.com/BrentLab/tfbpshiny-go/backend/internal/queries"
)

// fieldTypeOverrides mirrors reference/tfbpshiny/modules/select_datasets/queries.py:17-20.
// (db_name, field) pairs that should be exposed as categorical regardless of
// their raw DB type. The Shiny code uses a tuple key whose first element may
// be the empty string to mean "any dataset"; the Go map only supports exact
// matches, which is sufficient for the parity-driving case (hackett.time) —
// extend if more wildcard overrides are required.
var fieldTypeOverrides = map[[2]string]string{
	{"hackett", "time"}: "categorical",
}

// fieldIntrospection is the lazily-populated, per-Server cache of column
// metadata derived from DESCRIBE on the actual table. Keyed by (db_name,
// field). Computed once and shared across requests for the lifetime of the
// Server (artifact is immutable, schema cannot change underneath us).
type fieldIntrospection struct {
	// table is the actual underlying table the column lives in
	// ("{db}" or "{db}_meta"). Used by the numeric-range aggregate.
	table string
	// dbType is the DuckDB column type ("VARCHAR", "DOUBLE", "INTEGER", ...).
	dbType string
}

// fieldIntrospectCache memoizes the (db, field) -> fieldIntrospection map per
// Server. Sentinel "not found" entries are stored as fieldIntrospection{} so a
// missing column doesn't get re-queried on every request.
type fieldIntrospectCache struct {
	mu sync.Mutex
	m  map[[2]string]fieldIntrospection
}

// fieldNumericRange memoizes computed MIN/MAX for numeric fields per Server.
type fieldNumericRange struct {
	min *float64
	max *float64
}

type fieldNumericRangeCache struct {
	mu sync.Mutex
	m  map[[2]string]fieldNumericRange
}

// introspectField returns the column type and the table the column lives in.
// Looks up `{db}` first, falling back to `{db}_meta`. Returns ok=false when
// neither table contains the column.
func (s *Server) introspectField(ctx context.Context, dbName, field string) (fieldIntrospection, bool, error) {
	key := [2]string{dbName, field}

	s.initIntrospect()
	s.fieldIntrospect.mu.Lock()
	if v, ok := s.fieldIntrospect.m[key]; ok {
		s.fieldIntrospect.mu.Unlock()
		return v, v.table != "", nil
	}
	s.fieldIntrospect.mu.Unlock()

	// Probe the two candidate tables. Both names are already whitelisted by
	// the manifest gate; whitelistedIdent is the per-request tripwire.
	tables := []string{whitelistedIdent(dbName), whitelistedIdent(dbName) + "_meta"}
	var found fieldIntrospection
	for _, t := range tables {
		row := struct {
			Name string `db:"column_name"`
			Type string `db:"data_type"`
		}{}
		// information_schema.columns: parameterized by table_name + column_name.
		// DuckDB exposes the column type as `data_type` (not `column_type`,
		// which is the PRAGMA-style projection); see the SHOW/DESCRIBE
		// asymmetry in DuckDB's catalog views.
		dbCtx, cancel := context.WithTimeout(ctx, db.QueryTimeout)
		err := s.Pool.DB.GetContext(dbCtx, &row,
			`SELECT column_name, data_type FROM information_schema.columns WHERE table_name = ? AND column_name = ? LIMIT 1`,
			t, field,
		)
		cancel()
		if err == nil {
			found = fieldIntrospection{table: t, dbType: row.Type}
			break
		}
	}

	s.fieldIntrospect.mu.Lock()
	s.fieldIntrospect.m[key] = found
	s.fieldIntrospect.mu.Unlock()

	return found, found.table != "", nil
}

func (s *Server) initIntrospect() {
	s.introspectInitOnce.Do(func() {
		s.fieldIntrospect = &fieldIntrospectCache{m: map[[2]string]fieldIntrospection{}}
		s.fieldNumeric = &fieldNumericRangeCache{m: map[[2]string]fieldNumericRange{}}
	})
}

// WarmIntrospectionCache populates the per-(db, field) type cache for every
// entry in s.Manifests.Fields. Call once at startup after manifests are
// loaded. Subsequent introspectField calls become pure map lookups under
// the existing mutex — no DB I/O, no race on cold misses.
//
// The lazy introspectField path remains a correctness fallback: if warming
// fails for any individual (db, field) pair (e.g. a manifest entry whose
// table is temporarily unavailable), the request path will retry. We
// intentionally swallow per-entry failures here so a single malformed
// row doesn't block startup.
func (s *Server) WarmIntrospectionCache(ctx context.Context) error {
	s.initIntrospect()
	for _, f := range s.Manifests.Fields {
		// ignore individual failures so a malformed (db, field) doesn't
		// block startup; introspectField will retry on the request path.
		_, _, _ = s.introspectField(ctx, f.DBName, f.Field)
	}
	return nil
}

// kindForDBType classifies a DuckDB type string into one of
// "categorical" | "numeric" | "bool" using the same buckets the Shiny modal
// uses. The override map takes precedence (hackett.time → categorical).
func kindForDBType(dbName, field, dbType string) string {
	if k, ok := fieldTypeOverrides[[2]string{dbName, field}]; ok {
		return k
	}
	t := strings.ToUpper(dbType)
	// Strip parameterized type suffix like DECIMAL(10,2).
	if idx := strings.Index(t, "("); idx > 0 {
		t = t[:idx]
	}
	switch t {
	case "BOOLEAN", "BOOL":
		return "bool"
	case "VARCHAR", "TEXT", "STRING", "CHAR", "ENUM", "UUID":
		return "categorical"
	case "INTEGER", "BIGINT", "SMALLINT", "TINYINT",
		"UINTEGER", "UBIGINT", "USMALLINT", "UTINYINT", "HUGEINT",
		"DOUBLE", "FLOAT", "REAL", "DECIMAL", "NUMERIC":
		return "numeric"
	default:
		// Fall back to categorical for unknown / DATE / TIME / BLOB types —
		// matches Shiny's behavior of rendering them as selectize entries.
		return "categorical"
	}
}

// computeNumericRange runs `SELECT MIN, MAX FROM table` for the field and
// memoizes the result per Server. Returns nil pointers when the table is
// empty / all-null.
func (s *Server) computeNumericRange(ctx context.Context, dbName, field, table string) (fieldNumericRange, error) {
	s.initIntrospect()
	key := [2]string{dbName, field}

	s.fieldNumeric.mu.Lock()
	if v, ok := s.fieldNumeric.m[key]; ok {
		s.fieldNumeric.mu.Unlock()
		return v, nil
	}
	s.fieldNumeric.mu.Unlock()

	// Identifiers are already whitelisted. Use TRY_CAST to DOUBLE so an
	// INTEGER-typed column overridden to categorical (hackett.time) won't
	// flow through here anyway — we only call this for Kind=numeric.
	// Pattern is consistent with binding.go's identifier interpolation:
	// whitelistedIdent is the per-request SafeIdentRE tripwire, defense in
	// depth on top of the manifest gate.
	fieldIdent := whitelistedIdent(field)
	tableIdent := whitelistedIdent(table)
	sqlStr := fmt.Sprintf(
		`SELECT MIN(CAST(%[1]s AS DOUBLE)) AS lo, MAX(CAST(%[1]s AS DOUBLE)) AS hi FROM %[2]s`,
		fieldIdent, tableIdent,
	)
	dbCtx, cancel := context.WithTimeout(ctx, db.QueryTimeout)
	defer cancel()
	t0 := time.Now()
	row := struct {
		Lo *float64 `db:"lo"`
		Hi *float64 `db:"hi"`
	}{}
	if err := s.Pool.DB.GetContext(dbCtx, &row, sqlStr); err != nil {
		return fieldNumericRange{}, err
	}
	elapsed := time.Since(t0)
	AddDBMillis(ctx, elapsed.Milliseconds())
	if s.Metrics != nil {
		s.Metrics.DBDuration.WithLabelValues("select_datasets/field_range").Observe(elapsed.Seconds())
	}

	out := fieldNumericRange{min: row.Lo, max: row.Hi}
	s.fieldNumeric.mu.Lock()
	s.fieldNumeric.m[key] = out
	s.fieldNumeric.mu.Unlock()
	return out, nil
}

// --- Handler 1: GET /api/v/{v}/datasets/{db}/fields ------------------------

func (s *Server) DatasetFields(w http.ResponseWriter, r *http.Request) {
	dbName := chi.URLParam(r, "db")
	if err := s.Whitelist.CheckDataset(dbName); err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}

	// Cache key: no query params drive the response, so the canonical
	// component is empty.
	key := cache.Key(s.Manifests.Artifact.ArtifactVersion, r.Method, r.URL.Path, nil)
	body, hit, shared, err := s.Cache.GetOrLoad(r.Context(), key, func() ([]byte, error) {
		return s.buildDatasetFieldsResponse(r.Context(), dbName)
	})
	MarkCacheHit(r.Context(), hit)
	s.recordCacheOutcome(r, hit, shared)
	s.writeCachedJSON(w, r, body, hit, err)
}

func (s *Server) buildDatasetFieldsResponse(ctx context.Context, dbName string) ([]byte, error) {
	// Gather fields + roles from the manifest for this dataset only.
	type fld struct {
		name string
		role string
	}
	var flds []fld
	for _, f := range s.Manifests.Fields {
		if f.DBName == dbName {
			flds = append(flds, fld{name: f.Field, role: f.Role})
		}
	}

	// Group levels by field for fast lookup.
	levelsByField := map[string][]string{}
	for _, lv := range s.Manifests.Levels {
		if lv.DBName == dbName {
			levelsByField[lv.Field] = append(levelsByField[lv.Field], lv.Level)
		}
	}

	out := domain.DatasetFieldsResponse{DBName: dbName, Fields: make([]domain.FieldMeta, 0, len(flds))}
	for _, f := range flds {
		intro, ok, err := s.introspectField(ctx, dbName, f.name)
		if err != nil {
			return nil, fmt.Errorf("introspect %s.%s: %w", dbName, f.name, err)
		}
		fm := domain.FieldMeta{
			Field:  f.name,
			Role:   f.role,
			Levels: levelsByField[f.name],
		}
		if ok {
			fm.DBType = intro.dbType
			fm.Kind = kindForDBType(dbName, f.name, intro.dbType)
			if fm.Kind == "numeric" {
				rng, err := s.computeNumericRange(ctx, dbName, f.name, intro.table)
				if err != nil {
					return nil, fmt.Errorf("range %s.%s: %w", dbName, f.name, err)
				}
				fm.NumericMin = rng.min
				fm.NumericMax = rng.max
			}
		} else {
			// Field present in manifest but absent from both tables. Treat as
			// categorical (least surprising for a UI control) and surface the
			// empty DBType so the operator can spot the drift in logs / API.
			fm.Kind = kindForDBType(dbName, f.name, "")
		}
		out.Fields = append(out.Fields, fm)
	}
	// Stable ordering — manifest already sorts by field name; preserve it.
	sort.SliceStable(out.Fields, func(i, j int) bool { return out.Fields[i].Field < out.Fields[j].Field })
	return jsonMarshal(out)
}

// --- Handler 2: GET /api/v/{v}/datasets/{db}/regulators --------------------

func (s *Server) DatasetRegulators(w http.ResponseWriter, r *http.Request) {
	dbName := chi.URLParam(r, "db")
	if err := s.Whitelist.CheckDataset(dbName); err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}
	key := cache.Key(s.Manifests.Artifact.ArtifactVersion, r.Method, r.URL.Path, nil)
	body, hit, shared, err := s.Cache.GetOrLoad(r.Context(), key, func() ([]byte, error) {
		return s.buildDatasetRegulatorsResponse(r.Context(), dbName)
	})
	MarkCacheHit(r.Context(), hit)
	s.recordCacheOutcome(r, hit, shared)
	s.writeCachedJSON(w, r, body, hit, err)
}

func (s *Server) buildDatasetRegulatorsResponse(ctx context.Context, dbName string) ([]byte, error) {
	sqlStr := fmt.Sprintf(
		`SELECT DISTINCT regulator_locus_tag, regulator_symbol FROM %s ORDER BY regulator_locus_tag`,
		whitelistedIdent(dbName)+"_meta",
	)
	dbCtx, cancel := context.WithTimeout(ctx, db.QueryTimeout)
	defer cancel()
	t0 := time.Now()
	rows := []struct {
		LocusTag string `db:"regulator_locus_tag"`
		Symbol   string `db:"regulator_symbol"`
	}{}
	if err := s.Pool.DB.SelectContext(dbCtx, &rows, sqlStr); err != nil {
		return nil, err
	}
	elapsed := time.Since(t0)
	AddDBMillis(ctx, elapsed.Milliseconds())
	if s.Metrics != nil {
		s.Metrics.DBDuration.WithLabelValues("select_datasets/regulators").Observe(elapsed.Seconds())
	}

	out := domain.DatasetRegulatorsResponse{
		DBName:     dbName,
		Regulators: make([]domain.DatasetRegulator, 0, len(rows)),
	}
	for _, row := range rows {
		display := row.LocusTag
		if row.Symbol != "" && row.Symbol != row.LocusTag {
			display = fmt.Sprintf("%s (%s)", row.Symbol, row.LocusTag)
		}
		out.Regulators = append(out.Regulators, domain.DatasetRegulator{
			LocusTag: row.LocusTag,
			Symbol:   row.Symbol,
			Display:  display,
		})
	}
	return jsonMarshal(out)
}

// --- Handler 3: GET /api/v/{v}/selection/matrix ----------------------------

func (s *Server) SelectionMatrix(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	maxDS := len(s.Whitelist.AllDatasets())
	dsList, err := dedupeAndCapCSV("datasets", splitCSV(q.Get("datasets")), maxDS)
	if err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}
	if len(dsList) == 0 {
		writeJSONError(w, http.StatusBadRequest, "datasets required")
		return
	}
	for _, name := range dsList {
		if err := s.Whitelist.CheckDataset(name); err != nil {
			writeJSONError(w, http.StatusBadRequest, err.Error())
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
		"filters":  canonFilters,
	})
	key := cache.Key(s.Manifests.Artifact.ArtifactVersion, r.Method, r.URL.Path, canon)
	body, hit, shared, err := s.Cache.GetOrLoad(r.Context(), key, func() ([]byte, error) {
		return s.buildMatrixResponse(r.Context(), dsList, filters)
	})
	MarkCacheHit(r.Context(), hit)
	s.recordCacheOutcome(r, hit, shared)
	s.writeCachedJSON(w, r, body, hit, err)
}

func (s *Server) buildMatrixResponse(ctx context.Context, datasets []string, filters domain.FiltersByDB) ([]byte, error) {
	// Stable order — sorted() in Shiny.
	sorted := append([]string(nil), datasets...)
	sort.Strings(sorted)

	diag, err := s.queryMatrixDiagonal(ctx, sorted, filters)
	if err != nil {
		return nil, err
	}
	cross, err := s.queryMatrixCross(ctx, sorted, filters)
	if err != nil {
		return nil, err
	}
	return jsonMarshal(domain.MatrixResponse{Diagonal: diag, CrossDataset: cross})
}

func (s *Server) queryMatrixDiagonal(ctx context.Context, datasets []string, filters domain.FiltersByDB) ([]domain.MatrixDiagonalCell, error) {
	tmpl := queries.Get("datasets/matrix_diagonal.sql")
	parts := make([]string, 0, len(datasets))
	args := []any{}
	for _, dbName := range datasets {
		sampleCol, err := s.sampleIDField(dbName)
		if err != nil {
			return nil, err
		}
		where, whereArgs, err := buildSquirrelWhere(filters[dbName])
		if err != nil {
			return nil, fmt.Errorf("matrix diagonal %s: %w", dbName, err)
		}
		// buildSquirrelWhere returns " AND (...)" for non-empty filters; we
		// want " WHERE (...)" since there is no leading WHERE in the template.
		whereStr := whereForDiagonal(where)
		block := strings.NewReplacer(
			"{{db_literal}}", sqlStringLiteral(dbName),
			"{{table}}", whitelistedIdent(dbName)+"_meta",
			"{{sample_id_col}}", whitelistedIdent(sampleCol),
			"{{where}}", whereStr,
		).Replace(tmpl)
		parts = append(parts, block)
		args = append(args, whereArgs...)
	}
	full := strings.Join(parts, "\nUNION ALL\n")

	dbCtx, cancel := context.WithTimeout(ctx, db.QueryTimeout)
	defer cancel()
	t0 := time.Now()
	rows := []domain.MatrixDiagonalCell{}
	// Note: SelectContext+sqlx will scan into the struct's `json:` tag-less
	// fields by exported name unless db: tags exist. Use a struct with db:
	// tags to be safe.
	type diagRow struct {
		DBName      string `db:"db_name"`
		NRegulators int64  `db:"n_regulators"`
		NSamples    int64  `db:"n_samples"`
	}
	scanRows := []diagRow{}
	if err := s.Pool.DB.SelectContext(dbCtx, &scanRows, full, args...); err != nil {
		return nil, fmt.Errorf("matrix diagonal query: %w", err)
	}
	elapsed := time.Since(t0)
	AddDBMillis(ctx, elapsed.Milliseconds())
	if s.Metrics != nil {
		s.Metrics.DBDuration.WithLabelValues("select_datasets/matrix_diagonal").Observe(elapsed.Seconds())
	}
	// Preserve sorted-datasets order in the response.
	byName := make(map[string]diagRow, len(scanRows))
	for _, r := range scanRows {
		byName[r.DBName] = r
	}
	for _, dbName := range datasets {
		r, ok := byName[dbName]
		if !ok {
			// Should not happen — UNION ALL emits one row per template
			// block — but guard so we don't panic on empty fixture corners.
			rows = append(rows, domain.MatrixDiagonalCell{DBName: dbName})
			continue
		}
		rows = append(rows, domain.MatrixDiagonalCell{
			DBName: r.DBName, NRegulators: r.NRegulators, NSamples: r.NSamples,
		})
	}
	return rows, nil
}

func (s *Server) queryMatrixCross(ctx context.Context, datasets []string, filters domain.FiltersByDB) ([]domain.MatrixCrossCell, error) {
	if len(datasets) < 2 {
		return []domain.MatrixCrossCell{}, nil
	}
	tmpl := queries.Get("datasets/matrix_cross_dataset.sql")
	parts := make([]string, 0, len(datasets)*(len(datasets)-1)/2)
	args := []any{}
	type pair struct{ a, b string }
	pairs := []pair{}
	for i := 0; i < len(datasets); i++ {
		for j := i + 1; j < len(datasets); j++ {
			pairs = append(pairs, pair{datasets[i], datasets[j]})
		}
	}
	for _, pr := range pairs {
		sampleA, err := s.sampleIDField(pr.a)
		if err != nil {
			return nil, err
		}
		sampleB, err := s.sampleIDField(pr.b)
		if err != nil {
			return nil, err
		}
		// Both INTERSECT arms and both sample-count subqueries need the same
		// filter args — squirrel emits one copy per call so we pass them four
		// times in template-positional order.
		whereA, argsA, err := buildSquirrelWhere(filters[pr.a])
		if err != nil {
			return nil, fmt.Errorf("matrix cross %s/%s: %w", pr.a, pr.b, err)
		}
		whereB, argsB, err := buildSquirrelWhere(filters[pr.b])
		if err != nil {
			return nil, fmt.Errorf("matrix cross %s/%s: %w", pr.a, pr.b, err)
		}
		whereStrA := whereForDiagonal(whereA)
		whereStrB := whereForDiagonal(whereB)

		// Sample-count subqueries: append " AND/WHERE regulator_locus_tag IN
		// (...INTERSECT...)" — but the INTERSECT subquery itself needs the
		// same args yet again. To keep ordering predictable we re-render the
		// INTERSECT inline. Total positional args, in order, per pair:
		//   1. argsA  (INTERSECT arm A in the n_common subquery)
		//   2. argsB  (INTERSECT arm B in the n_common subquery)
		//   3. argsA  (sample-count A WHERE)
		//   4. argsA  (INTERSECT arm A inside the sample-count A common predicate)
		//   5. argsB  (INTERSECT arm B inside the sample-count A common predicate)
		//   6. argsB  (sample-count B WHERE)
		//   7. argsA  (INTERSECT arm A inside the sample-count B common predicate)
		//   8. argsB  (INTERSECT arm B inside the sample-count B common predicate)
		commonInline := fmt.Sprintf(
			"(SELECT regulator_locus_tag FROM %s%s INTERSECT SELECT regulator_locus_tag FROM %s%s)",
			whitelistedIdent(pr.a)+"_meta", whereStrA,
			whitelistedIdent(pr.b)+"_meta", whereStrB,
		)
		// Append " AND ... " or " WHERE ... " for sample-count predicate.
		appendCommon := func(existing string) string {
			pred := "regulator_locus_tag IN " + commonInline
			if existing == "" {
				return " WHERE " + pred
			}
			return existing + " AND " + pred
		}
		whereSA := appendCommon(whereStrA)
		whereSB := appendCommon(whereStrB)

		block := strings.NewReplacer(
			"{{pair_id_literal}}", sqlStringLiteral(pr.a+"__"+pr.b),
			"{{table_a}}", whitelistedIdent(pr.a)+"_meta",
			"{{table_b}}", whitelistedIdent(pr.b)+"_meta",
			"{{sample_id_col_a}}", whitelistedIdent(sampleA),
			"{{sample_id_col_b}}", whitelistedIdent(sampleB),
			"{{where_a}}", whereStrA,
			"{{where_b}}", whereStrB,
			"{{where_sa}}", whereSA,
			"{{where_sb}}", whereSB,
		).Replace(tmpl)
		parts = append(parts, block)

		// Positional args, mirroring the Replacer-rendered text:
		//  - n_common subquery: argsA, argsB
		args = append(args, argsA...)
		args = append(args, argsB...)
		//  - samples_a subquery: argsA (outer WHERE), then argsA + argsB
		//    (INTERSECT inlined inside appendCommon).
		args = append(args, argsA...)
		args = append(args, argsA...)
		args = append(args, argsB...)
		//  - samples_b subquery: argsB (outer WHERE), then argsA + argsB
		//    (INTERSECT inlined inside appendCommon).
		args = append(args, argsB...)
		args = append(args, argsA...)
		args = append(args, argsB...)
	}
	full := strings.Join(parts, "\nUNION ALL\n")

	dbCtx, cancel := context.WithTimeout(ctx, db.QueryTimeout)
	defer cancel()
	t0 := time.Now()
	type crossRow struct {
		PairID   string `db:"pair_id"`
		NCommon  int64  `db:"n_common"`
		SamplesA int64  `db:"samples_a"`
		SamplesB int64  `db:"samples_b"`
	}
	scanRows := []crossRow{}
	if err := s.Pool.DB.SelectContext(dbCtx, &scanRows, full, args...); err != nil {
		return nil, fmt.Errorf("matrix cross query: %w", err)
	}
	elapsed := time.Since(t0)
	AddDBMillis(ctx, elapsed.Milliseconds())
	if s.Metrics != nil {
		s.Metrics.DBDuration.WithLabelValues("select_datasets/matrix_cross").Observe(elapsed.Seconds())
	}
	byID := make(map[string]crossRow, len(scanRows))
	for _, r := range scanRows {
		byID[r.PairID] = r
	}
	out := make([]domain.MatrixCrossCell, 0, len(pairs))
	for _, pr := range pairs {
		id := pr.a + "__" + pr.b
		r := byID[id]
		out = append(out, domain.MatrixCrossCell{
			PairID:   id,
			DBA:      pr.a,
			DBB:      pr.b,
			NCommon:  r.NCommon,
			SamplesA: r.SamplesA,
			SamplesB: r.SamplesB,
		})
	}
	return out, nil
}

// --- Handler 4: GET /api/v/{v}/selection/breakdown -------------------------

func (s *Server) SelectionBreakdown(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	dbName := q.Get("dataset")
	if dbName == "" {
		writeJSONError(w, http.StatusBadRequest, "dataset required")
		return
	}
	if err := s.Whitelist.CheckDataset(dbName); err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
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
	for ds, fs := range filters {
		for fld := range fs {
			if err := s.Whitelist.CheckField(ds, fld); err != nil {
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
		"dataset": dbName,
		"filters": canonFilters,
	})
	key := cache.Key(s.Manifests.Artifact.ArtifactVersion, r.Method, r.URL.Path, canon)
	body, hit, shared, err := s.Cache.GetOrLoad(r.Context(), key, func() ([]byte, error) {
		return s.buildBreakdownResponse(r.Context(), dbName, filters)
	})
	MarkCacheHit(r.Context(), hit)
	s.recordCacheOutcome(r, hit, shared)
	s.writeCachedJSON(w, r, body, hit, err)
}

func (s *Server) buildBreakdownResponse(ctx context.Context, dbName string, filters domain.FiltersByDB) ([]byte, error) {
	// Candidate columns: all manifest fields for this dataset minus identity
	// and structural columns. The manifest already excludes
	// HIDDEN_FILTER_FIELDS via data_prep's manifests.py, so we just need to
	// drop the per-row identifiers that are never differentiating.
	excluded := map[string]struct{}{
		"sample_id":           {},
		"regulator_locus_tag": {},
		"regulator_symbol":    {},
		"target_locus_tag":    {},
		"target_symbol":       {},
	}
	// Breakdown runs against `{db}_meta`. Manifest fields like
	// `callingcards_enrichment` only live on the data table, not _meta, so
	// they cannot be COUNT(DISTINCT)'d here without a JOIN — and they
	// wouldn't differentiate samples within a regulator anyway since they
	// vary by target, not by sample. Drop any field absent from _meta.
	metaTable := whitelistedIdent(dbName) + "_meta"
	metaCols, err := s.listColumns(ctx, metaTable)
	if err != nil {
		return nil, fmt.Errorf("breakdown introspect %s: %w", metaTable, err)
	}
	candidate := make([]string, 0, 8)
	for _, f := range s.Manifests.Fields {
		if f.DBName != dbName {
			continue
		}
		if _, drop := excluded[f.Field]; drop {
			continue
		}
		if _, present := metaCols[f.Field]; !present {
			continue
		}
		candidate = append(candidate, f.Field)
	}
	sort.Strings(candidate)

	if len(candidate) == 0 {
		out := domain.BreakdownResponse{DBName: dbName, NMulti: 0, Columns: []domain.BreakdownColumn{}}
		return jsonMarshal(out)
	}

	// _build_where returns " WHERE ..." form; we use buildSquirrelWhereRaw
	// and prefix WHERE/AND as needed. The args are the same in both arms.
	whereExpr, whereArgs, err := buildSquirrelWhereRaw(filters[dbName])
	if err != nil {
		return nil, err
	}

	multiTable := metaTable

	// Validate each candidate column against the whitelist before interpolation.
	// (Manifest membership has already been checked, but whitelistedIdent is
	// the per-request tripwire.)
	verified := make([]string, 0, len(candidate))
	for _, c := range candidate {
		if err := s.Whitelist.CheckField(dbName, c); err != nil {
			return nil, fmt.Errorf("breakdown %s.%s: %w", dbName, c, err)
		}
		verified = append(verified, whitelistedIdent(c))
	}

	perRegExprs := make([]string, 0, len(verified))
	aggExprs := make([]string, 0, len(verified))
	for _, c := range verified {
		perRegExprs = append(perRegExprs, fmt.Sprintf(`COUNT(DISTINCT %q) AS %q`, c, c))
		aggExprs = append(aggExprs, fmt.Sprintf(`COUNT(*) FILTER (WHERE %q > 1) AS %q`, c, c))
	}

	multiWhere := ""
	if whereExpr != "" {
		multiWhere = " WHERE " + whereExpr
	}
	perRegWhere := multiWhere
	commonPredicate := "regulator_locus_tag IN (SELECT regulator_locus_tag FROM multi)"
	if perRegWhere == "" {
		perRegWhere = " WHERE " + commonPredicate
	} else {
		perRegWhere = perRegWhere + " AND " + commonPredicate
	}

	sqlStr := fmt.Sprintf(
		`WITH multi AS (
  SELECT regulator_locus_tag
  FROM %[1]s%[2]s
  GROUP BY regulator_locus_tag
  HAVING COUNT(*) > 1
), per_reg AS (
  SELECT regulator_locus_tag, %[3]s
  FROM %[1]s%[4]s
  GROUP BY regulator_locus_tag
)
SELECT COUNT(*) AS n_multi, %[5]s FROM per_reg`,
		multiTable, multiWhere,
		strings.Join(perRegExprs, ", "),
		perRegWhere,
		strings.Join(aggExprs, ", "),
	)

	// Argument duplication: multi-CTE WHERE uses whereArgs once; per_reg WHERE
	// uses whereArgs once (when filters present), plus the common predicate
	// (no args).
	args := []any{}
	args = append(args, whereArgs...)
	args = append(args, whereArgs...)

	dbCtx, cancel := context.WithTimeout(ctx, db.QueryTimeout)
	defer cancel()
	t0 := time.Now()
	// Scan into a generic map so we can read dynamically-named columns.
	row := s.Pool.DB.QueryRowxContext(dbCtx, sqlStr, args...)
	result := map[string]any{}
	if err := row.MapScan(result); err != nil {
		return nil, fmt.Errorf("breakdown query: %w", err)
	}
	elapsed := time.Since(t0)
	AddDBMillis(ctx, elapsed.Milliseconds())
	if s.Metrics != nil {
		s.Metrics.DBDuration.WithLabelValues("select_datasets/breakdown").Observe(elapsed.Seconds())
	}

	nMulti, _ := asInt64(result["n_multi"])
	cols := make([]domain.BreakdownColumn, 0, len(candidate))
	for _, c := range candidate {
		v, _ := asInt64(result[c])
		cols = append(cols, domain.BreakdownColumn{Field: c, DistinctValues: v})
	}
	return jsonMarshal(domain.BreakdownResponse{DBName: dbName, NMulti: nMulti, Columns: cols})
}

// --- helpers ---------------------------------------------------------------

// whereForDiagonal converts buildSquirrelWhere's " AND (...)" form to a
// leading " WHERE (...)" form for diagonal/cross templates that have no
// pre-existing WHERE.
func whereForDiagonal(where string) string {
	if where == "" {
		return ""
	}
	const prefix = " AND "
	if strings.HasPrefix(where, prefix) {
		return " WHERE " + strings.TrimPrefix(where, prefix)
	}
	return " WHERE " + where
}

// sqlStringLiteral quotes a string as a SQL literal. Used for db_name /
// pair_id columns in matrix UNION ALL — the input is already SafeIdentRE-
// verified (or a SafeIdent-only concatenation) so the only risk is a stray
// single quote, which we escape defensively.
func sqlStringLiteral(s string) string {
	return "'" + strings.ReplaceAll(s, "'", "''") + "'"
}

// sampleIDField returns the per-dataset sample-id column name sourced from
// dataset_manifest.sample_id_field (gm_id for callingcards, sample_id for
// the rest). Re-verifies the value against SafeIdentRE through
// whitelistedIdent — the manifest gate in db.NewWhitelist does not currently
// validate this column, so the runtime check is the only guarantee.
func (s *Server) sampleIDField(dbName string) (string, error) {
	row, ok := s.Whitelist.Dataset(dbName)
	if !ok {
		return "", fmt.Errorf("unknown dataset: %q", dbName)
	}
	if row.SampleIDField == "" {
		return "", fmt.Errorf("dataset %q missing sample_id_field in manifest", dbName)
	}
	if !db.SafeIdentRE.MatchString(row.SampleIDField) {
		return "", fmt.Errorf("dataset %q has unsafe sample_id_field: %q", dbName, row.SampleIDField)
	}
	return row.SampleIDField, nil
}

// listColumns returns the set of column names present in `table` as a
// lookup map for membership checks. Caller is responsible for passing a
// SafeIdentRE-verified table name; the query itself binds `table` as a
// parameter.
func (s *Server) listColumns(ctx context.Context, table string) (map[string]struct{}, error) {
	dbCtx, cancel := context.WithTimeout(ctx, db.QueryTimeout)
	defer cancel()
	rows := []struct {
		Name string `db:"column_name"`
	}{}
	if err := s.Pool.DB.SelectContext(dbCtx, &rows,
		`SELECT column_name FROM information_schema.columns WHERE table_name = ?`,
		table,
	); err != nil {
		return nil, err
	}
	out := make(map[string]struct{}, len(rows))
	for _, r := range rows {
		out[r.Name] = struct{}{}
	}
	return out, nil
}

// asInt64 coerces a DuckDB-returned numeric scalar into int64. DuckDB returns
// COUNT(*) as either int32 or int64 depending on engine version; map-scan
// surfaces whichever the driver chose.
func asInt64(v any) (int64, bool) {
	switch x := v.(type) {
	case int64:
		return x, true
	case int32:
		return int64(x), true
	case int:
		return int64(x), true
	case uint64:
		return int64(x), true
	case uint32:
		return int64(x), true
	case float64:
		return int64(x), true
	case nil:
		return 0, true
	default:
		return 0, false
	}
}

// introspectInitOnce / fieldIntrospect / fieldNumeric live on the Server
// (see router.go) so the test bootstrap doesn't need any additional plumbing.
