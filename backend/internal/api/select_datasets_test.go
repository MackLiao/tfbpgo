package api

import (
	"encoding/json"
	"net/http/httptest"
	"net/url"
	"testing"

	"github.com/BrentLab/tfbpshiny-go/backend/internal/domain"
	"github.com/stretchr/testify/require"
)

func apiVPath(s *Server, suffix string) string {
	return "/api/v/" + s.Manifests.Artifact.ArtifactVersion + suffix
}

// ---------------------------------------------------------------------------
// DatasetFields
// ---------------------------------------------------------------------------

func TestDatasetFields_HappyCallingcards(t *testing.T) {
	s := newTestServer(t)

	rr := httptest.NewRecorder()
	req := httptest.NewRequest("GET", apiVPath(s, "/datasets/callingcards/fields"), nil)
	s.Routes().ServeHTTP(rr, req)
	require.Equal(t, 200, rr.Code, rr.Body.String())

	var resp domain.DatasetFieldsResponse
	require.NoError(t, json.Unmarshal(rr.Body.Bytes(), &resp))
	require.Equal(t, "callingcards", resp.DBName)
	require.NotEmpty(t, resp.Fields)

	byField := map[string]domain.FieldMeta{}
	for _, f := range resp.Fields {
		byField[f.Field] = f
	}

	// `condition` should be categorical with role=experimental_condition and
	// levels populated from filter_level_cache (SC, YPD).
	condition, ok := byField["condition"]
	require.True(t, ok, "condition field missing")
	require.Equal(t, "experimental_condition", condition.Role)
	require.Equal(t, "categorical", condition.Kind)
	require.ElementsMatch(t, []string{"SC", "YPD"}, condition.Levels)

	// `score` (DOUBLE) → numeric with min/max from aggregate.
	score, ok := byField["score"]
	require.True(t, ok)
	require.Equal(t, "numeric", score.Kind)
	require.NotNil(t, score.NumericMin)
	require.NotNil(t, score.NumericMax)
	require.LessOrEqual(t, *score.NumericMin, *score.NumericMax)
}

func TestDatasetFields_HackettTimeOverride(t *testing.T) {
	s := newTestServer(t)

	rr := httptest.NewRecorder()
	req := httptest.NewRequest("GET", apiVPath(s, "/datasets/hackett/fields"), nil)
	s.Routes().ServeHTTP(rr, req)
	require.Equal(t, 200, rr.Code, rr.Body.String())

	var resp domain.DatasetFieldsResponse
	require.NoError(t, json.Unmarshal(rr.Body.Bytes(), &resp))
	byField := map[string]domain.FieldMeta{}
	for _, f := range resp.Fields {
		byField[f.Field] = f
	}
	tm, ok := byField["time"]
	require.True(t, ok, "time field missing")
	// time is INTEGER in DuckDB but FIELD_TYPE_OVERRIDES (sourced from
	// field_manifest.ui_kind_override in v4) forces categorical.
	require.Equal(t, "categorical", tm.Kind, "ui_kind_override should win")
	require.Equal(t, "experimental_condition", tm.Role)
	require.ElementsMatch(t, []string{"45"}, tm.Levels)
	require.Nil(t, tm.NumericMin, "categorical override should not set numeric range")
	require.Nil(t, tm.NumericMax)
	// v4: the override + level-sort hint are exposed verbatim from the
	// manifest so the frontend can render the selectize with numeric sort.
	require.Equal(t, "categorical", tm.UIKindOverride,
		"v4: UIKindOverride sourced from field_manifest")
	require.Equal(t, "numeric", tm.NumericLevelSort)
}

func TestDatasetFields_UnknownDataset400(t *testing.T) {
	s := newTestServer(t)
	rr := httptest.NewRecorder()
	req := httptest.NewRequest("GET", apiVPath(s, "/datasets/nope/fields"), nil)
	s.Routes().ServeHTTP(rr, req)
	require.Equal(t, 400, rr.Code)
}

// ---------------------------------------------------------------------------
// DatasetRegulators
// ---------------------------------------------------------------------------

