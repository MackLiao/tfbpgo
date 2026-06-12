package db

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestWhitelist_Datasets(t *testing.T) {
	wl, err := NewWhitelist(&Manifests{
		Datasets: []DatasetRow{{DBName: "harbison", DataType: "binding", SampleIDField: "sample_id"}},
		Fields:   []FieldRow{{DBName: "harbison", Field: "condition"}},
	})
	require.NoError(t, err)
	require.NoError(t, wl.CheckDataset("harbison"))
	require.Error(t, wl.CheckDataset("legitimate'); DROP TABLE x; --"))
	require.Error(t, wl.CheckDataset("unknown_db"))
}

func TestWhitelist_Fields(t *testing.T) {
	wl, err := NewWhitelist(&Manifests{
		Datasets: []DatasetRow{{DBName: "harbison"}},
		Fields:   []FieldRow{{DBName: "harbison", Field: "condition"}},
	})
	require.NoError(t, err)
	require.NoError(t, wl.CheckField("harbison", "condition"))
	require.Error(t, wl.CheckField("harbison", "regulator_locus_tag"))
	require.Error(t, wl.CheckField("harbison", "DROP TABLE x"))
	require.Error(t, wl.CheckField("unknown_db", "condition"))
}

// TestNewWhitelist_RejectsUnsafeIdent locks defense-in-depth: even though
// upstream guarantees safe identifiers, we re-verify so a hand-edited
// DuckDB file cannot inject SQL through the manifest.
func TestNewWhitelist_RejectsUnsafeIdent(t *testing.T) {
	cases := []struct {
		name   string
		manifs *Manifests
	}{
		{
			name: "dataset_name_with_quote",
			manifs: &Manifests{
				Datasets: []DatasetRow{{DBName: "foo; DROP TABLE x"}},
			},
		},
		{
			name: "dataset_name_with_space",
			manifs: &Manifests{
				Datasets: []DatasetRow{{DBName: "foo bar"}},
			},
		},
		{
			name: "field_name_with_paren",
			manifs: &Manifests{
				Datasets: []DatasetRow{{DBName: "ok"}},
				Fields:   []FieldRow{{DBName: "ok", Field: "evil()"}},
			},
		},
		{
			name: "field_dbname_unsafe",
			manifs: &Manifests{
				Datasets: []DatasetRow{{DBName: "ok"}},
				Fields:   []FieldRow{{DBName: "ok'); --", Field: "x"}},
			},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := NewWhitelist(tc.manifs)
			require.Error(t, err)
		})
	}
}

// TestNewWhitelist_RejectsUnsafeEffectCol locks the v3 gate: effect_col
// is interpolated into SQL by buildResponsiveExpr, so a malicious value
// in the manifest must be rejected at startup.
func TestNewWhitelist_RejectsUnsafeEffectCol(t *testing.T) {
	_, err := NewWhitelist(&Manifests{
		Datasets: []DatasetRow{
			{DBName: "kemmeren", EffectCol: "x; DROP TABLE foo; --", PValueCol: "pval"},
		},
	})
	require.Error(t, err)
	require.Contains(t, err.Error(), "unsafe effect_col")
}

// TestNewWhitelist_RejectsUnsafePValueCol — same gate for pvalue_col.
func TestNewWhitelist_RejectsUnsafePValueCol(t *testing.T) {
	_, err := NewWhitelist(&Manifests{
		Datasets: []DatasetRow{
			{DBName: "kemmeren", EffectCol: "Madj", PValueCol: "pval'); DROP TABLE foo; --"},
		},
	})
	require.Error(t, err)
	require.Contains(t, err.Error(), "unsafe pvalue_col")
}

// TestNewWhitelist_RejectsUnsafeSampleIDField locks defense-in-depth on
// `dataset_manifest.sample_id_field`. The column is interpolated into
// SQL by the /sample-conditions handler, so an unsafe value in a
// hand-edited DuckDB file must be rejected at startup.
func TestNewWhitelist_RejectsUnsafeSampleIDField(t *testing.T) {
	_, err := NewWhitelist(&Manifests{
		Datasets: []DatasetRow{
			{DBName: "callingcards", SampleIDField: "gm_id; DROP TABLE foo; --"},
		},
	})
	require.Error(t, err)
	require.Contains(t, err.Error(), "unsafe sample_id_field")
}

// TestNewWhitelist_AllowsEmptyPValueCol — hackett/hughes_* legitimately
// have an empty pvalue_col, which must NOT be rejected.
func TestNewWhitelist_AllowsEmptyPValueCol(t *testing.T) {
	_, err := NewWhitelist(&Manifests{
		Datasets: []DatasetRow{
			{DBName: "hackett", EffectCol: "log2_shrunken_timecourses", PValueCol: ""},
		},
	})
	require.NoError(t, err)
}

