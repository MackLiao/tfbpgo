package db

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestWhitelist_Datasets(t *testing.T) {
	wl, err := NewWhitelist(&Manifests{
		Datasets: []DatasetRow{{DBName: "callingcards", DataType: "binding", SampleIDField: "sample_id"}},
		Fields:   []FieldRow{{DBName: "callingcards", Field: "condition"}},
	})
	require.NoError(t, err)
	require.NoError(t, wl.CheckDataset("callingcards"))
	require.Error(t, wl.CheckDataset("legitimate'); DROP TABLE x; --"))
	require.Error(t, wl.CheckDataset("unknown_db"))
}

func TestWhitelist_Fields(t *testing.T) {
	wl, err := NewWhitelist(&Manifests{
		Datasets: []DatasetRow{{DBName: "callingcards"}},
		Fields:   []FieldRow{{DBName: "callingcards", Field: "condition"}},
	})
	require.NoError(t, err)
	require.NoError(t, wl.CheckField("callingcards", "condition"))
	require.Error(t, wl.CheckField("callingcards", "regulator_locus_tag"))
	require.Error(t, wl.CheckField("callingcards", "DROP TABLE x"))
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
