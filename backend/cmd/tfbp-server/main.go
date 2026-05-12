package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/BrentLab/tfbpshiny-go/backend/internal/config"
	"github.com/BrentLab/tfbpshiny-go/backend/internal/db"
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

	r := chi.NewRouter()
	r.Get("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]bool{"alive": true})
	})

	srv := &http.Server{
		Addr:              fmt.Sprintf(":%d", cfg.Port),
		Handler:           r,
		ReadHeaderTimeout: 5 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	go func() {
		slog.Info("startup_listen", "addr", srv.Addr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Error("listen_failed", "err", err)
			os.Exit(1)
		}
	}()

	<-ctx.Done()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = srv.Shutdown(shutdownCtx)
}
