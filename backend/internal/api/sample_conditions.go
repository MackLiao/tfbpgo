package api

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/BrentLab/tfbpshiny-go/backend/internal/cache"
	"github.com/BrentLab/tfbpshiny-go/backend/internal/db"
	"github.com/BrentLab/tfbpshiny-go/backend/internal/domain"
)

// SampleConditions serves GET /api/v/{v}/datasets/{db}/sample-conditions.
//
// Returns the per-sample condition-label map used by the binding /
// perturbation correlation overlay hovertext. Mirrors the Shiny helper
// at reference/tfbpshiny/utils/sample_conditions.py:55-94:
//
//   - Source columns come from dataset_manifest.condition_cols (CSV in
//     the manifest; parsed to []string in the Whitelist DatasetRow).
//   - SQL is `SELECT sample_id, "<cond1>", "<cond2>", ... FROM {db}_meta`.
//   - Per row, the label is `" / ".join(non-empty trimmed values)`. NULLs
//     and empty/"nan" strings are dropped. Samples with an empty label
//     are omitted from the map.
//
// When dataset_manifest.condition_cols is empty for the dataset, returns
// an empty Labels map and empty ConditionCols slice (no SQL is issued).
//
// Identifier safety: db_name has been verified by Whitelist.CheckDataset
// (and re-verified against SafeIdentRE by whitelistedIdent). Each
// condition column comes from dataset_manifest.condition_cols, which is
// validated against SafeIdentRE at startup by db.NewWhitelist (see
// whitelist.go:92-105) — every entry passes the same regex the SQL-
// interpolation tripwire uses. We wrap each col with whitelistedIdent
// per the security-review pattern as defense in depth.
//
// Note: we intentionally do NOT call Whitelist.CheckField on the
// condition columns. In production the `mechanism` / `restriction`
// columns used by hackett are in HIDDEN_FILTER_FIELDS and therefore
// absent from field_manifest (see data_prep/manifests.py:292-308).
// CheckField would 400 every request. The two safety guarantees we
// already have (manifest-gate SafeIdentRE at startup + whitelistedIdent
// per request) are equivalent to what CheckField provides for filter
// fields.
func (s *Server) SampleConditions(w http.ResponseWriter, r *http.Request) {
	dbName := chi.URLParam(r, "db")
	if err := s.Whitelist.CheckDataset(dbName); err != nil {
		writeJSONError(w, http.StatusBadRequest, err.Error())
		return
	}
	// No query params drive the response — canonical key has none so
	// the per-dataset path alone is the cache key.
	key := cache.Key(s.Manifests.Artifact.ArtifactVersion, r.Method, r.URL.Path, nil)
	body, hit, shared, err := s.Cache.GetOrLoad(r.Context(), chiRoutePattern(r), key, func() ([]byte, error) {
		return s.buildSampleConditionsResponse(r.Context(), dbName)
	})
	MarkCacheHit(r.Context(), hit)
	s.recordCacheOutcome(r, hit, shared)
	s.writeCachedJSON(w, r, body, hit, err)
}

