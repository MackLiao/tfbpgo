package db

import (
	"context"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func fixturePath(t *testing.T) string {
	t.Helper()
	abs, err := filepath.Abs("../../../tests/fixtures/tfbp_test.duckdb")
	require.NoError(t, err)
	return abs
}

func TestOpen_AppliesSettings(t *testing.T) {
	pool, err := Open(Options{Path: fixturePath(t), TempDir: t.TempDir()})
	require.NoError(t, err)
	defer pool.Close()

	require.Equal(t, 2, pool.DB.Stats().MaxOpenConnections)

	ctx, cancel := context.WithTimeout(context.Background(), 5_000_000_000)
	defer cancel()

	var threads int
	require.NoError(t, pool.DB.QueryRowxContext(ctx, "SELECT current_setting('threads')::INT").Scan(&threads))
	require.Equal(t, 1, threads)

	var memLimit string
	require.NoError(t, pool.DB.QueryRowxContext(ctx, "SELECT current_setting('memory_limit')").Scan(&memLimit))
	// DuckDB accepts "800MB" (decimal) but displays it normalized to MiB
	// (800 * 1_000_000 bytes == 762.9 MiB). Both representations are
	// acceptable evidence the §6.3 800MB cap is in effect.
	require.True(t,
		strings.Contains(memLimit, "800") || strings.Contains(memLimit, "762.9"),
		"unexpected memory_limit display: %q", memLimit,
	)
}

func TestOpen_ReadOnlyRejectsWrite(t *testing.T) {
	pool, err := Open(Options{Path: fixturePath(t), TempDir: t.TempDir()})
	require.NoError(t, err)
	defer pool.Close()
	_, err = pool.DB.Exec("CREATE TABLE x (i INT)")
	require.Error(t, err)
}
