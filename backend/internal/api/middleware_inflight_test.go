package api

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/BrentLab/tfbpshiny-go/backend/internal/observability"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/prometheus/client_golang/prometheus/testutil"
	"github.com/stretchr/testify/require"
)

// TestInFlightGauge_ReturnsToZeroOnPanic proves the Dec lives in a defer that
// survives middleware.Recoverer. Recoverer is wrapped OUTSIDE RequestLogger so
// the recover() unwinds the stack THROUGH RequestLogger's deferred Dec before
// the panic is swallowed. If the Dec were placed after next.ServeHTTP (not in a
// defer), the panic would skip it and the gauge would leak at 1.
func TestInFlightGauge_ReturnsToZeroOnPanic(t *testing.T) {
	m := observability.New()
	require.Equal(t, 0.0, testutil.ToFloat64(m.HTTPInFlight),
		"gauge must start at 0")

	var seenDuringRequest float64
	panicHandler := http.HandlerFunc(func(_ http.ResponseWriter, _ *http.Request) {
		seenDuringRequest = testutil.ToFloat64(m.HTTPInFlight)
		panic("boom")
	})

	chain := middleware.Recoverer(
		RequestLogger("test-version", m)(panicHandler),
	)

	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v/1/binding", nil)
	chain.ServeHTTP(rr, req)

	require.Equal(t, 1.0, seenDuringRequest,
		"gauge must read 1 while the request is in flight")
	require.Equal(t, http.StatusInternalServerError, rr.Code,
		"Recoverer must convert the panic into a 500")
	require.Equal(t, 0.0, testutil.ToFloat64(m.HTTPInFlight),
		"gauge must return to 0 after a panicking request — Dec leaked")
}

func TestInFlightGauge_ReturnsToPriorValueOnSuccess(t *testing.T) {
	m := observability.New()
	m.HTTPInFlight.Set(3)
	require.Equal(t, 3.0, testutil.ToFloat64(m.HTTPInFlight))

	var seenDuringRequest float64
	okHandler := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		seenDuringRequest = testutil.ToFloat64(m.HTTPInFlight)
		w.WriteHeader(http.StatusOK)
	})
	chain := middleware.Recoverer(RequestLogger("test-version", m)(okHandler))

	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/v/1/datasets", nil)
	chain.ServeHTTP(rr, req)

	require.Equal(t, 4.0, seenDuringRequest, "gauge must read prior+1 in flight")
	require.Equal(t, 3.0, testutil.ToFloat64(m.HTTPInFlight),
		"gauge must return to its prior value after a successful request")
}
