package observability

import (
	"io"
	"net/http/httptest"
	"runtime"
	"strings"
	"testing"

	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/stretchr/testify/require"
)

func TestMetrics_RegistryServesExpectedNames(t *testing.T) {
	t.Parallel()
	m := New()
	m.SetArtifactInfo("test-fixture", "2026-05-12T00:00:00Z", "test")
	m.HTTPDuration.WithLabelValues("/api/v/{v}/datasets", "200").Observe(0.01)
	m.HTTPRequestSize.WithLabelValues("/api/v/{v}/datasets").Observe(64)
	m.HTTPResponseSize.WithLabelValues("/api/v/{v}/datasets").Observe(128)
	m.DBDuration.WithLabelValues("datasets").Observe(0.005)
	m.DBPoolWait.Observe(0)
	m.DBPoolOpen.Set(1)
	m.DBPoolInUse.Set(0)
	m.CacheHits.WithLabelValues("/api/v/{v}/datasets").Inc()
	m.CacheMisses.WithLabelValues("/api/v/{v}/datasets").Inc()
	m.SFShared.WithLabelValues("/api/v/{v}/datasets").Inc()
	m.CacheReject.Inc()
	m.CacheOversize.Inc()
	m.CacheEviction.Inc()

	h := promhttp.HandlerFor(m.Reg, promhttp.HandlerOpts{})
	rr := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/metrics", nil)
	h.ServeHTTP(rr, req)

	require.Equal(t, 200, rr.Code)
	body, err := io.ReadAll(rr.Body)
	require.NoError(t, err)
	got := string(body)

	for _, want := range []string{
		"http_request_duration_seconds",
		"http_request_bytes",
		"http_response_bytes",
		"db_query_duration_seconds",
		"db_pool_wait_duration_seconds",
		"db_pool_open_connections",
		"db_pool_in_use",
		"cache_hits_total",
		"cache_misses_total",
		"singleflight_shared_calls_total",
		"cache_admission_rejected_total",
		"cache_oversize_responses_total",
		"cache_evictions_total",
		"artifact_version_info",
		"go_goroutines",
	} {
		require.True(t, strings.Contains(got, want), "missing metric %q in /metrics output", want)
	}

	// process_* metrics only emit on Linux (procfs); macOS dev hosts have a
	// stubbed process collector that returns no data points.
	if runtime.GOOS == "linux" {
		require.True(t, strings.Contains(got, "process_resident_memory_bytes"),
			"missing process_resident_memory_bytes on linux")
	}
}
