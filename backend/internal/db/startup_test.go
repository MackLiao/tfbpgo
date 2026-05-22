package db

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestStartupContract_FixturePasses(t *testing.T) {
	bootstrap := bootstrappedFixturePath(t)
	pool, err := Open(Options{Path: bootstrap, TempDir: t.TempDir()})
	require.NoError(t, err)
	defer pool.Close()

	report, err := RunStartupChecks(context.Background(), pool, MinSchemaVersion, MaxSchemaVersion)
	require.NoError(t, err)
	require.Equal(t, 3, report.Manifests.Artifact.SchemaVersion)
	require.NotEmpty(t, report.Manifests.Artifact.ArtifactVersion)
}

func TestStartupContract_RejectsSchemaTooOld(t *testing.T) {
	bootstrap := bootstrappedFixturePath(t)
	pool, err := Open(Options{Path: bootstrap, TempDir: t.TempDir()})
	require.NoError(t, err)
	defer pool.Close()
	_, err = RunStartupChecks(context.Background(), pool, 99, 99)
	require.ErrorContains(t, err, "schema_version")
}
