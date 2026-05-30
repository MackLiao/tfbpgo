package cache

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// TestLoadSecondsAccumulatesOnMissNotHit proves cache_load_seconds_total is
// driven only by the cold/miss path: a miss adds ~loader-duration to the named
// endpoint's accumulator, and a subsequent hit adds nothing.
func TestLoadSecondsAccumulatesOnMissNotHit(t *testing.T) {
	c, err := New(Options{BudgetBytes: 1 << 20})
	require.NoError(t, err)

	const loadDelay = 40 * time.Millisecond
	body := []byte(`{"v":1}`)

	// MISS — loader runs for ~loadDelay.
	_, hit, _, err := c.GetOrLoad(context.Background(), "/api/v/{v}/binding", "k1",
		func() ([]byte, error) {
			time.Sleep(loadDelay)
			return body, nil
		})
	require.NoError(t, err)
	require.False(t, hit)

	afterMiss := c.LoadSeconds()["/api/v/{v}/binding"]
	require.GreaterOrEqual(t, afterMiss, loadDelay.Seconds(),
		"miss must accumulate at least the loader wall-time")
	require.Less(t, afterMiss, 2.0, "sanity: load-seconds should be small")

	// HIT — loader must NOT run, accumulator must NOT advance.
	_, hit, _, err = c.GetOrLoad(context.Background(), "/api/v/{v}/binding", "k1",
		func() ([]byte, error) { t.Fatal("loader ran on a hit"); return nil, nil })
	require.NoError(t, err)
	require.True(t, hit)

	afterHit := c.LoadSeconds()["/api/v/{v}/binding"]
	require.Equal(t, afterMiss, afterHit, "a cache hit must not advance load-seconds")
}

// TestLoadSecondsKeyedPerEndpoint proves the accumulator is keyed by endpoint.
func TestLoadSecondsKeyedPerEndpoint(t *testing.T) {
	c, err := New(Options{BudgetBytes: 1 << 20})
	require.NoError(t, err)
	_, _, _, _ = c.GetOrLoad(context.Background(), "/api/v/{v}/binding", "a",
		func() ([]byte, error) { time.Sleep(20 * time.Millisecond); return []byte("x"), nil })
	_, _, _, _ = c.GetOrLoad(context.Background(), "/api/v/{v}/datasets", "b",
		func() ([]byte, error) { time.Sleep(20 * time.Millisecond); return []byte("y"), nil })

	ls := c.LoadSeconds()
	require.Greater(t, ls["/api/v/{v}/binding"], 0.0)
	require.Greater(t, ls["/api/v/{v}/datasets"], 0.0)
	require.NotContains(t, ls, "/api/v/{v}/perturbation")
}

// TestLoadSecondsAttributedOnFailedLoad proves the `if err != nil` branch in
// GetOrLoad still attributes the loader wall-time: a loader that burns ~30ms
// then errors must charge that time to the endpoint, even though no value is
// cached. This locks in addLoadSeconds being called on the failure path.
func TestLoadSecondsAttributedOnFailedLoad(t *testing.T) {
	c, err := New(Options{BudgetBytes: 1 << 20})
	require.NoError(t, err)

	const loadDelay = 30 * time.Millisecond
	_, _, _, err = c.GetOrLoad(context.Background(), "/api/v/{v}/binding", "kerr",
		func() ([]byte, error) {
			time.Sleep(loadDelay)
			return nil, errors.New("boom")
		})
	require.Error(t, err)

	require.GreaterOrEqual(t, c.LoadSeconds()["/api/v/{v}/binding"], loadDelay.Seconds(),
		"a failed load must still attribute its wall-time to the endpoint")
}
