package api

// Regression coverage for the four real-data bug CLASSES from commit
// e10cfa4. The synthetic fixture historically sidestepped each by
// construction (empty harbison stub → no NaN measurement, no SQL-keyword
// column); build_fixture.py now populates harbison with an IEEE-NaN effect
// cell, a constant (zero-variance) effect column, and a genomic `end`
// keyword column so these paths are exercised end-to-end.

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"
)

func getJSON(t *testing.T, s *Server, path string) (int, []byte) {
	t.Helper()
	rr := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/api/v/"+s.Manifests.Artifact.ArtifactVersion+path, nil)
	s.Routes().ServeHTTP(rr, req)
	return rr.Code, rr.Body.Bytes()
}

// BUG 2: a NaN measurement value in a binding data row must serialize as
// JSON null (SafeFloat), not 500 the whole response. harbison.effect carries
// exactly one NaN cell (regulator YBR289W, target YAL001C).
func TestBinding_NaNValueSerializesAsNull(t *testing.T) {
	s := newTestServer(t)
	code, body := getJSON(t, s, "/binding?regulator=YBR289W&datasets=harbison")
	require.Equalf(t, 200, code, "NaN effect must not 500; body=%s", body)

	var resp struct {
		Datasets []struct {
			Rows []struct {
				Value json.RawMessage `json:"value"`
			} `json:"rows"`
		} `json:"datasets"`
	}
	require.NoError(t, json.Unmarshal(body, &resp))
	require.NotEmpty(t, resp.Datasets, "expected harbison dataset block")

	nullCount := 0
	for _, d := range resp.Datasets {
		require.NotEmpty(t, d.Rows, "expected harbison rows for YBR289W")
		for _, row := range d.Rows {
			if string(row.Value) == "null" {
				nullCount++
			} else {
				// Every non-null value must be a valid finite JSON number.
				var f float64
				require.NoErrorf(t, json.Unmarshal(row.Value, &f),
					"value must be number or null, got %s", row.Value)
			}
		}
	}
	require.Equal(t, 1, nullCount, "the single NaN effect cell must render as null")
}

// BUG 2: DuckDB corr() returns NaN on a zero-variance group. The /binding/corr
// handler must drop those rows (mirrors the reference's
// df.dropna(subset=["correlation"])) rather than 500. harbison.effect is held
// constant, so every (callingcards, harbison) correlation group is NaN.
func TestBindingCorr_DropsNaNCorrelations(t *testing.T) {
	s := newTestServer(t)
	code, body := getJSON(t, s,
		"/binding/corr?method=pearson&col=effect&datasets=callingcards,harbison")
	require.Equalf(t, 200, code, "NaN corr must be dropped, not 500; body=%s", body)

	var resp struct {
		Pairs []struct {
			Points []struct {
				Correlation json.RawMessage `json:"correlation"`
			} `json:"points"`
		} `json:"pairs"`
	}
	require.NoError(t, json.Unmarshal(body, &resp))
	for _, p := range resp.Pairs {
		for _, pt := range p.Points {
			require.NotEqual(t, "null", string(pt.Correlation),
				"NaN correlations must be dropped, not emitted as null")
			var f float64
			require.NoErrorf(t, json.Unmarshal(pt.Correlation, &f),
				"surviving correlation must be a finite number, got %s", pt.Correlation)
		}
	}
}

// BUG 1: a SQL reserved-keyword column (`end`) in condition_cols flows
// UNQUOTED through the sample-conditions CAST projection. It must be
// double-quoted so DuckDB's parser doesn't choke. harbison's condition_cols
// is "condition,end".
func TestSampleConditions_KeywordColumnIsQuoted(t *testing.T) {
	s := newTestServer(t)
	code, body := getJSON(t, s, "/datasets/harbison/sample-conditions")
	require.Equalf(t, 200, code,
		"reserved-keyword condition column must be quoted, not ParserError 500; body=%s", body)
}

// BUG 1 (regression lock): a numeric field literally named `end` must flow
// through computeNumericRange's double-quoted MIN/MAX. Also exercises the
// BUG 2 NaN coercion: harbison.effect MIN/MAX is NaN and must report as a
// null (unbounded) range, not 500.
func TestDatasetFields_KeywordAndNaNNumericRanges(t *testing.T) {
	s := newTestServer(t)
	code, body := getJSON(t, s, "/datasets/harbison/fields")
	require.Equalf(t, 200, code, "keyword/NaN numeric ranges must not 500; body=%s", body)

	var resp struct {
		Fields []struct {
			Field      string          `json:"field"`
			NumericMin json.RawMessage `json:"numericMin"`
			NumericMax json.RawMessage `json:"numericMax"`
		} `json:"fields"`
	}
	require.NoError(t, json.Unmarshal(body, &resp))
	byField := map[string]struct{ min, max string }{}
	for _, f := range resp.Fields {
		byField[f.Field] = struct{ min, max string }{string(f.NumericMin), string(f.NumericMax)}
	}
	end, ok := byField["end"]
	require.True(t, ok, "`end` field must be present")
	// `end` coordinates are finite integers → bounded range.
	require.NotEqual(t, "null", end.min, "`end` numericMin should be finite")
	require.NotEqual(t, "null", end.max, "`end` numericMax should be finite")
}

// BUG 3 (consistency guard): every dataset_manifest.sample_id_field must name
// a real column in {db}_meta. Catches a manifest/table drift like the
// fixture-vs-real inversion the BUG 3 fix risked.
func TestManifest_SampleIDFieldExistsInMetaTable(t *testing.T) {
	s := newTestServer(t)
	for _, d := range s.Whitelist.AllDatasets() {
		var n int
		err := s.Pool.DB.GetContext(context.Background(), &n,
			`SELECT COUNT(*) FROM information_schema.columns
			 WHERE table_name = ? AND column_name = ?`,
			d.DBName+"_meta", d.SampleIDField)
		require.NoErrorf(t, err, "introspect %s_meta", d.DBName)
		require.Equalf(t, 1, n,
			"dataset_manifest.sample_id_field %q must exist in %s_meta",
			d.SampleIDField, d.DBName)
	}
}

// BUG 5 (consistency guard): every column named in dataset_manifest.condition_cols
// must be a real column in {db}_meta. This is the class behind the real-data
// callingcards 500 — the manifest claimed `condition`, but callingcards_meta
// had no such column, so the sample-conditions CAST projection raised
// "Column condition ... cannot be referenced before it is defined". data_prep
// now derives condition_cols from the same {db}_meta introspection, so this
// guard must hold for every dataset on every built artifact.
func TestManifest_ConditionColsExistInMetaTable(t *testing.T) {
	s := newTestServer(t)
	for _, d := range s.Whitelist.AllDatasets() {
		for _, col := range parseConditionCols(d.ConditionCols) {
			var n int
			err := s.Pool.DB.GetContext(context.Background(), &n,
				`SELECT COUNT(*) FROM information_schema.columns
				 WHERE table_name = ? AND column_name = ?`,
				d.DBName+"_meta", col)
			require.NoErrorf(t, err, "introspect %s_meta", d.DBName)
			require.Equalf(t, 1, n,
				"dataset_manifest.condition_cols column %q must exist in %s_meta",
				col, d.DBName)
		}
	}
}
