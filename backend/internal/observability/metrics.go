// Package observability registers the Prometheus metric set required by spec
// §6.7. All metrics live on a single explicit registry to keep tests
// hermetic and avoid leaking into the global default registry.
package observability

import (
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
)

// Metrics is the registered set required by spec §6.7.
type Metrics struct {
	Reg *prometheus.Registry

	HTTPDuration     *prometheus.HistogramVec
	HTTPRequestSize  *prometheus.HistogramVec
	HTTPResponseSize *prometheus.HistogramVec
	// HTTPInFlight counts requests currently inside the handler chain. Inc at
	// RequestLogger entry, Dec in a defer that survives middleware.Recoverer so
	// a panicking handler cannot leak the gauge upward.
	HTTPInFlight prometheus.Gauge

	DBDuration *prometheus.HistogramVec
	// DBPoolWait observes the per-5s-tick MEAN wait duration. This is a
	// distribution-of-means and its quantiles are NOT per-acquire p95/p99.
	// Use the DBPoolWaitDurationSecondsTotal / DBPoolWaitCount counter
	// pair for true rate-of-contention alerting.
	DBPoolWait                     prometheus.Histogram
	DBPoolWaitDurationSecondsTotal prometheus.Counter
	DBPoolWaitCount                prometheus.Counter
	DBPoolOpen                     prometheus.Gauge
	DBPoolInUse                    prometheus.Gauge

	CacheHits        *prometheus.CounterVec
	CacheMisses      *prometheus.CounterVec
	SFShared         *prometheus.CounterVec
	CacheLoadSeconds *prometheus.CounterVec
	CacheReject      *prometheus.CounterVec
	CacheOversize    *prometheus.CounterVec
	CacheEviction    prometheus.Counter

	ArtifactInfo *prometheus.GaugeVec
}

// New registers all metrics on a fresh registry.
func New() *Metrics {
	reg := prometheus.NewRegistry()
	m := &Metrics{
		Reg: reg,
		HTTPDuration: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name:    "http_request_duration_seconds",
			Help:    "HTTP request latency by route pattern + status.",
			Buckets: prometheus.DefBuckets,
		}, []string{"route", "status"}),
		HTTPRequestSize: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name:    "http_request_bytes",
			Help:    "HTTP request size in bytes by route pattern.",
			Buckets: prometheus.ExponentialBuckets(64, 4, 8),
		}, []string{"route"}),
		HTTPResponseSize: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name:    "http_response_bytes",
			Help:    "HTTP response size in bytes by route pattern.",
			Buckets: prometheus.ExponentialBuckets(64, 4, 10),
		}, []string{"route"}),
		HTTPInFlight: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "http_in_flight_requests",
			Help: "Number of HTTP requests currently being handled.",
		}),
		DBDuration: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name:    "db_query_duration_seconds",
			Help:    "DuckDB query latency by named query.",
			Buckets: prometheus.DefBuckets,
		}, []string{"query_name"}),
		DBPoolWait: prometheus.NewHistogram(prometheus.HistogramOpts{
			Name:    "db_pool_wait_duration_seconds",
			Help:    "Per-5s-tick mean DB-pool wait duration (NOT a per-acquire latency distribution; quantiles are distribution-of-means). Retained for backwards compatibility; alert on db_pool_wait_duration_seconds_total / db_pool_wait_count_total instead. Scheduled for removal once dashboards have migrated.",
			Buckets: prometheus.DefBuckets,
		}),
		DBPoolWaitDurationSecondsTotal: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "db_pool_wait_duration_seconds_total",
			Help: "Cumulative seconds spent waiting for a free DB connection. Mirrors sql.DBStats.WaitDuration; use with db_pool_wait_count_total for mean wait per acquire.",
		}),
		DBPoolWaitCount: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "db_pool_wait_count_total",
			Help: "Cumulative number of pool waits. Mirrors sql.DBStats.WaitCount.",
		}),
		DBPoolOpen: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "db_pool_open_connections",
			Help: "Open DuckDB connections (pool stats sample).",
		}),
		DBPoolInUse: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "db_pool_in_use",
			Help: "Currently in-use DuckDB connections (pool stats sample).",
		}),
		CacheHits: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "cache_hits_total",
			Help: "Cache hits per endpoint.",
		}, []string{"endpoint"}),
		CacheMisses: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "cache_misses_total",
			Help: "Cache misses per endpoint.",
		}, []string{"endpoint"}),
		SFShared: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "singleflight_shared_calls_total",
			Help: "Singleflight-coalesced requests per endpoint.",
		}, []string{"endpoint"}),
		CacheLoadSeconds: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "cache_load_seconds_total",
			Help: "Cumulative wall-seconds spent inside the cache loader (cold/miss path) per endpoint.",
		}, []string{"endpoint"}),
		CacheReject: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "cache_admission_rejected_total",
			Help: "Cache Set() calls rejected by ristretto admission policy, per endpoint.",
		}, []string{"endpoint"}),
		CacheOversize: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "cache_oversize_responses_total",
			Help: "Responses larger than the per-item oversize threshold (budget/20), per endpoint.",
		}, []string{"endpoint"}),
		CacheEviction: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "cache_evictions_total",
			Help: "Cache evictions reported by ristretto.",
		}),
		ArtifactInfo: prometheus.NewGaugeVec(prometheus.GaugeOpts{
			Name: "artifact_version_info",
			Help: "Constant 1 with labels identifying the loaded artifact.",
		}, []string{"version", "built_at", "duckdb_version"}),
	}

	reg.MustRegister(
		m.HTTPDuration, m.HTTPRequestSize, m.HTTPResponseSize, m.HTTPInFlight,
		m.DBDuration, m.DBPoolWait,
		m.DBPoolWaitDurationSecondsTotal, m.DBPoolWaitCount,
		m.DBPoolOpen, m.DBPoolInUse,
		m.CacheHits, m.CacheMisses, m.SFShared, m.CacheLoadSeconds,
		m.CacheReject, m.CacheOversize, m.CacheEviction,
		m.ArtifactInfo,
		collectors.NewGoCollector(),
		collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}),
	)
	return m
}

// SetArtifactInfo sets the constant-1 artifact info gauge with the given labels.
func (m *Metrics) SetArtifactInfo(version, builtAt, duckdbVersion string) {
	m.ArtifactInfo.WithLabelValues(version, builtAt, duckdbVersion).Set(1)
}