// TestNewWhitelist_RejectsUnsafeLog10PCol locks the v6 gate: log10p_col is
// interpolated into SQL by api.resolveMeasurementCol → renderCorrPairSQL /
// renderScatterSQL → quotedIdent, so a malicious value in a hand-edited
// manifest must be rejected at startup, not on the first col=log10pval
// request.
func TestNewWhitelist_RejectsUnsafeLog10PCol(t *testing.T) {
	_, err := NewWhitelist(&Manifests{
		Datasets: []DatasetRow{
			{DBName: "rossi", Log10PCol: "x; DROP TABLE y"},
		},
	})
	require.Error(t, err)
	require.Contains(t, err.Error(), "unsafe log10p_col")
}

// TestNewWhitelist_RejectsUnsafeNegLog10PCol — same v6 gate for
// neglog10p_col, which feeds the same SQL-interpolation path.
func TestNewWhitelist_RejectsUnsafeNegLog10PCol(t *testing.T) {
	_, err := NewWhitelist(&Manifests{
		Datasets: []DatasetRow{
			{DBName: "rossi", NegLog10PCol: "x; DROP TABLE y"},
		},
	})
	require.Error(t, err)
	require.Contains(t, err.Error(), "unsafe neglog10p_col")
}

// TestNewWhitelist_AllowsWellFormedLog10PCols — the base rossi / chec_m2025
// binding datasets carry real log10 / -log10 p-value column names. A
// well-formed pair (and the empty pair used by every other dataset) must
// pass the v6 gate.
func TestNewWhitelist_AllowsWellFormedLog10PCols(t *testing.T) {
	_, err := NewWhitelist(&Manifests{
		Datasets: []DatasetRow{
			{DBName: "rossi", Log10PCol: "log10_pval", NegLog10PCol: "neg_log10_pval"},
			{DBName: "hackett", Log10PCol: "", NegLog10PCol: ""},
		},
	})
	require.NoError(t, err)
}

// TestNewWhitelist_DatasetIdentColumnsAllReVerified is a security-suite
// checklist: it ENUMERATES every identifier-shaped dataset_manifest column
// that lands in interpolated SQL and asserts each one independently rejects
// an unsafe value. If a future schema bump adds another interpolated column
// without a SafeIdentRE guard in NewWhitelist, the maintainer must extend
// this table — the failing-to-extend case is what catches the missing
// guard in review. condition_cols / upstream_cols are CSV-encoded, so the
// unsafe payload is supplied as a single token.
func TestNewWhitelist_DatasetIdentColumnsAllReVerified(t *testing.T) {
	const payload = "x; DROP TABLE y"
	cases := []struct {
		// column is the dataset_manifest column under test; mutate sets
		// the unsafe payload on a fresh DatasetRow.
		column string
		mutate func(*DatasetRow)
		// substr is a fragment of the expected error so the assertion is
		// pinned to the right guard, not just "some error".
		substr string
	}{
		{
			column: "effect_col",
			mutate: func(d *DatasetRow) { d.EffectCol = payload },
			substr: "unsafe effect_col",
		},
		{
			column: "pvalue_col",
			mutate: func(d *DatasetRow) { d.PValueCol = payload },
			substr: "unsafe pvalue_col",
		},
		{
			column: "sample_id_field",
			mutate: func(d *DatasetRow) { d.SampleIDField = payload },
			substr: "unsafe sample_id_field",
		},
		{
			column: "log10p_col",
			mutate: func(d *DatasetRow) { d.Log10PCol = payload },
			substr: "unsafe log10p_col",
		},
		{
			column: "neglog10p_col",
			mutate: func(d *DatasetRow) { d.NegLog10PCol = payload },
			substr: "unsafe neglog10p_col",
		},
		{
			column: "condition_cols",
			mutate: func(d *DatasetRow) { d.ConditionCols = payload },
			substr: "unsafe condition_cols",
		},
		{
			column: "upstream_cols",
			mutate: func(d *DatasetRow) { d.UpstreamCols = payload },
			substr: "unsafe upstream_cols",
		},
	}
	for _, tc := range cases {
		t.Run(tc.column, func(t *testing.T) {
			d := DatasetRow{DBName: "dataset_under_test"}
			tc.mutate(&d)
			_, err := NewWhitelist(&Manifests{Datasets: []DatasetRow{d}})
			require.Error(t, err)
			require.Contains(t, err.Error(), tc.substr)
		})
	}
}

