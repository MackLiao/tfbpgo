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
			{DBName: "callingcards", DataType: "binding"},
			{DBName: "hackett", DataType: "perturbation"},
		},
	}
	require.NoError(t, AssertHandlerMapsCoverManifest(m))
}

func TestAssertHandlerMapsCoverManifest_DetectsBindingDrift(t *testing.T) {
	m := &db.Manifests{
		Datasets: []db.DatasetRow{
			{DBName: "callingcards", DataType: "binding"},
			{DBName: "future_binding_assay", DataType: "binding"},
		},
	}
	err := AssertHandlerMapsCoverManifest(m)
	require.Error(t, err)
	require.True(t, strings.Contains(err.Error(), "future_binding_assay"),
		"missing-binding-dataset error should name the offending entry: %v", err)
}

func TestAssertHandlerMapsCoverManifest_DetectsPerturbationDrift(t *testing.T) {
	m := &db.Manifests{
		Datasets: []db.DatasetRow{
			{DBName: "future_pert_assay", DataType: "perturbation"},
		},
	}
	err := AssertHandlerMapsCoverManifest(m)
	require.Error(t, err)
	require.Contains(t, err.Error(), "future_pert_assay")
}

func TestAssertHandlerMapsCoverManifest_DetectsUnknownDataType(t *testing.T) {
	m := &db.Manifests{
		Datasets: []db.DatasetRow{
			{DBName: "callingcards", DataType: "binding"},
			{DBName: "future_composite", DataType: "composite"},
		},
	}
	err := AssertHandlerMapsCoverManifest(m)
	require.Error(t, err)
	require.Contains(t, err.Error(), "future_composite")
	require.Contains(t, err.Error(), "composite")
}
