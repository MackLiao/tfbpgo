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
	require.Equal(t, 4, m.Artifact.SchemaVersion)
	require.False(t, m.Artifact.ParityTestsPassed)

	require.Len(t, m.Datasets, 2)
	for _, ds := range m.Datasets {
		require.NotEmpty(t, ds.SampleIDField, "v2 schema requires sample_id_field")
		require.NotEmpty(t, ds.EffectCol, "v3 schema requires non-empty effect_col for %s", ds.DBName)
	}
	dsByName := map[string]DatasetRow{}
	for _, ds := range m.Datasets {
		dsByName[ds.DBName] = ds
	}
	require.Contains(t, dsByName, "callingcards")
	require.Contains(t, dsByName, "hackett")
	// v3-specific assertions: effect/pvalue cols carried in the artifact.
	require.Equal(t, "callingcards_enrichment", dsByName["callingcards"].EffectCol)
	require.Equal(t, "poisson_pval", dsByName["callingcards"].PValueCol)
	require.Equal(t, "log2_shrunken_timecourses", dsByName["hackett"].EffectCol)
	require.Equal(t, "", dsByName["hackett"].PValueCol,
		"hackett intentionally has no p-value column — see buildResponsiveExpr")

	// v4: dataset_manifest carries DefaultActive / DefaultFilters /
	// ConditionCols. Both fixture datasets are default_active=TRUE; only
	// hackett has a preset default_filters spec; both carry condition_cols.
	require.True(t, dsByName["callingcards"].DefaultActive)
	require.Equal(t, "", dsByName["callingcards"].DefaultFilters)
	require.Equal(t, "condition", dsByName["callingcards"].ConditionCols)
	require.True(t, dsByName["hackett"].DefaultActive)
	require.Equal(t,
		`{"time":{"type":"numeric","value":[45,45]}}`,
		dsByName["hackett"].DefaultFilters,
	)
	require.Equal(t, "mechanism,restriction,time", dsByName["hackett"].ConditionCols)

	// Widened in Phase 3 to cover production-only columns referenced by
	// the binding/perturbation/topn handlers (poisson_pval,
	// callingcards_enrichment, log2_shrunken_timecourses, time, condition).
	// Assert key membership rather than a brittle length: the fixture may
	// gain additional manifest rows without breaking handler contracts.
	got := map[string]bool{}
	for _, f := range m.Fields {
		got[f.DBName+"."+f.Field] = true
	}
	required := []string{
		"callingcards.target_locus_tag",
		"callingcards.score",
		"callingcards.poisson_pval",
		"callingcards.callingcards_enrichment",
		"callingcards.condition",
		"hackett.target_locus_tag",
		"hackett.effect",
		"hackett.pvalue",
		"hackett.log2_shrunken_timecourses",
		"hackett.time",
	}
	for _, k := range required {
		require.True(t, got[k], "missing field_manifest entry: %s", k)
	}
	require.NotEmpty(t, m.Levels)

	// v3: field_manifest.role carries the experimental_condition classification.
	roleByKey := map[string]string{}
	fieldByKey := map[string]FieldRow{}
	for _, f := range m.Fields {
		roleByKey[f.DBName+"."+f.Field] = f.Role
		fieldByKey[f.DBName+"."+f.Field] = f
	}
	require.Equal(t, "experimental_condition", roleByKey["callingcards.condition"])
	require.Equal(t, "experimental_condition", roleByKey["hackett.time"])
	// Sanity-check that a non-condition field has the empty role.
	require.Equal(t, "", roleByKey["callingcards.target_locus_tag"])

	// v4: field_manifest carries per-(db, field) UX metadata. At least one
	// row (hackett.time) must surface UIKindOverride=="categorical" so the
	// frontend renders a selectize for it; everything else stays empty.
	require.Equal(t, "categorical", fieldByKey["hackett.time"].UIKindOverride)
	require.Equal(t, "numeric", fieldByKey["hackett.time"].NumericLevelSort)
	require.Equal(t, "", fieldByKey["callingcards.score"].UIKindOverride)
	require.Equal(t, "", fieldByKey["callingcards.score"].Description)
	require.Equal(t, "", fieldByKey["callingcards.score"].LevelDefinitions)
}
