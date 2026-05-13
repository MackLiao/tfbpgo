package api

import (
	"context"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/BrentLab/tfbpshiny-go/backend/internal/observability"
	"github.com/go-chi/chi/v5"
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

// RequestLogger emits the structured per-request log line plus, when metrics
// is non-nil, observes HTTP duration / request size / response size keyed by
// the chi route pattern (low cardinality).
func RequestLogger(artifactVersion string, metrics *observability.Metrics) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			ww := middleware.NewWrapResponseWriter(w, r.ProtoMajor)

			cacheHit := false
			var dbMs int64
			ctx := context.WithValue(r.Context(), ctxCacheHit, &cacheHit)
			ctx = context.WithValue(ctx, ctxDBMillis, &dbMs)

			next.ServeHTTP(ww, r.WithContext(ctx))

			elapsed := time.Since(start)
			route := chiRoutePattern(r)

			if metrics != nil {
				metrics.HTTPDuration.WithLabelValues(route, strconv.Itoa(ww.Status())).Observe(elapsed.Seconds())
				metrics.HTTPResponseSize.WithLabelValues(route).Observe(float64(ww.BytesWritten()))
				if r.ContentLength > 0 {
					metrics.HTTPRequestSize.WithLabelValues(route).Observe(float64(r.ContentLength))
				}
			}

			slog.Info("http_request",
				"route", route,
				"path", r.URL.Path,
				"status", ww.Status(),
				"latency_ms", elapsed.Milliseconds(),
				"cache_hit", cacheHit,
				"db_ms", dbMs,
				"bytes", ww.BytesWritten(),
				"artifact_version", artifactVersion,
			)
		})
	}
}

// chiRoutePattern returns the matched chi route template (low cardinality)
// or falls back to the raw path if no route matched.
func chiRoutePattern(r *http.Request) string {
	if rctx := chi.RouteContext(r.Context()); rctx != nil {
		if p := rctx.RoutePattern(); p != "" {
			return p
		}
	}
	return r.URL.Path
}