func TestDatasetRegulators_HappyCallingcards(t *testing.T) {
	s := newTestServer(t)
	rr := httptest.NewRecorder()
	req := httptest.NewRequest("GET", apiVPath(s, "/datasets/callingcards/regulators"), nil)
	s.Routes().ServeHTTP(rr, req)
	require.Equal(t, 200, rr.Code, rr.Body.String())

	var resp domain.DatasetRegulatorsResponse
	require.NoError(t, json.Unmarshal(rr.Body.Bytes(), &resp))
	require.Equal(t, "callingcards", resp.DBName)
	// callingcards has 3 distinct regulator locus tags (YBR289W, YML007W, YGL073W).
	require.Len(t, resp.Regulators, 3)

	// Sorted by locus tag.
	require.Equal(t, "YBR289W", resp.Regulators[0].LocusTag)
	require.Equal(t, "SNF5", resp.Regulators[0].Symbol)
	require.Equal(t, "SNF5 (YBR289W)", resp.Regulators[0].Display)
}

func TestDatasetRegulators_UnknownDataset400(t *testing.T) {
	s := newTestServer(t)
	rr := httptest.NewRecorder()
	req := httptest.NewRequest("GET", apiVPath(s, "/datasets/nope/regulators"), nil)
	s.Routes().ServeHTTP(rr, req)
	require.Equal(t, 400, rr.Code)
}

// ---------------------------------------------------------------------------
// SelectionMatrix
// ---------------------------------------------------------------------------

func TestSelectionMatrix_HappyTwoDatasets(t *testing.T) {
	s := newTestServer(t)
	rr := httptest.NewRecorder()
	q := url.Values{}
	q.Set("datasets", "callingcards,hackett")
	req := httptest.NewRequest("GET", apiVPath(s, "/selection/matrix")+"?"+q.Encode(), nil)
	s.Routes().ServeHTTP(rr, req)
	require.Equal(t, 200, rr.Code, rr.Body.String())

	var resp domain.MatrixResponse
	require.NoError(t, json.Unmarshal(rr.Body.Bytes(), &resp))
	require.Len(t, resp.Diagonal, 2)
	require.Len(t, resp.CrossDataset, 1)

	byName := map[string]domain.MatrixDiagonalCell{}
	for _, c := range resp.Diagonal {
		byName[c.DBName] = c
	}
	cc, ok := byName["callingcards"]
	require.True(t, ok)
	require.Equal(t, int64(3), cc.NRegulators) // YBR289W, YML007W, YGL073W
	require.Equal(t, int64(7), cc.NSamples)    // 7 distinct gm_ids in fixture

	hk, ok := byName["hackett"]
	require.True(t, ok)
	require.Equal(t, int64(3), hk.NRegulators)
	require.Equal(t, int64(4), hk.NSamples) // h_0..h_3

	// Cross cell.
	cross := resp.CrossDataset[0]
	require.Equal(t, "callingcards__hackett", cross.PairID)
	require.Equal(t, "callingcards", cross.DBA)
	require.Equal(t, "hackett", cross.DBB)
	require.Equal(t, int64(3), cross.NCommon)
	require.Equal(t, int64(7), cross.SamplesA)
	require.Equal(t, int64(4), cross.SamplesB)
}

func TestSelectionMatrix_MissingDatasets400(t *testing.T) {
	s := newTestServer(t)
	rr := httptest.NewRecorder()
	req := httptest.NewRequest("GET", apiVPath(s, "/selection/matrix"), nil)
	s.Routes().ServeHTTP(rr, req)
	require.Equal(t, 400, rr.Code)
}

func TestSelectionMatrix_UnknownDataset400(t *testing.T) {
	s := newTestServer(t)
	rr := httptest.NewRecorder()
	q := url.Values{}
	q.Set("datasets", "nope")
	req := httptest.NewRequest("GET", apiVPath(s, "/selection/matrix")+"?"+q.Encode(), nil)
	s.Routes().ServeHTTP(rr, req)
	require.Equal(t, 400, rr.Code)
}

