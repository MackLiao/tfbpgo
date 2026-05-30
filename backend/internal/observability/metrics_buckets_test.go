package observability

import (
	"io"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/prometheus/client_golang/prometheus/promhttp"
	"github.com/stretchr/testify/require"
)

// TestHTTPDurationHasFineGrainedBuckets proves the http_request_duration_seconds
// histogram registers with the added .15/.2/.3/.5 edges so the open-model
// p95<200ms / p99<500ms thresholds fall on real bucket boundaries.
func TestHTTPDurationHasFineGrainedBuckets(t *testing.T) {
	m := New()
	m.HTTPDuration.WithLabelValues("/api/v/{v}/datasets", "200").Observe(0.18)

	h := promhttp.HandlerFor(m.Reg, promhttp.HandlerOpts{})
	rr := httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/metrics", nil)
	h.ServeHTTP(rr, req)
	body, err := io.ReadAll(rr.Body)
	require.NoError(t, err)
	got := string(body)

	for _, edge := range []string{`le="0.15"`, `le="0.2"`, `le="0.3"`, `le="0.5"`} {
		require.True(t, strings.Contains(got, edge),
			"missing http_request_duration_seconds bucket edge %s", edge)
	}
}
