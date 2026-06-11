package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/BrentLab/tfbpshiny-go/backend/internal/api"
	"github.com/BrentLab/tfbpshiny-go/backend/internal/cache"
	"github.com/BrentLab/tfbpshiny-go/backend/internal/config"
	"github.com/BrentLab/tfbpshiny-go/backend/internal/db"
	"github.com/BrentLab/tfbpshiny-go/backend/internal/observability"
	"github.com/BrentLab/tfbpshiny-go/backend/static"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(logger)

	if err := run(); err != nil {
		slog.Error("fatal", "err", err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := config.Load(os.Args[1:])
	if err != nil {
		return fmt.Errorf("config_load_failed: %w", err)
	}

	// Re-init the default logger at the configured level now that cfg is
	// loaded (main() bootstraps at info so config-load errors are visible).
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: parseLogLevel(cfg.LogLevel)})))

	pool, err := db.Open(db.Options{
		Path:         cfg.DuckDBPath,
		TempDir:      cfg.TempDir,
		MemoryLimit:  cfg.MemoryLimit,
		MaxTempSize:  cfg.MaxTempSize,
		MaxOpenConns: cfg.MaxOpenConns,
		Threads:      cfg.Threads,
	})
	if err != nil {
		return fmt.Errorf("startup_failed (db.Open): %w", err)
	}
	defer pool.Close()

	startupCtx := context.Background()
	report, err := db.RunStartupChecks(startupCtx, pool, db.MinSchemaVersion, db.MaxSchemaVersion)
	if err != nil {
		return fmt.Errorf("startup_failed (RunStartupChecks): %w", err)
	}
	slog.Info("startup_ok",
		"artifact_version", report.Manifests.Artifact.ArtifactVersion,
		"schema_version", report.Manifests.Artifact.SchemaVersion,
		"artifact_duckdb_version", report.Manifests.Artifact.DuckDBVersion,
		"runtime_duckdb_version", report.RuntimeDuckDB,
		"storage_version", report.StorageVersion,
	)

	cacheBudget := cfg.CacheSizeBytes
	if cacheBudget <= 0 {
		cacheBudget = 128 << 20 // 128 MiB default
	}
	c, err := cache.New(cache.Options{BudgetBytes: cacheBudget})
	if err != nil {
		return fmt.Errorf("cache_init_failed: %w", err)
	}
	defer c.Close()

	metrics := observability.New()
	metrics.SetArtifactInfo(
		report.Manifests.Artifact.ArtifactVersion,
		report.Manifests.Artifact.BuiltAt.UTC().Format(time.RFC3339),
		report.Manifests.Artifact.DuckDBVersion,
	)

	wl, err := db.NewWhitelist(report.Manifests)
	if err != nil {
		return fmt.Errorf("startup_failed (NewWhitelist): %w", err)
	}

	// Fail-fast tripwire: catch drift between dataset_manifest and the
	// handler-side measurement-column / config maps. Without this, a
	// newly-added dataset that ships in the artifact ahead of a binary
	// rebuild surfaces only as a 500 on the affected endpoint.
	if err := api.AssertHandlerMapsCoverManifest(report.Manifests); err != nil {
		return fmt.Errorf("startup_failed (handler maps): %w", err)
	}

	srv := &api.Server{
		ArtifactVersion:    report.Manifests.Artifact.ArtifactVersion,
		Pool:               pool,
		Cache:              c,
		Whitelist:          wl,
		Manifests:          report.Manifests,
		Metrics:            metrics,
		StaticFS:           static.FS(),
		MaxInFlight:        cfg.MaxInFlight,
		MaxComparisonPairs: cfg.MaxComparisonPairs,
	}

	// Eager-load the per-(db, field) introspection cache before binding the
	// listener. Without this, the first cold burst on /datasets/{db}/fields
	// races N goroutines through information_schema for the same (db, field)
	// pair (the lazy introspectField has a release-then-reacquire lock gap
	// to keep DB I/O off the mutex). Warming closes that gap by making every
	// subsequent introspectField call a pure map lookup. Per-entry failures
	// are non-fatal — introspectField retries on the request path.
	warmStart := time.Now()
	if err := srv.WarmIntrospectionCache(startupCtx); err != nil {
		return fmt.Errorf("startup_failed (WarmIntrospectionCache): %w", err)
	}
	slog.Info("startup_introspect_warmed",
		"fields", len(report.Manifests.Fields),
		"duration_ms", time.Since(warmStart).Milliseconds(),
	)

	r := srv.Routes()

	// Background goroutines share one stop channel; main joins via WaitGroup
	// so neither sampler is still touching pool/cache when Close() runs.
	stop := make(chan struct{})
	var bgWG sync.WaitGroup
	bgWG.Add(2)
	go func() { defer bgWG.Done(); samplePoolStats(stop, pool, metrics) }()
	go func() { defer bgWG.Done(); exportCacheCounters(stop, c, metrics) }()
	defer func() {
		close(stop)
		bgWG.Wait()
	}()

	httpSrv := &http.Server{
		Addr:              fmt.Sprintf(":%d", cfg.Port),
		Handler:           r,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		// WriteTimeout MUST exceed the longest per-handler deadline, otherwise
		// net/http silently truncates the response from the server side after
		// the first body byte. The /export handler runs up to api.ExportTimeout
		// (5 minutes) on multi-dataset tar.gz streams; 6 minutes here gives a
		// 1-minute margin over that handler-side cap. Per-request shaping is
		// still done via context.WithTimeout inside individual handlers.
		WriteTimeout:   6 * time.Minute,
		IdleTimeout:    120 * time.Second,
		MaxHeaderBytes: 64 * 1024,
	}

	ctx, sigStop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer sigStop()

	// Forward a fatal listener error back to main via a buffered channel.
	// os.Exit from a goroutine would skip the deferred Close()s and leave
	// the named volume / temp dir in an unknown state.
	listenErr := make(chan error, 1)
	go func() {
		slog.Info("startup_listen", "addr", httpSrv.Addr)
		if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			listenErr <- err
		}
		close(listenErr)
	}()

	var serveErr error
	select {
	case <-ctx.Done():
		// Signal-driven shutdown — normal path.
	case err, ok := <-listenErr:
		if ok && err != nil {
			serveErr = err
		}
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = httpSrv.Shutdown(shutdownCtx)

	return serveErr
}

