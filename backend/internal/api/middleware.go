package api

import (
	"context"
	"log/slog"
	"net/http"
	"strconv"
	"sync/atomic"
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

// AddDBMillis accumulates query wall-time for the request's log line. It is
// safe to call from the cache loader goroutine (which may outlive or run
// concurrently with the request after GetOrLoad switched to DoChan), so the
// sink is an atomic.Int64.
func AddDBMillis(ctx context.Context, ms int64) {
	if v := ctx.Value(ctxDBMillis); v != nil {
		v.(*atomic.Int64).Add(ms)
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

			// In-flight gauge: Inc on entry, Dec in a defer so a panic in the
			// inner handler still decrements before middleware.Recoverer (the
			// OUTER wrapper) swallows it. Guard for nil metrics (test servers).
			if metrics != nil {
				metrics.HTTPInFlight.Inc()
				defer metrics.HTTPInFlight.Dec()
			}

			cacheHit := false
			var dbMs atomic.Int64
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
				"db_ms", dbMs.Load(),
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

// recordCacheOutcome bumps the per-endpoint cache_hits / cache_misses /
// singleflight_shared counters using the chi route pattern as the label.
// No-op when metrics is nil (test servers without observability wired).
func (s *Server) recordCacheOutcome(r *http.Request, hit, shared bool) {
	if s.Metrics == nil {
		return
	}
	endpoint := chiRoutePattern(r)
	if hit {
		s.Metrics.CacheHits.WithLabelValues(endpoint).Inc()
	} else {
		s.Metrics.CacheMisses.WithLabelValues(endpoint).Inc()
	}
	if shared {
		s.Metrics.SFShared.WithLabelValues(endpoint).Inc()
	}
}
