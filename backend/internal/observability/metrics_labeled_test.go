package observability

import (
	"testing"

	"github.com/prometheus/client_golang/prometheus/testutil"
	"github.com/stretchr/testify/require"
)

// TestCacheRejectOversizeAreLabeledByEndpoint proves cache_admission_rejected_total
// and cache_oversize_responses_total are CounterVec{endpoint}, not plain Counters,
// and that distinct endpoints accumulate independently.
func TestCacheRejectOversizeAreLabeledByEndpoint(t *testing.T) {
	m := New()

	m.CacheReject.WithLabelValues("/api/v/{v}/binding").Add(2)
	m.CacheReject.WithLabelValues("/api/v/{v}/datasets").Add(5)
	m.CacheOversize.WithLabelValues("/api/v/{v}/binding").Inc()

	require.Equal(t, 2.0,
		testutil.ToFloat64(m.CacheReject.WithLabelValues("/api/v/{v}/binding")))
	require.Equal(t, 5.0,
		testutil.ToFloat64(m.CacheReject.WithLabelValues("/api/v/{v}/datasets")))
	require.Equal(t, 1.0,
		testutil.ToFloat64(m.CacheOversize.WithLabelValues("/api/v/{v}/binding")))

	// CacheLoadSeconds (Task 2) is also labeled — sanity-check it co-exists.
	m.CacheLoadSeconds.WithLabelValues("/api/v/{v}/binding").Add(0.5)
	require.Equal(t, 0.5,
		testutil.ToFloat64(m.CacheLoadSeconds.WithLabelValues("/api/v/{v}/binding")))
}
