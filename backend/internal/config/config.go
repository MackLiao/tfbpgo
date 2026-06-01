// Package config parses environment variables and CLI flags into a typed Config.
package config

import (
	"flag"
	"fmt"

	"github.com/caarlos0/env/v11"
)

// Config holds runtime configuration. Env vars are the primary source;
// CLI flags --port and --duckdb override env if present.
type Config struct {
	DuckDBPath     string `env:"DUCKDB_PATH,required"`
	CacheSizeBytes int64  `env:"CACHE_SIZE_BYTES" envDefault:"134217728"`
	LogLevel       string `env:"LOG_LEVEL" envDefault:"info"`
	Port           int    `env:"PORT" envDefault:"8080"`
	TempDir        string `env:"DUCKDB_TEMP_DIR" envDefault:"/tmp/duckdb"`

	// §6.3 DuckDB pool knobs. These default to the conservative t3.small
	// values from the spec, but are env-tunable so the §11.3 cutover load
	// test can re-tune them (e.g. drop memory_limit to 600MB, sweep
	// MaxOpenConns) WITHOUT recompiling the binary.
	MemoryLimit  string `env:"DUCKDB_MEMORY_LIMIT" envDefault:"800MB"`
	MaxTempSize  string `env:"DUCKDB_MAX_TEMP_SIZE" envDefault:"2GB"`
	MaxOpenConns int    `env:"DB_MAX_OPEN_CONNS" envDefault:"2"`

	// MaxInFlight caps concurrent in-flight requests to the DB-backed API
	// group (load-shedding before the connection pool). Health/metrics/version
	// live outside this cap so probes always respond.
	MaxInFlight int `env:"MAX_INFLIGHT_REQUESTS" envDefault:"128"`
}

// Load parses environment variables, then applies CLI flag overrides.
func Load(args []string) (Config, error) {
	cfg := Config{}
	if err := env.Parse(&cfg); err != nil {
		return Config{}, fmt.Errorf("env parse: %w", err)
	}

	fs := flag.NewFlagSet("tfbp-server", flag.ContinueOnError)
	port := fs.Int("port", cfg.Port, "HTTP listen port")
	duckdb := fs.String("duckdb", cfg.DuckDBPath, "Path to tfbp.duckdb")
	if err := fs.Parse(args); err != nil {
		return Config{}, fmt.Errorf("flag parse: %w", err)
	}
	cfg.Port = *port
	cfg.DuckDBPath = *duckdb
	if cfg.DuckDBPath == "" {
		return Config{}, fmt.Errorf("DUCKDB_PATH (env) or --duckdb (flag) required")
	}
	return cfg, nil
}