// TestNewWhitelist_RejectsUnsafeConditionCols locks the v4 manifest gate
// for `dataset_manifest.condition_cols`. Entries are CSV-encoded and
// interpolated into SQL by handlers that emit the sample-condition
// label, so any token that doesn't match SafeIdentRE must be rejected.
// The space inside "bad value" makes the second token unsafe.
func TestNewWhitelist_RejectsUnsafeConditionCols(t *testing.T) {
	_, err := NewWhitelist(&Manifests{
		Datasets: []DatasetRow{
			{DBName: "hackett", ConditionCols: "valid,bad value"},
		},
	})
	require.Error(t, err)
	// Either the whitespace check OR the SafeIdentRE check may fire,
	// depending on whether the token has leading whitespace. The token
	// "bad value" has no leading/trailing space (the space is internal),
	// so it lands on the unsafe-identifier branch.
	require.Contains(t, err.Error(), "bad value")
}

// TestNewWhitelist_RejectsWhitespaceConditionCols pins the decision
// recorded in whitelist.go: a leading/trailing space inside a CSV token
// is rejected so the artifact pipeline stays the single source of truth
// for canonical encoding. "good, also_bad" → token " also_bad".
func TestNewWhitelist_RejectsWhitespaceConditionCols(t *testing.T) {
	_, err := NewWhitelist(&Manifests{
		Datasets: []DatasetRow{
			{DBName: "hackett", ConditionCols: "good, also_bad"},
		},
	})
	require.Error(t, err)
	require.Contains(t, err.Error(), "whitespace")
}

// TestNewWhitelist_RejectsEmptyConditionColsToken — "a,,b" indicates a
// build-side bug; surface at startup rather than silently skip the gap.
func TestNewWhitelist_RejectsEmptyConditionColsToken(t *testing.T) {
	_, err := NewWhitelist(&Manifests{
		Datasets: []DatasetRow{
			{DBName: "hackett", ConditionCols: "a,,b"},
		},
	})
	require.Error(t, err)
	require.Contains(t, err.Error(), "empty condition_cols")
}

// TestNewWhitelist_RejectsOversizedDefaultFilters locks the
// defense-in-depth byte cap on `dataset_manifest.default_filters`. The
// JSON blob is forwarded opaquely to the frontend; a 16 KB ceiling
// keeps a hand-edited artifact from inflating response bodies.
func TestNewWhitelist_RejectsOversizedDefaultFilters(t *testing.T) {
	_, err := NewWhitelist(&Manifests{
		Datasets: []DatasetRow{
			{DBName: "hackett", DefaultFilters: strings.Repeat("x", 17*1024)},
		},
	})
	require.Error(t, err)
	require.Contains(t, err.Error(), "default_filters")
}

// TestNewWhitelist_RejectsOversizedDescription locks the 1 KB cap on
// `field_manifest.description`. Description is free-text tooltip copy
// the frontend renders as HTML-escaped text.
func TestNewWhitelist_RejectsOversizedDescription(t *testing.T) {
	_, err := NewWhitelist(&Manifests{
		Datasets: []DatasetRow{{DBName: "hackett"}},
		Fields: []FieldRow{
			{DBName: "hackett", Field: "time", Description: strings.Repeat("x", 1025)},
		},
	})
	require.Error(t, err)
	require.Contains(t, err.Error(), "description")
}

// TestNewWhitelist_RejectsOversizedLevelDefinitions locks the 16 KB cap
// on `field_manifest.level_definitions`.
func TestNewWhitelist_RejectsOversizedLevelDefinitions(t *testing.T) {
	_, err := NewWhitelist(&Manifests{
		Datasets: []DatasetRow{{DBName: "hackett"}},
		Fields: []FieldRow{
			{DBName: "hackett", Field: "time", LevelDefinitions: strings.Repeat("x", 17*1024)},
		},
	})
	require.Error(t, err)
	require.Contains(t, err.Error(), "level_definitions")
}

// TestNewWhitelist_RejectsUnknownUIKindOverride locks the closed-set
// check on `field_manifest.ui_kind_override`. Only "" | "categorical" |
// "numeric" | "bool" are admissible.
func TestNewWhitelist_RejectsUnknownUIKindOverride(t *testing.T) {
	_, err := NewWhitelist(&Manifests{
		Datasets: []DatasetRow{{DBName: "hackett"}},
		Fields: []FieldRow{
			{DBName: "hackett", Field: "time", UIKindOverride: "weird"},
		},
	})
	require.Error(t, err)
	require.Contains(t, err.Error(), "ui_kind_override")
}

// TestNewWhitelist_RejectsUnknownNumericLevelSort locks the closed-set
// check on `field_manifest.numeric_level_sort`. Only "" | "numeric" |
// "string" are admissible.
func TestNewWhitelist_RejectsUnknownNumericLevelSort(t *testing.T) {
	_, err := NewWhitelist(&Manifests{
		Datasets: []DatasetRow{{DBName: "hackett"}},
		Fields: []FieldRow{
			{DBName: "hackett", Field: "time", NumericLevelSort: "weird"},
		},
	})
	require.Error(t, err)
	require.Contains(t, err.Error(), "numeric_level_sort")
}
