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

func TestDatasetFields_HappyHarbison(t *testing.T) {
	s := newTestServer(t)

	rr := httptest.NewRecorder()
	req := httptest.NewRequest("GET", apiVPath(s, "/datasets/harbison/fields"), nil)
	s.Routes().ServeHTTP(rr, req)
	require.Equal(t, 200, rr.Code, rr.Body.String())

	var resp domain.DatasetFieldsResponse
	require.NoError(t, json.Unmarshal(rr.Body.Bytes(), &resp))
	require.Equal(t, "harbison", resp.DBName)
	require.NotEmpty(t, resp.Fields)

	byField := map[string]domain.FieldMeta{}
	for _, f := range resp.Fields {
		byField[f.Field] = f
	}

	// `condition` should be categorical with role=experimental_condition and
	// levels populated from filter_level_cache (SC via hb_extra, YPD otherwise).
	// (Condition lives on harbison — the binding dataset with a real condition
	// column; callingcards has none on real data.)
	condition, ok := byField["condition"]
	require.True(t, ok, "condition field missing")
	require.Equal(t, "experimental_condition", condition.Role)
	require.Equal(t, "categorical", condition.Kind)
	require.ElementsMatch(t, []string{"SC", "YPD"}, condition.Levels)

	// SD-3: data-only measurement columns (effect, pvalue, target_locus_tag)
	// are NOT filter fields — field_manifest is sourced from {db}_meta only, so
	// the modal cannot offer columns that would 500 when filtered against the
	// {db}_meta-scoped WHERE.
	_, hasEffect := byField["effect"]
	require.False(t, hasEffect, "data-only `effect` must not be a filter field (SD-3)")
	_, hasTarget := byField["target_locus_tag"]
	require.False(t, hasTarget, "data-only `target_locus_tag` must not be a filter field (SD-3)")
}