func TestSelectionMatrix_WithCallingcardsFilter(t *testing.T) {
	s := newTestServer(t)
	rr := httptest.NewRecorder()
	q := url.Values{}
	q.Set("datasets", "callingcards,hackett")
	// Restrict callingcards to condition=YPD; that drops cc_extra (SC, YBR289W).
	q.Set("filters", `{"callingcards":{"condition":{"type":"categorical","value":["YPD"]}}}`)
	req := httptest.NewRequest("GET", apiVPath(s, "/selection/matrix")+"?"+q.Encode(), nil)
	s.Routes().ServeHTTP(rr, req)
	require.Equal(t, 200, rr.Code, rr.Body.String())

	var resp domain.MatrixResponse
	require.NoError(t, json.Unmarshal(rr.Body.Bytes(), &resp))
	byName := map[string]domain.MatrixDiagonalCell{}
	for _, c := range resp.Diagonal {
		byName[c.DBName] = c
	}
	require.Equal(t, int64(6), byName["callingcards"].NSamples) // 7 - 1 (cc_extra)
	// All 3 regulators still represented (each has at least one YPD sample).
	require.Equal(t, int64(3), byName["callingcards"].NRegulators)

	// Cross-cell NCommon pins the filter-arm INTERSECT semantics: filtered
	// callingcards (YPD only — drops cc_extra/SC but keeps all 3 regulators
	// since each has at least one YPD sample) ∩ unfiltered hackett (3
	// regulators: YBR289W, YML007W, YGL073W) = 3 common regulators. If the
	// filter arm ever leaked into / out of the INTERSECT subquery, this
	// number would drift (e.g. count cc_extra's YBR289W twice, or zero out
	// the entire arm).
	require.Len(t, resp.CrossDataset, 1)
	cross := resp.CrossDataset[0]
	require.Equal(t, "callingcards__hackett", cross.PairID)
	require.Equal(t, int64(3), cross.NCommon,
		"3 regulators common to YPD-filtered callingcards and unfiltered hackett")
}

// TestSelectionMatrix_FilteredCrossPair guards the cross-dataset matrix
// arg-count when BOTH sides carry non-empty filters. buildSquirrelWhere only
// emits ? placeholders, so the Replacer-rendered SQL and the manually-built
// args slice must stay in lockstep (see queryMatrixCross's positional-args
// table comment). This is a regression for the db-reviewer concern raised
// in the A5 multi-review: if either arm started emitting bound idents
// inline, the arg count would drift and surface as a "wrong number of
// arguments" error at query time.
func TestSelectionMatrix_FilteredCrossPair(t *testing.T) {
	s := newTestServer(t)
	rr := httptest.NewRecorder()
	q := url.Values{}
	q.Set("datasets", "callingcards,hackett")
	// Both arms filtered: callingcards by condition=YPD (drops cc_extra,
	// leaving 6 rows); hackett by time in [40,50] (keeps the integer 45,
	// which is the only time value in the fixture).
	q.Set("filters",
		`{"callingcards":{"condition":{"type":"categorical","value":["YPD"]}},`+
			`"hackett":{"time":{"type":"numeric","value":[40,50]}}}`)
	req := httptest.NewRequest("GET", apiVPath(s, "/selection/matrix")+"?"+q.Encode(), nil)
	s.Routes().ServeHTTP(rr, req)
	// A 500 here would imply the args slice diverged from the rendered
	// template; the message would be "wrong number of arguments" from
	// duckdb. 200 implicitly proves the arg count held.
	require.Equal(t, 200, rr.Code, rr.Body.String())

	var resp domain.MatrixResponse
	require.NoError(t, json.Unmarshal(rr.Body.Bytes(), &resp))

	// Diagonals: both datasets keep at least one sample/regulator under
	// their respective filters.
	byName := map[string]domain.MatrixDiagonalCell{}
	for _, c := range resp.Diagonal {
		byName[c.DBName] = c
	}
	cc, ok := byName["callingcards"]
	require.True(t, ok)
	require.Greater(t, cc.NRegulators, int64(0), "callingcards regulators under YPD filter")
	require.Greater(t, cc.NSamples, int64(0), "callingcards samples under YPD filter")
	require.Equal(t, int64(6), cc.NSamples, "7 rows minus cc_extra (SC) = 6")

	hk, ok := byName["hackett"]
	require.True(t, ok)
	require.Greater(t, hk.NRegulators, int64(0), "hackett regulators in time [40,50]")
	require.Greater(t, hk.NSamples, int64(0), "hackett samples in time [40,50]")

	// Cross cell: at least one common regulator survives both filters,
	// and both sample-count subqueries return >= 1.
	require.Len(t, resp.CrossDataset, 1)
	cross := resp.CrossDataset[0]
	require.Equal(t, "callingcards__hackett", cross.PairID)
	require.GreaterOrEqual(t, cross.NCommon, int64(1), "expected >=1 common regulator across filtered arms")
	require.GreaterOrEqual(t, cross.SamplesA, int64(1), "callingcards samples in cross with hackett")
	require.GreaterOrEqual(t, cross.SamplesB, int64(1), "hackett samples in cross with callingcards")
}

// ---------------------------------------------------------------------------
// SelectionBreakdown
// ---------------------------------------------------------------------------

