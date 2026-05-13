package db

import (
	"io"
	"os"
	"path/filepath"
	"testing"

	_ "github.com/marcboeker/go-duckdb/v2"
	"github.com/stretchr/testify/require"
)

// bootstrappedFixturePath copies the read-only test fixture to a tmp file
// and returns the tmp file path. The committed fixture is fully
// self-contained as of Phase 3 — manifest + derived tables are baked in
// by data_prep.build_fixture, so no additional bootstrap statements are
// required here.
func bootstrappedFixturePath(t *testing.T) string {
	t.Helper()

	srcPath := fixturePath(t)
	dstPath := filepath.Join(t.TempDir(), "bootstrapped.duckdb")
	src, err := os.Open(srcPath)
	require.NoError(t, err)
	defer src.Close()
	dst, err := os.Create(dstPath)
	require.NoError(t, err)
	_, err = io.Copy(dst, src)
	require.NoError(t, err)
	require.NoError(t, dst.Close())

	return dstPath
}