// Real-data shape: callingcards has no manifest-eligible filter column, so the
// /fields endpoint returns 200 with an empty Fields list (not a 500, not the
// fabricated `condition` field the old fixture invented).
func TestDatasetFields_CallingcardsHasNoFilterFields(t *testing.T) {
	s := newTestServer(t)

	rr := httptest.NewRecorder()
	req := httptest.NewRequest("GET", apiVPath(s, "/datasets/callingcards/fields"), nil)
	s.Routes().ServeHTTP(rr, req)
	require.Equal(t, 200, rr.Code, rr.Body.String())

	var resp domain.DatasetFieldsResponse
	require.NoError(t, json.Unmarshal(rr.Body.Bytes(), &resp))
	require.Equal(t, "callingcards", resp.DBName)
	require.Empty(t, resp.Fields, "callingcards exposes no filterable columns")
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
	require.Equal(t, int64(7), cc.NSamples)    // 7 distinct sample_ids in fixture

	hk, ok := byName["hackett"]
	require.True(t, ok)
	require.Equal(t, int64(3), hk.NRegulators)
	// SQL-1: hackett_meta is filtered to the analysis set, so the non-analysis
	// sample h_3 no longer leaks into the sample count — h_0..h_2 only.
	require.Equal(t, int64(3), hk.NSamples)

	// Cross cell.
	cross := resp.CrossDataset[0]
	require.Equal(t, "callingcards__hackett", cross.PairID)
	require.Equal(t, "callingcards", cross.DBA)
	require.Equal(t, "hackett", cross.DBB)
	require.Equal(t, int64(3), cross.NCommon)
	require.Equal(t, int64(7), cross.SamplesA)
	require.Equal(t, int64(3), cross.SamplesB)
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

// Condition-filter mechanics live on harbison: it is the binding dataset with
// a real `condition` column (callingcards has none on real data). hb_extra
// (SC, YBR289W) is the droppable sample; the other three are YPD.
func TestSelectionMatrix_WithHarbisonFilter(t *testing.T) {
	s := newTestServer(t)
	rr := httptest.NewRecorder()
	q := url.Values{}
	q.Set("datasets", "harbison,hackett")
	// Restrict harbison to condition=YPD; that drops hb_extra (SC, YBR289W).
	q.Set("filters", `{"harbison":{"condition":{"type":"categorical","value":["YPD"]}}}`)
	req := httptest.NewRequest("GET", apiVPath(s, "/selection/matrix")+"?"+q.Encode(), nil)
	s.Routes().ServeHTTP(rr, req)
	require.Equal(t, 200, rr.Code, rr.Body.String())

	var resp domain.MatrixResponse
	require.NoError(t, json.Unmarshal(rr.Body.Bytes(), &resp))
	byName := map[string]domain.MatrixDiagonalCell{}
	for _, c := range resp.Diagonal {
		byName[c.DBName] = c
	}
	require.Equal(t, int64(3), byName["harbison"].NSamples) // 4 - 1 (hb_extra)
	// All 3 regulators still represented (each has at least one YPD sample).
	require.Equal(t, int64(3), byName["harbison"].NRegulators)

	// Cross-cell NCommon pins the filter-arm INTERSECT semantics: filtered
	// harbison (YPD only — drops hb_extra/SC but keeps all 3 regulators since
	// each has at least one YPD sample) ∩ unfiltered hackett (3 regulators:
	// YBR289W, YML007W, YGL073W) = 3 common regulators. If the filter arm ever
	// leaked into / out of the INTERSECT subquery, this number would drift
	// (e.g. count hb_extra's YBR289W twice, or zero out the entire arm).
	require.Len(t, resp.CrossDataset, 1)
	cross := resp.CrossDataset[0]
	require.Equal(t, "hackett__harbison", cross.PairID)
	require.Equal(t, int64(3), cross.NCommon,
		"3 regulators common to YPD-filtered harbison and unfiltered hackett")
}

// P0-2: the common-regulators flow writes a `regulator_locus_tag` categorical
// filter to every active dataset. That field is hidden from field_manifest, but
// it is a real {db}_meta column and a legitimate WHERE target in Shiny
// (queries.py:45-48). The matrix/breakdown/export handlers must ACCEPT it
// (not 400) and APPLY it so the matrix narrows to the chosen regulators —
// matching Shiny's _matrix_data which passes dataset_filters() straight in.
func TestSelectionMatrix_WithRegulatorFilter(t *testing.T) {
	s := newTestServer(t)
	rr := httptest.NewRecorder()
	q := url.Values{}
	q.Set("datasets", "callingcards,hackett")
	// "Select N common regulators" writes regulator_locus_tag IN (...) to every
	// active dataset. Narrow to a single regulator (YBR289W).
	q.Set("filters", `{"callingcards":{"regulator_locus_tag":{"type":"categorical","value":["YBR289W"]}},"hackett":{"regulator_locus_tag":{"type":"categorical","value":["YBR289W"]}}}`)
	req := httptest.NewRequest("GET", apiVPath(s, "/selection/matrix")+"?"+q.Encode(), nil)
	s.Routes().ServeHTTP(rr, req)
	require.Equal(t, 200, rr.Code, rr.Body.String())

	var resp domain.MatrixResponse
	require.NoError(t, json.Unmarshal(rr.Body.Bytes(), &resp))
	byName := map[string]domain.MatrixDiagonalCell{}
	for _, c := range resp.Diagonal {
		byName[c.DBName] = c
	}
	// The matrix must be narrowed to the single chosen regulator.
	require.Equal(t, int64(1), byName["callingcards"].NRegulators)
	require.Equal(t, int64(1), byName["hackett"].NRegulators)
	require.Len(t, resp.CrossDataset, 1)
	require.Equal(t, int64(1), resp.CrossDataset[0].NCommon)
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
	q.Set("datasets", "harbison,hackett")
	// Both arms filtered: harbison by condition=YPD (drops hb_extra, leaving 3
	// rows); hackett by time in [40,50] (keeps the integer 45, which is the
	// only time value in the fixture).
	q.Set("filters",
		`{"harbison":{"condition":{"type":"categorical","value":["YPD"]}},`+
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
	hb, ok := byName["harbison"]
	require.True(t, ok)
	require.Greater(t, hb.NRegulators, int64(0), "harbison regulators under YPD filter")
	require.Equal(t, int64(3), hb.NSamples, "4 rows minus hb_extra (SC) = 3")

	hk, ok := byName["hackett"]
	require.True(t, ok)
	require.Greater(t, hk.NRegulators, int64(0), "hackett regulators in time [40,50]")
	require.Greater(t, hk.NSamples, int64(0), "hackett samples in time [40,50]")

	// Cross cell: at least one common regulator survives both filters, and
	// both sample-count subqueries return >= 1. PairID is alphabetically
	// sorted, so a=hackett, b=harbison (SamplesA↔hackett, SamplesB↔harbison).
	require.Len(t, resp.CrossDataset, 1)
	cross := resp.CrossDataset[0]
	require.Equal(t, "hackett__harbison", cross.PairID)
	require.GreaterOrEqual(t, cross.NCommon, int64(1), "expected >=1 common regulator across filtered arms")
	require.GreaterOrEqual(t, cross.SamplesA, int64(1), "hackett samples in cross with harbison")
	require.GreaterOrEqual(t, cross.SamplesB, int64(1), "harbison samples in cross with hackett")
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
	// Real-data shape: callingcards has NO manifest-eligible filter column (its
	// meta is just sample_id + the hidden regulator identifiers), so the
	// breakdown short-circuits to empty — NMulti=0 and no columns. (NMulti is
	// only populated relative to the candidate columns, so "no columns" means
	// "no breakdown".) The condition-distinct breakdown is covered on harbison
	// (TestSelectionBreakdown_Harbison).
	require.Equal(t, int64(0), resp.NMulti)
	require.Empty(t, resp.Columns, "callingcards exposes no filterable columns")
}

func TestSelectionBreakdown_Harbison(t *testing.T) {
	s := newTestServer(t)
	rr := httptest.NewRecorder()
	q := url.Values{}
	q.Set("dataset", "harbison")
	req := httptest.NewRequest("GET", apiVPath(s, "/selection/breakdown")+"?"+q.Encode(), nil)
	s.Routes().ServeHTTP(rr, req)
	require.Equal(t, 200, rr.Code, rr.Body.String())

	var resp domain.BreakdownResponse
	require.NoError(t, json.Unmarshal(rr.Body.Bytes(), &resp))
	require.Equal(t, "harbison", resp.DBName)
	// Only YBR289W appears in >1 sample (hb_0 + hb_extra); YML007W/YGL073W are
	// single-sample. So NMulti = 1.
	require.Equal(t, int64(1), resp.NMulti)

	byField := map[string]int64{}
	for _, c := range resp.Columns {
		byField[c.Field] = c.DistinctValues
	}
	// `condition`: YBR289W has 2 distinct (YPD via hb_0, SC via hb_extra); the
	// other two have 1 each → count(*) FILTER (distinct_per_reg > 1) = 1.
	require.Equal(t, int64(1), byField["condition"])
	// `end`: hb_extra reuses hb_0's coord (1000), so YBR289W is single-valued
	// in `end`; no regulator has >1 distinct end → 0.
	require.Equal(t, int64(0), byField["end"])
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
	// SQL-1: after filtering hackett to the analysis set, the previously
	// duplicated YBR289W sample (h_3) is gone, so every regulator now maps to a
	// single sample → no multi-sample regulators.
	require.Equal(t, int64(0), resp.NMulti)
	// `time` is the eligible manifest column for hackett; with no multi-sample
	// regulators the FILTER (WHERE distinct_per_reg > 1) count is 0.
	byField := map[string]int64{}
	for _, c := range resp.Columns {
		byField[c.Field] = c.DistinctValues
	}
	require.Equal(t, int64(0), byField["time"])
}

// P0-2: the breakdown modal opened after "Select N common regulators" carries
// a regulator_locus_tag filter; it must be accepted (not 400).
func TestSelectionBreakdown_AcceptsRegulatorFilter(t *testing.T) {
	s := newTestServer(t)
	rr := httptest.NewRecorder()
	q := url.Values{}
	q.Set("dataset", "callingcards")
	q.Set("filters", `{"callingcards":{"regulator_locus_tag":{"type":"categorical","value":["YBR289W"]}}}`)
	req := httptest.NewRequest("GET", apiVPath(s, "/selection/breakdown")+"?"+q.Encode(), nil)
	s.Routes().ServeHTTP(rr, req)
	require.Equal(t, 200, rr.Code, rr.Body.String())
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
