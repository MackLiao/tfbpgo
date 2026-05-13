package config

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestLoadFromEnv_Defaults(t *testing.T) {
	t.Setenv("DUCKDB_PATH", "/tmp/x.duckdb")
	cfg, err := Load([]string{})
	require.NoError(t, err)
	require.Equal(t, "/tmp/x.duckdb", cfg.DuckDBPath)
	require.Equal(t, int64(134217728), cfg.CacheSizeBytes) // 128 MiB
	require.Equal(t, "info", cfg.LogLevel)
	require.Equal(t, 8080, cfg.Port)
}

func TestLoadFromEnv_FlagOverridesPort(t *testing.T) {
	t.Setenv("DUCKDB_PATH", "/tmp/x.duckdb")
	cfg, err := Load([]string{"--port", "9090"})
	require.NoError(t, err)
	require.Equal(t, 9090, cfg.Port)
}

func TestLoadFromEnv_FlagOverridesDuckdb(t *testing.T) {
	t.Setenv("DUCKDB_PATH", "/tmp/from-env.duckdb")
	cfg, err := Load([]string{"--duckdb", "/tmp/from-flag.duckdb"})
	require.NoError(t, err)
	require.Equal(t, "/tmp/from-flag.duckdb", cfg.DuckDBPath)
}

func TestLoadFromEnv_MissingDuckdbPath(t *testing.T) {
	t.Setenv("DUCKDB_PATH", "")
	_, err := Load([]string{})
	require.Error(t, err)
}
