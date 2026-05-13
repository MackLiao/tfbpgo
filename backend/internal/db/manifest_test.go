package db

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestLoadManifests_FromBootstrappedFixture(t *testing.T) {
	bootstrap := bootstrappedFixturePath(t)
	pool, err := Open(Options{Path: bootstrap, TempDir: t.TempDir()})
	require.NoError(t, err)
	defer pool.Close()

	m, err := LoadManifests(context.Background(), pool)
	require.NoError(t, err)
	require.Equal(t, "test-fixture", m.Artifact.ArtifactVersion)
	require.Equal(t, 2, m.Artifact.SchemaVersion)
	require.False(t, m.Artifact.ParityTestsPassed)

	require.Len(t, m.Datasets, 2)
	for _, ds := range m.Datasets {
		require.NotEmpty(t, ds.SampleIDField, "v2 schema requires sample_id_field")
	}
	dbNames := map[string]bool{}
	for _, ds := range m.Datasets {
		dbNames[ds.DBName] = true
	}
	require.True(t, dbNames["callingcards"])
	require.True(t, dbNames["hackett"])

	// Widened in Phase 3 to cover production-only columns referenced by
	// the binding/perturbation/topn handlers (poisson_pval,
	// callingcards_enrichment, log2_shrunken_timecourses, time, condition).
	require.Len(t, m.Fields, 10)
	require.NotEmpty(t, m.Levels)
}
