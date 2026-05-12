package db

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestWhitelist_Datasets(t *testing.T) {
	wl := NewWhitelist(&Manifests{
		Datasets: []DatasetRow{{DBName: "callingcards", DataType: "binding", SampleIDField: "sample_id"}},
		Fields:   []FieldRow{{DBName: "callingcards", Field: "condition"}},
	})
	require.NoError(t, wl.CheckDataset("callingcards"))
	require.Error(t, wl.CheckDataset("legitimate'); DROP TABLE x; --"))
	require.Error(t, wl.CheckDataset("unknown_db"))
}

func TestWhitelist_Fields(t *testing.T) {
	wl := NewWhitelist(&Manifests{
		Datasets: []DatasetRow{{DBName: "callingcards"}},
		Fields:   []FieldRow{{DBName: "callingcards", Field: "condition"}},
	})
	require.NoError(t, wl.CheckField("callingcards", "condition"))
	require.Error(t, wl.CheckField("callingcards", "regulator_locus_tag"))
	require.Error(t, wl.CheckField("callingcards", "DROP TABLE x"))
	require.Error(t, wl.CheckField("unknown_db", "condition"))
}
