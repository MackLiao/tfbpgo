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
	// §6.3 pool-knob defaults — these are the spec contract for a t3.small.
	require.Equal(t, "800MB", cfg.MemoryLimit)
	require.Equal(t, "2GB", cfg.MaxTempSize)
	require.Equal(t, 2, cfg.MaxOpenConns)
	require.Equal(t, 128, cfg.MaxInFlight)
	require.Equal(t, 12, cfg.MaxComparisonPairs)
	require.Equal(t, 1, cfg.Threads) // §6.3 default; raise to 2 only on a box with spare cores+RAM
}

func TestLoadFromEnv_PoolKnobsOverride(t *testing.T) {
	t.Setenv("DUCKDB_PATH", "/tmp/x.duckdb")
	t.Setenv("DUCKDB_MEMORY_LIMIT", "600MB")
	t.Setenv("DB_MAX_OPEN_CONNS", "4")
	t.Setenv("MAX_INFLIGHT_REQUESTS", "256")
	t.Setenv("MAX_COMPARISON_PAIRS", "6")
	t.Setenv("DUCKDB_THREADS", "2")
	cfg, err := Load([]string{})
	require.NoError(t, err)
	require.Equal(t, "600MB", cfg.MemoryLimit)
	require.Equal(t, 4, cfg.MaxOpenConns)
	require.Equal(t, 256, cfg.MaxInFlight)
	require.Equal(t, 6, cfg.MaxComparisonPairs)
	require.Equal(t, 2, cfg.Threads)
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
