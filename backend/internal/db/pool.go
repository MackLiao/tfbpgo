// Package db opens DuckDB read-only with the §6.3 connection-pool settings.
package db

import (
	"database/sql"
	"fmt"
	"net/url"
	"strconv"
	"time"

	"github.com/jmoiron/sqlx"
	_ "github.com/marcboeker/go-duckdb/v2"
)

// Options for opening the artifact.
type Options struct {
	Path         string
	TempDir      string
	MaxTempSize  string // e.g. "2GB"
	MemoryLimit  string // e.g. "800MB"
	MaxOpenConns int
	Threads      int // DuckDB per-query thread cap; 0 → 1 (§6.3 default)
}

// Pool wraps a sqlx.DB pinned to one read-only DuckDB file.
type Pool struct {
	DB *sqlx.DB
}

// Open opens the file in read-only mode and applies all §6.3 settings.
func Open(opts Options) (*Pool, error) {
	if opts.MaxTempSize == "" {
		opts.MaxTempSize = "2GB"
	}
	if opts.MemoryLimit == "" {
		opts.MemoryLimit = "800MB"
	}
	if opts.MaxOpenConns == 0 {
		opts.MaxOpenConns = 2
	}
	if opts.Threads <= 0 {
		opts.Threads = 1
	}

	q := url.Values{}
	q.Set("access_mode", "read_only")
	q.Set("threads", strconv.Itoa(opts.Threads))
	q.Set("memory_limit", opts.MemoryLimit)
	q.Set("temp_directory", opts.TempDir)
	q.Set("max_temp_directory_size", opts.MaxTempSize)
	q.Set("preserve_insertion_order", "false")

	dsn := fmt.Sprintf("%s?%s", opts.Path, q.Encode())
	raw, err := sql.Open("duckdb", dsn)
	if err != nil {
		return nil, fmt.Errorf("open duckdb: %w", err)
	}
	raw.SetMaxOpenConns(opts.MaxOpenConns)
	raw.SetMaxIdleConns(opts.MaxOpenConns)
	raw.SetConnMaxLifetime(0)

	if err := raw.Ping(); err != nil {
		_ = raw.Close()
		return nil, fmt.Errorf("ping duckdb: %w", err)
	}

	return &Pool{DB: sqlx.NewDb(raw, "duckdb")}, nil
}

// Close releases the pool.
func (p *Pool) Close() error {
	if p == nil || p.DB == nil {
		return nil
	}
	return p.DB.Close()
}

// QueryTimeout is the per-request DB timeout.
const QueryTimeout = 30 * time.Second