// parseLogLevel maps a LOG_LEVEL string to a slog.Level, defaulting to info
// for empty/unrecognized values.
func parseLogLevel(s string) slog.Level {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "debug":
		return slog.LevelDebug
	case "warn", "warning":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}

func samplePoolStats(stop <-chan struct{}, pool *db.Pool, m *observability.Metrics) {
	t := time.NewTicker(5 * time.Second)
	defer t.Stop()
	var prevWait time.Duration
	var prevCount int64
	for {
		select {
		case <-stop:
			return
		case <-t.C:
			st := pool.DB.Stats()
			m.DBPoolOpen.Set(float64(st.OpenConnections))
			m.DBPoolInUse.Set(float64(st.InUse))
			waitDelta := st.WaitDuration - prevWait
			countDelta := st.WaitCount - prevCount
			// Always advance the counter pair so operators can compute a
			// true rate-of-contention via
			//   rate(db_pool_wait_duration_seconds_total[5m])
			//   / rate(db_pool_wait_count_total[5m])
			// without depending on the per-tick mean histogram below.
			if countDelta > 0 {
				m.DBPoolWaitCount.Add(float64(countDelta))
				m.DBPoolWaitDurationSecondsTotal.Add(waitDelta.Seconds())
				// The histogram observes the per-tick mean wait. This is
				// NOT a true per-acquire latency distribution (database/sql
				// exposes only monotonic totals), so its quantiles are the
				// distribution of per-5s-tick means. Keep alongside the
				// counters above for backwards compatibility; alerts
				// should use the counters.
				avgWait := waitDelta.Seconds() / float64(countDelta)
				m.DBPoolWait.Observe(avgWait)
			}
			prevWait = st.WaitDuration
			prevCount = st.WaitCount
		}
	}
}

// exportCacheCounters polls the cache's per-endpoint accumulators and bridges
// deltas into the Prometheus CounterVecs. Counters are monotonic so we add
// (current - prev) per endpoint label.
func exportCacheCounters(stop <-chan struct{}, c *cache.Cache, m *observability.Metrics) {
	prevLoad := map[string]float64{}
	prevReject := map[string]int64{}
	prevOversize := map[string]int64{}
	var prevEvict int64
	t := time.NewTicker(10 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-stop:
			return
		case <-t.C:
			for ep, secs := range c.LoadSeconds() {
				if d := secs - prevLoad[ep]; d > 0 {
					m.CacheLoadSeconds.WithLabelValues(ep).Add(d)
				}
				prevLoad[ep] = secs
			}
			for ep, n := range c.AdmissionRejected() {
				if d := n - prevReject[ep]; d > 0 {
					m.CacheReject.WithLabelValues(ep).Add(float64(d))
				}
				prevReject[ep] = n
			}
			for ep, n := range c.OversizeCount() {
				if d := n - prevOversize[ep]; d > 0 {
					m.CacheOversize.WithLabelValues(ep).Add(float64(d))
				}
				prevOversize[ep] = n
			}
			ev := c.EvictionCount()
			if d := ev - atomic.SwapInt64(&prevEvict, ev); d > 0 {
				m.CacheEviction.Add(float64(d))
			}
		}
	}
}
