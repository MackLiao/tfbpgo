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

	DBDuration  *prometheus.HistogramVec
	DBPoolWait  prometheus.Histogram
	DBPoolOpen  prometheus.Gauge
	DBPoolInUse prometheus.Gauge

	CacheHits     *prometheus.CounterVec
	CacheMisses   *prometheus.CounterVec
	SFShared      *prometheus.CounterVec
	CacheReject   prometheus.Counter
	CacheOversize prometheus.Counter
	CacheEviction prometheus.Counter

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
		DBDuration: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name:    "db_query_duration_seconds",
			Help:    "DuckDB query latency by named query.",
			Buckets: prometheus.DefBuckets,
		}, []string{"query_name"}),
		DBPoolWait: prometheus.NewHistogram(prometheus.HistogramOpts{
			Name:    "db_pool_wait_duration_seconds",
			Help:    "Time spent waiting for a free DB connection.",
			Buckets: prometheus.DefBuckets,
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
		CacheReject: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "cache_admission_rejected_total",
			Help: "Cache Set() calls rejected by ristretto admission policy.",
		}),
		CacheOversize: prometheus.NewCounter(prometheus.CounterOpts{
			Name: "cache_oversize_responses_total",
			Help: "Responses larger than the per-item oversize threshold (budget/20).",
		}),
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
		m.HTTPDuration, m.HTTPRequestSize, m.HTTPResponseSize,
		m.DBDuration, m.DBPoolWait, m.DBPoolOpen, m.DBPoolInUse,
		m.CacheHits, m.CacheMisses, m.SFShared,
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
