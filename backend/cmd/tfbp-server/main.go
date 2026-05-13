package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
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

	cfg, err := config.Load(os.Args[1:])
	if err != nil {
		slog.Error("config_load_failed", "err", err)
		os.Exit(1)
	}

	pool, err := db.Open(db.Options{Path: cfg.DuckDBPath, TempDir: cfg.TempDir})
	if err != nil {
		slog.Error("startup_failed", "err", err)
		os.Exit(1)
	}
	defer pool.Close()

	startupCtx := context.Background()
	report, err := db.RunStartupChecks(startupCtx, pool, db.MinSchemaVersion, db.MaxSchemaVersion)
	if err != nil {
		slog.Error("startup_failed", "err", err)
		os.Exit(1)
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
		slog.Error("cache_init_failed", "err", err)
		os.Exit(1)
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
		slog.Error("startup_failed", "err", err)
		os.Exit(1)
	}

	srv := &api.Server{
		ArtifactVersion: report.Manifests.Artifact.ArtifactVersion,
		Pool:            pool,
		Cache:           c,
		Whitelist:       wl,
		Manifests:       report.Manifests,
		Metrics:         metrics,
		StaticFS:        static.FS(),
	}
	r := srv.Routes()

	// Background pool-stats sampler.
	stop := make(chan struct{})
	go samplePoolStats(stop, pool, metrics)
	defer close(stop)

	// Background cache-counter exporter (snapshot deltas).
	stopCache := make(chan struct{})
	go exportCacheCounters(stopCache, c, metrics)
	defer close(stopCache)

	httpSrv := &http.Server{
		Addr:              fmt.Sprintf(":%d", cfg.Port),
		Handler:           r,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       120 * time.Second,
		MaxHeaderBytes:    64 * 1024,
	}

	ctx, sigStop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer sigStop()

	go func() {
		slog.Info("startup_listen", "addr", httpSrv.Addr)
		if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Error("listen_failed", "err", err)
			os.Exit(1)
		}
	}()

	<-ctx.Done()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = httpSrv.Shutdown(shutdownCtx)
}

func samplePoolStats(stop <-chan struct{}, pool *db.Pool, m *observability.Metrics) {
	t := time.NewTicker(5 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-stop:
			return
		case <-t.C:
			st := pool.DB.Stats()
			m.DBPoolOpen.Set(float64(st.OpenConnections))
			m.DBPoolInUse.Set(float64(st.InUse))
		}
	}
}

// exportCacheCounters polls the cache's atomic counters and bridges deltas
// into the Prometheus counters. Counters are monotonic so we add (current - prev).
func exportCacheCounters(stop <-chan struct{}, c *cache.Cache, m *observability.Metrics) {
	var prevReject, prevOversize, prevEvict int64
	t := time.NewTicker(10 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-stop:
			return
		case <-t.C:
			rej := c.AdmissionRejected()
			over := c.OversizeCount()
			ev := c.EvictionCount()
			if d := rej - atomic.SwapInt64(&prevReject, rej); d > 0 {
				m.CacheReject.Add(float64(d))
			}
			if d := over - atomic.SwapInt64(&prevOversize, over); d > 0 {
				m.CacheOversize.Add(float64(d))
			}
			if d := ev - atomic.SwapInt64(&prevEvict, ev); d > 0 {
				m.CacheEviction.Add(float64(d))
			}
		}
	}
}