func (s *Server) buildSampleConditionsResponse(ctx context.Context, dbName string) ([]byte, error) {
	row, _ := s.Whitelist.Dataset(dbName)
	cols := parseConditionCols(row.ConditionCols)
	out := domain.SampleConditionsResponse{
		DBName:        dbName,
		ConditionCols: cols,
		Labels:        map[string]string{},
	}
	if len(cols) == 0 {
		return jsonMarshal(out)
	}

	// Per-dataset join key in {db}_meta — `sample_id` for most datasets,
	// `gm_id` for callingcards. The Whitelist's DatasetRow exposes this
	// field; we project it AS sample_id so the row scanner sees a
	// uniform column name regardless of source.
	sampleIDCol := row.SampleIDField
	if sampleIDCol == "" {
		return nil, fmt.Errorf("dataset %q missing sample_id_field in manifest", dbName)
	}

	// Defense-in-depth against manifest/data drift. A condition column named
	// in dataset_manifest.condition_cols but ABSENT from {db}_meta must NOT
	// 500 the correlation overlay. This is exactly the real-data callingcards
	// case: the manifest claimed `condition` but the materialized
	// callingcards_meta had no such column, so the self-aliased projection
	// `CAST("condition" AS VARCHAR) AS "condition"` resolved the inner
	// reference against the not-yet-defined SELECT alias and DuckDB raised
	// "Column condition ... cannot be referenced before it is defined".
	// Filter to columns that physically exist and drop the rest; if none
	// survive, return empty Labels (identical to the no-condition-cols path
	// above). data_prep now derives condition_cols from the same {db}_meta
	// introspection (DM-5), so on a correctly built artifact nothing is
	// dropped here — this guard only fires against a stale/inconsistent one.
	present, err := s.metaColumnSet(ctx, dbName+"_meta")
	if err != nil {
		return nil, fmt.Errorf("sample-conditions introspect: %w", err)
	}
	kept := make([]string, 0, len(cols))
	for _, c := range cols {
		if present[c] {
			kept = append(kept, c)
			continue
		}
		slog.WarnContext(ctx, "sample_conditions_missing_column",
			"dataset", dbName, "column", c,
			"detail", "condition_cols names a column absent from {db}_meta; dropped")
	}
	cols = kept
	out.ConditionCols = cols
	if len(cols) == 0 {
		return jsonMarshal(out)
	}

	// Per-request tripwire: each condition col (and the sample id col)
	// must match SafeIdentRE. The manifest gate (db.NewWhitelist)
	// already enforces this at startup; whitelistedIdent is the second
	// line of defense at the SQL-interpolation site.
	quoted := make([]string, len(cols))
	for i, c := range cols {
		quoted[i] = quotedIdent(c)
	}
	// CAST every condition column to VARCHAR so heterogeneous types
	// (INTEGER `time`, VARCHAR `mechanism`, ...) flatten to strings the
	// Go-side label builder can join uniformly. Identifiers are double-quoted
	// so a SQL-keyword condition column (e.g. the genomic `end` coordinate)
	// doesn't trip the parser — matches the reference
	// (reference/tfbpshiny/utils/sample_conditions.py double-quotes each col).
	projections := make([]string, len(quoted))
	for i, c := range quoted {
		projections[i] = fmt.Sprintf(`CAST(%s AS VARCHAR) AS %s`, c, c)
	}
	// CAST sample_id to VARCHAR as well. Real {db}_meta sample_id columns are
	// INTEGER (e.g. harbison 121, chec_m2025 58); the label-map KEY must be the
	// canonical decimal string so it matches the correlation overlay's lookup
	// key — the /binding|perturbation/corr response scans `db_a_id = a.sample_id`
	// into a Go string (correlation.go), yielding "86" for INTEGER 86. Without
	// this CAST, MapScan returns int64 and the `.(string)` scan below failed,
	// skipping every row → empty labels on real data (hover conditions blank).
	// Mirrors the reference's str(row["sample_id"]) key (sample_conditions.py).
	sqlStr := fmt.Sprintf(
		`SELECT CAST(%s AS VARCHAR) AS sample_id, %s FROM %s`,
		quotedIdent(sampleIDCol),
		strings.Join(projections, ", "),
		quotedIdent(dbName+"_meta"),
	)

	dbCtx, cancel := context.WithTimeout(ctx, db.QueryTimeout)
	defer cancel()
	t0 := time.Now()
	rows, err := s.Pool.DB.QueryxContext(dbCtx, sqlStr)
	if err != nil {
		return nil, fmt.Errorf("sample-conditions query: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		m := map[string]any{}
		if err := rows.MapScan(m); err != nil {
			return nil, fmt.Errorf("sample-conditions scan: %w", err)
		}
		raw := m["sample_id"]
		if raw == nil {
			continue
		}
		sid, ok := raw.(string)
		if !ok {
			// CAST AS VARCHAR should yield string; defend anyway (mirrors the
			// condition-column extraction below).
			sid = fmt.Sprint(raw)
		}
		if sid == "" {
			continue
		}
		parts := make([]string, 0, len(cols))
		for _, c := range cols {
			v, ok := m[c]
			if !ok || v == nil {
				continue
			}
			s, ok := v.(string)
			if !ok {
				// CAST AS VARCHAR should yield string; defend anyway.
				s = fmt.Sprint(v)
			}
			s = strings.TrimSpace(s)
			if s == "" || strings.EqualFold(s, "nan") {
				continue
			}
			parts = append(parts, s)
		}
		if len(parts) == 0 {
			continue
		}
		out.Labels[sid] = strings.Join(parts, " / ")
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("sample-conditions rows: %w", err)
	}
	elapsed := time.Since(t0)
	AddDBMillis(ctx, elapsed.Milliseconds())
	if s.Metrics != nil {
		s.Metrics.DBDuration.WithLabelValues("datasets/sample_conditions").Observe(elapsed.Seconds())
	}
	return jsonMarshal(out)
}

// metaColumnSet returns the set of column names present in `table`. The
// table name is bound as a query parameter (not interpolated), so it carries
// no SQL-injection risk even though dbName is already manifest-whitelisted at
// the call site. An empty (non-nil) set is returned for a missing table.
func (s *Server) metaColumnSet(ctx context.Context, table string) (map[string]bool, error) {
	dbCtx, cancel := context.WithTimeout(ctx, db.QueryTimeout)
	defer cancel()
	var names []string
	if err := s.Pool.DB.SelectContext(dbCtx, &names,
		`SELECT column_name FROM information_schema.columns
		 WHERE table_schema = 'main' AND table_name = ?`,
		table,
	); err != nil {
		return nil, err
	}
	set := make(map[string]bool, len(names))
	for _, n := range names {
		set[n] = true
	}
	return set, nil
}

// parseConditionCols turns the comma-separated condition_cols manifest
// value into a clean []string. Mirrors api.Datasets's parsing of the
// same field. Empty result for an empty input.
func parseConditionCols(raw string) []string {
	out := []string{}
	if raw == "" {
		return out
	}
	for _, tok := range strings.Split(raw, ",") {
		tok = strings.TrimSpace(tok)
		if tok == "" {
			continue
		}
		out = append(out, tok)
	}
	return out
}
