package api

import (
	"strings"
	"testing"

	"github.com/BrentLab/tfbpshiny-go/backend/internal/db"
	"github.com/stretchr/testify/require"
)

func TestAssertHandlerMapsCoverManifest_OK(t *testing.T) {
	m := &db.Manifests{
		Datasets: []db.DatasetRow{
			{DBName: "callingcards", DataType: "binding", EffectCol: "callingcards_enrichment"},
			{DBName: "hackett", DataType: "perturbation", EffectCol: "log2_shrunken_timecourses"},
		},
	}
	require.NoError(t, AssertHandlerMapsCoverManifest(m))
}

func TestAssertHandlerMapsCoverManifest_DetectsBindingDrift(t *testing.T) {
	m := &db.Manifests{
		Datasets: []db.DatasetRow{
			{DBName: "callingcards", DataType: "binding", EffectCol: "callingcards_enrichment"},
			// effect_col empty: simulates an upstream artifact that
			// shipped without populating the new manifest column.
			{DBName: "future_binding_assay", DataType: "binding", EffectCol: ""},
		},
	}
	err := AssertHandlerMapsCoverManifest(m)
	require.Error(t, err)
	require.True(t, strings.Contains(err.Error(), "future_binding_assay"),
		"missing-binding-dataset error should name the offending entry: %v", err)
	require.Contains(t, err.Error(), "effect_col")
}

func TestAssertHandlerMapsCoverManifest_DetectsPerturbationDrift(t *testing.T) {
	m := &db.Manifests{
		Datasets: []db.DatasetRow{
			{DBName: "future_pert_assay", DataType: "perturbation", EffectCol: ""},
		},
	}
	err := AssertHandlerMapsCoverManifest(m)
	require.Error(t, err)
	require.Contains(t, err.Error(), "future_pert_assay")
	require.Contains(t, err.Error(), "effect_col")
}

func TestAssertHandlerMapsCoverManifest_DetectsUnknownDataType(t *testing.T) {
	m := &db.Manifests{
		Datasets: []db.DatasetRow{
			{DBName: "callingcards", DataType: "binding", EffectCol: "callingcards_enrichment"},
			{DBName: "future_composite", DataType: "composite", EffectCol: ""},
		},
	}
	err := AssertHandlerMapsCoverManifest(m)
	require.Error(t, err)
	require.Contains(t, err.Error(), "future_composite")
	require.Contains(t, err.Error(), "composite")
}
