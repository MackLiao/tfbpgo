package api

import (
	"context"
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5/middleware"
)

type ctxKey int

const (
	ctxCacheHit ctxKey = iota
	ctxDBMillis
)

func MarkCacheHit(ctx context.Context, hit bool) {
	if v := ctx.Value(ctxCacheHit); v != nil {
		*(v.(*bool)) = hit
	}
}

func AddDBMillis(ctx context.Context, ms int64) {
	if v := ctx.Value(ctxDBMillis); v != nil {
		*(v.(*int64)) += ms
	}
}

func RequestLogger(artifactVersion string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			ww := middleware.NewWrapResponseWriter(w, r.ProtoMajor)

			cacheHit := false
			var dbMs int64
			ctx := context.WithValue(r.Context(), ctxCacheHit, &cacheHit)
			ctx = context.WithValue(ctx, ctxDBMillis, &dbMs)

			next.ServeHTTP(ww, r.WithContext(ctx))

			slog.Info("http_request",
				"route", r.URL.Path,
				"status", ww.Status(),
				"latency_ms", time.Since(start).Milliseconds(),
				"cache_hit", cacheHit,
				"db_ms", dbMs,
				"bytes", ww.BytesWritten(),
				"artifact_version", artifactVersion,
			)
		})
	}
}