func TestSelectionBreakdown_Callingcards(t *testing.T) {
	s := newTestServer(t)
	rr := httptest.NewRecorder()
	q := url.Values{}
	q.Set("dataset", "callingcards")
	req := httptest.NewRequest("GET", apiVPath(s, "/selection/breakdown")+"?"+q.Encode(), nil)
	s.Routes().ServeHTTP(rr, req)
	require.Equal(t, 200, rr.Code, rr.Body.String())

	var resp domain.BreakdownResponse
	require.NoError(t, json.Unmarshal(rr.Body.Bytes(), &resp))
	require.Equal(t, "callingcards", resp.DBName)
	// All 3 regulators appear in >1 sample (YBR289W:3, YML007W:2, YGL073W:2).
	require.Equal(t, int64(3), resp.NMulti)

	// `condition` is the only manifest-eligible column for callingcards.
	// YBR289W has 2 distinct conditions (YPD + SC); the other two each have 1.
	// So count(*) FILTER (WHERE distinct_per_reg > 1) = 1.
	byField := map[string]int64{}
	for _, c := range resp.Columns {
		byField[c.Field] = c.DistinctValues
	}
	require.Equal(t, int64(1), byField["condition"])
}

func TestSelectionBreakdown_Hackett(t *testing.T) {
	s := newTestServer(t)
	rr := httptest.NewRecorder()
	q := url.Values{}
	q.Set("dataset", "hackett")
	req := httptest.NewRequest("GET", apiVPath(s, "/selection/breakdown")+"?"+q.Encode(), nil)
	s.Routes().ServeHTTP(rr, req)
	require.Equal(t, 200, rr.Code, rr.Body.String())

	var resp domain.BreakdownResponse
	require.NoError(t, json.Unmarshal(rr.Body.Bytes(), &resp))
	// Only YBR289W has 2 samples (h_0 + h_3); others are single.
	require.Equal(t, int64(1), resp.NMulti)
	// `time` is the eligible manifest column for hackett (mechanism/restriction/
	// date/strain are not in field_manifest for the fixture). YBR289W's two
	// samples share time=45, so the per-reg distinct count is 1 → the FILTER
	// (WHERE > 1) count is 0.
	byField := map[string]int64{}
	for _, c := range resp.Columns {
		byField[c.Field] = c.DistinctValues
	}
	require.Equal(t, int64(0), byField["time"])
}

func TestSelectionBreakdown_MissingDataset400(t *testing.T) {
	s := newTestServer(t)
	rr := httptest.NewRecorder()
	req := httptest.NewRequest("GET", apiVPath(s, "/selection/breakdown"), nil)
	s.Routes().ServeHTTP(rr, req)
	require.Equal(t, 400, rr.Code)
}

func TestSelectionBreakdown_UnknownDataset400(t *testing.T) {
	s := newTestServer(t)
	rr := httptest.NewRecorder()
	q := url.Values{}
	q.Set("dataset", "nope")
	req := httptest.NewRequest("GET", apiVPath(s, "/selection/breakdown")+"?"+q.Encode(), nil)
	s.Routes().ServeHTTP(rr, req)
	require.Equal(t, 400, rr.Code)
}

func TestSelectionMatrix_CacheCanonicalization(t *testing.T) {
	// Datasets are normalized to sorted() before pairs are computed, so the
	// cache key for ?datasets=A,B and ?datasets=B,A must be identical and
	// the second request must HIT.
	s := newTestServer(t)

	for _, order := range []string{"callingcards,hackett", "hackett,callingcards"} {
		rr := httptest.NewRecorder()
		q := url.Values{}
		q.Set("datasets", order)
		req := httptest.NewRequest("GET", apiVPath(s, "/selection/matrix")+"?"+q.Encode(), nil)
		s.Routes().ServeHTTP(rr, req)
		require.Equal(t, 200, rr.Code, rr.Body.String())
	}
	// Second request should be a HIT.
	require.GreaterOrEqual(t, s.Cache.Hits(), int64(1), "expected at least one cache HIT after permuted datasets param")
}

func TestSelectionBreakdown_FilterRejectsUnknownField(t *testing.T) {
	s := newTestServer(t)
	rr := httptest.NewRecorder()
	q := url.Values{}
	q.Set("dataset", "callingcards")
	q.Set("filters", `{"callingcards":{"not_a_field":{"type":"categorical","value":["x"]}}}`)
	req := httptest.NewRequest("GET", apiVPath(s, "/selection/breakdown")+"?"+q.Encode(), nil)
	s.Routes().ServeHTTP(rr, req)
	require.Equal(t, 400, rr.Code)
}
