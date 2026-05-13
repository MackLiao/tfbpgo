// Package parity is the cross-language parity harness described in spec
// §11.3.1. It hits the Go backend via httptest and compares each response
// against a recorded JSON fixture from the Python reference. When the
// fixture file is missing the sub-test t.Skip()s — that is the expected
// state on a fresh checkout, until `make parity-record` is run.
package parity

import (
	"encoding/json"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// goldenEntry mirrors one row in golden_urls.json.
type goldenEntry struct {
	Name      string  `json:"name"`
	URL       string  `json:"url"`
	Tolerance float64 `json:"tolerance"`
}

// fixtureDir is where recorded reference JSON lives.
const fixtureDir = "fixtures"

// TestParity_GoldenURLs walks golden_urls.json and verifies each URL.
// Sub-tests skip when the corresponding recorded fixture is absent.
func TestParity_GoldenURLs(t *testing.T) {
	t.Parallel()

	raw, err := os.ReadFile("golden_urls.json")
	require.NoError(t, err, "golden_urls.json must exist")
	var golden []goldenEntry
	require.NoError(t, json.Unmarshal(raw, &golden))
	require.NotEmpty(t, golden)

	srv, version := buildTestServer(t)
	if srv == nil {
		t.Skipf("skipping parity harness: server bootstrap unavailable in this env")
	}
	defer srv.Close()

	for _, g := range golden {
		g := g
		t.Run(g.Name, func(t *testing.T) {
			t.Parallel()

			fixturePath := filepath.Join(fixtureDir, g.Name+".json")
			expected, err := os.ReadFile(fixturePath)
			if os.IsNotExist(err) {
				t.Skipf("golden fixture missing: %s — run `make parity-record`", fixturePath)
				return
			}
			require.NoError(t, err)

			url := strings.Replace(g.URL, "{v}", version, 1)
			resp, err := http.Get(srv.URL + url)
			require.NoError(t, err)
			defer resp.Body.Close()
			require.Equal(t, http.StatusOK, resp.StatusCode, "non-200 from %s", url)

			body, err := io.ReadAll(resp.Body)
			require.NoError(t, err)

			tol := g.Tolerance
			if tol == 0 {
				tol = 1e-9
			}
			require.NoError(t, compareJSON(expected, body, tol),
				"parity diff for %s (%s)", g.Name, url)
		})
	}
}

// compareJSON deep-compares two JSON byte slices applying spec §11.3.1
// tolerances: relative tolerance for floats, exact match for ints / strings
// / bools, structural match for arrays and objects. Empty / unparseable
// inputs return an error.
func compareJSON(want, got []byte, tol float64) error {
	var w, g any
	if err := json.Unmarshal(want, &w); err != nil {
		return jsonErr("want unmarshal", err)
	}
	if err := json.Unmarshal(got, &g); err != nil {
		return jsonErr("got unmarshal", err)
	}
	return compareAny("$", w, g, tol)
}

// compareAny dispatches by Go type. JSON numbers come back as float64.
func compareAny(path string, want, got any, tol float64) error {
	switch w := want.(type) {
	case nil:
		if got != nil {
			return diffErr(path, "want null, got non-null")
		}
		return nil
	case bool:
		gb, ok := got.(bool)
		if !ok || gb != w {
			return diffErr(path, "bool mismatch")
		}
		return nil
	case string:
		gs, ok := got.(string)
		if !ok || gs != w {
			return diffErr(path, "string mismatch")
		}
		return nil
	case float64:
		gf, ok := got.(float64)
		if !ok {
			return diffErr(path, "number type mismatch")
		}
		// Integer-looking values match exactly per §11.3.1.
		if w == math.Trunc(w) && gf == math.Trunc(gf) {
			if w != gf {
				return diffErr(path, "integer mismatch")
			}
			return nil
		}
		if !floatClose(w, gf, tol) {
			return diffErr(path, "float diff exceeds tolerance")
		}
		return nil
	case []any:
		ga, ok := got.([]any)
		if !ok {
			return diffErr(path, "array type mismatch")
		}
		if len(ga) != len(w) {
			return diffErr(path, "array length mismatch")
		}
		for i := range w {
			if err := compareAny(path+"["+itoa(i)+"]", w[i], ga[i], tol); err != nil {
				return err
			}
		}
		return nil
	case map[string]any:
		gm, ok := got.(map[string]any)
		if !ok {
			return diffErr(path, "object type mismatch")
		}
		if len(gm) != len(w) {
			return diffErr(path, "object size mismatch")
		}
		for k, v := range w {
			gv, ok := gm[k]
			if !ok {
				return diffErr(path+"."+k, "key missing in got")
			}
			if err := compareAny(path+"."+k, v, gv, tol); err != nil {
				return err
			}
		}
		return nil
	default:
		return diffErr(path, "unsupported JSON type")
	}
}

// floatClose checks |w-g| / max(|w|,|g|) <= tol.
func floatClose(w, g, tol float64) bool {
	if w == g {
		return true
	}
	denom := math.Max(math.Abs(w), math.Abs(g))
	if denom == 0 {
		return true
	}
	return math.Abs(w-g)/denom <= tol
}

type cmpError struct{ path, msg string }

func (e cmpError) Error() string { return e.path + ": " + e.msg }

func diffErr(path, msg string) error { return cmpError{path: path, msg: msg} }

func jsonErr(stage string, err error) error { return cmpError{path: stage, msg: err.Error()} }

// itoa avoids the strconv import for a one-liner.
func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	neg := i < 0
	if neg {
		i = -i
	}
	var b [20]byte
	bp := len(b)
	for i > 0 {
		bp--
		b[bp] = byte('0' + i%10)
		i /= 10
	}
	if neg {
		bp--
		b[bp] = '-'
	}
	return string(b[bp:])
}

// buildTestServer is intentionally minimal in this scaffolding step. It
// returns (nil, "") so the harness skips cleanly when the parity fixtures
// haven't been recorded. Wiring it to the full backend (with a local DuckDB
// fixture) lives in a follow-up commit once Python-side fixtures exist.
func buildTestServer(t *testing.T) (*httptest.Server, string) {
	t.Helper()
	return nil, ""
}
