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
	require.Equal(t, 6, m.Artifact.SchemaVersion)
	require.False(t, m.Artifact.ParityTestsPassed)

	// v6 fixture: callingcards + harbison (binding) and hackett + kemmeren
	// (perturbation). kemmeren is the second perturbation dataset added so
	// multi-pair perturbation flows are exercised.
	require.Len(t, m.Datasets, 4)
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
	// harbison is the real-data regression vehicle: it carries an IEEE-NaN
	// effect cell and a `end` reserved-keyword column (see build_fixture.py).
	require.Contains(t, dsByName, "harbison")
	// Every dataset's sample_id_field is the materialized `sample_id` (the
	// BUG 3 fix: labretriever renames source `gm_id` -> `sample_id`).
	require.Equal(t, "sample_id", dsByName["callingcards"].SampleIDField)
	require.Equal(t, "sample_id", dsByName["harbison"].SampleIDField)
	// v3-specific assertions: effect/pvalue cols carried in the artifact.
	require.Equal(t, "callingcards_enrichment", dsByName["callingcards"].EffectCol)
	require.Equal(t, "poisson_pval", dsByName["callingcards"].PValueCol)
	require.Equal(t, "log2_shrunken_timecourses", dsByName["hackett"].EffectCol)
	require.Equal(t, "", dsByName["hackett"].PValueCol,
		"hackett intentionally has no p-value column — see buildResponsiveExpr")
	require.Equal(t, "effect", dsByName["harbison"].EffectCol)
	// DM-1/DM-5: condition_cols is derived from EXPERIMENTAL_CONDITION_FIELDS,
	// so the non-condition `end` column is no longer in harbison's hover cols.
	require.Equal(t, "condition", dsByName["harbison"].ConditionCols)

	// v4: dataset_manifest carries DefaultActive / DefaultFilters /
	// ConditionCols. v6 drops harbison from DEFAULT_ACTIVE_DATASETS, so
	// callingcards/hackett/kemmeren are default_active=TRUE but harbison is
	// FALSE; hackett carries a preset default_filters spec.
	require.True(t, dsByName["callingcards"].DefaultActive)
	require.False(t, dsByName["harbison"].DefaultActive,
		"v6: harbison dropped from DEFAULT_ACTIVE_DATASETS")
	require.Equal(t, "", dsByName["callingcards"].DefaultFilters)
	// DM-5 / real-data shape: callingcards has no experimental-condition column
	// in {db}_meta, so condition_cols is derived to empty (it used to falsely
	// claim "condition", which 500'd the sample-conditions query on real data).
	require.Equal(t, "", dsByName["callingcards"].ConditionCols)
	require.True(t, dsByName["hackett"].DefaultActive)
	require.Equal(t,
		`{"time":{"type":"numeric","value":[45,45]}}`,
		dsByName["hackett"].DefaultFilters,
	)
	// DM-1: hackett condition_cols is just `time` (mechanism/restriction are
	// hidden, so they no longer leak into the hover label).
	require.Equal(t, "time", dsByName["hackett"].ConditionCols)

	// v6: every fixture dataset is a base dataset → IsPrimary=true; none carry
	// a log10p/neglog10p column (only base rossi/chec_m2025 do, omitted here).
	for _, ds := range m.Datasets {
		require.True(t, ds.IsPrimary, "fixture dataset %s should be primary", ds.DBName)
		require.Equal(t, "", ds.Log10PCol, "fixture dataset %s has no log10p_col", ds.DBName)
		require.Equal(t, "", ds.NegLog10PCol, "fixture dataset %s has no neglog10p_col", ds.DBName)
	}

	// SD-3 / P0-3: field_manifest is sourced from {db}_meta ONLY, so it carries
	// the experimental-condition + other non-hidden metadata columns, NOT the
	// data-only measurement/coordinate columns (score, poisson_pval, effect,
	// target_locus_tag, …). Assert key membership rather than a brittle length.
	got := map[string]bool{}
	for _, f := range m.Fields {
		got[f.DBName+"."+f.Field] = true
	}
	required := []string{
		"hackett.time",
		"harbison.condition",
		"harbison.end",
	}
	for _, k := range required {
		require.True(t, got[k], "missing field_manifest entry: %s", k)
	}
	// Data-only columns must NOT be filter fields (they would 500 when filtered
	// against the {db}_meta-scoped WHERE).
	for _, k := range []string{
		"callingcards.score", "callingcards.target_locus_tag",
		"hackett.effect", "hackett.target_locus_tag",
	} {
		require.False(t, got[k], "data-only column leaked into field_manifest: %s", k)
	}
	// Real-data regression: callingcards has no condition column, so it must
	// NOT appear in field_manifest (the phantom that 500'd sample-conditions).
	require.False(t, got["callingcards.condition"],
		"callingcards has no condition column; it must not be a field")
	require.NotEmpty(t, m.Levels)

	// v3: field_manifest.role carries the experimental_condition classification.
	roleByKey := map[string]string{}
	fieldByKey := map[string]FieldRow{}
	for _, f := range m.Fields {
		roleByKey[f.DBName+"."+f.Field] = f.Role
		fieldByKey[f.DBName+"."+f.Field] = f
	}
	require.Equal(t, "experimental_condition", roleByKey["harbison.condition"])
	require.Equal(t, "experimental_condition", roleByKey["hackett.time"])
	// Sanity-check that a non-condition field has the empty role.
	require.Equal(t, "", roleByKey["harbison.end"])

	// v4: field_manifest carries per-(db, field) UX metadata. At least one
	// row (hackett.time) must surface UIKindOverride=="categorical" so the
	// frontend renders a selectize for it; everything else stays empty.
	require.Equal(t, "categorical", fieldByKey["hackett.time"].UIKindOverride)
	require.Equal(t, "numeric", fieldByKey["hackett.time"].NumericLevelSort)
	require.Equal(t, "", fieldByKey["harbison.condition"].UIKindOverride)
	// The fixture supplies no labretriever column metadata, so description /
	// level_definitions stay empty (graceful default).
	require.Equal(t, "", fieldByKey["harbison.condition"].Description)
	require.Equal(t, "", fieldByKey["harbison.condition"].LevelDefinitions)
}
