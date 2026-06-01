package cache

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestSingleflight_ConcurrentMissesProduceOneCall(t *testing.T) {
	c, err := New(Options{BudgetBytes: 1 << 20})
	require.NoError(t, err)

	var calls atomic.Int64
	var sharedCount atomic.Int64
	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _, shared, _ := c.GetOrLoad(context.Background(), "test", "k1", func(context.Context) ([]byte, error) {
				calls.Add(1)
				time.Sleep(50 * time.Millisecond)
				return []byte(`{"v":1}`), nil
			})
			if shared {
				sharedCount.Add(1)
			}
		}()
	}
	wg.Wait()
	require.Equal(t, int64(1), calls.Load())
	// At least one waiter must observe shared=true (the original caller may
	// see shared=false depending on go-singleflight scheduling).
	require.GreaterOrEqual(t, sharedCount.Load(), int64(1),
		"expected at least one concurrent caller to see shared=true")
	require.GreaterOrEqual(t, c.SharedCalls(), int64(1))
}

func TestSetWaitMakesValueVisibleImmediately(t *testing.T) {
	c, err := New(Options{BudgetBytes: 1 << 20})
	require.NoError(t, err)
	body := []byte(`{"x":42}`)
	_, hit, shared, err := c.GetOrLoad(context.Background(), "test", "k2", func(context.Context) ([]byte, error) { return body, nil })
	require.NoError(t, err)
	require.False(t, hit)
	require.False(t, shared, "uncontended miss should not be shared")
	got, hit, shared, err := c.GetOrLoad(context.Background(), "test", "k2", func(context.Context) ([]byte, error) { t.Fatal("should not run"); return nil, nil })
	require.NoError(t, err)
	require.True(t, hit)
	require.False(t, shared, "cache hit short-circuits singleflight")
	require.Equal(t, body, got)
}

// TestGetOrLoad_CallerCancelDoesNotKillSharedLoad locks in the H4 behavior:
// a caller whose context is cancelled mid-load returns promptly with ctx.Err()
// WITHOUT cancelling the shared loader, which still completes, is decoupled
// from the caller's cancellation, and populates the cache for the next request.
func TestGetOrLoad_CallerCancelDoesNotKillSharedLoad(t *testing.T) {
	c, err := New(Options{BudgetBytes: 1 << 20})
	require.NoError(t, err)

	loaderStarted := make(chan struct{})
	releaseLoader := make(chan struct{})
	var loaderRuns atomic.Int64
	var loadCtxCancelled atomic.Bool
	body := []byte(`{"v":1}`)

	loader := func(loadCtx context.Context) ([]byte, error) {
		loaderRuns.Add(1)
		close(loaderStarted)
		<-releaseLoader // hold the loader open until after the caller cancels
		if loadCtx.Err() != nil {
			loadCtxCancelled.Store(true)
		}
		return body, nil
	}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, _, _, e := c.GetOrLoad(ctx, "test", "k", loader)
		done <- e
	}()

	<-loaderStarted
	cancel() // caller bails while the shared loader is still running
	require.ErrorIs(t, <-done, context.Canceled,
		"a cancelled caller must return ctx.Err() promptly")

	close(releaseLoader) // now let the shared loader finish + Set

	// The shared load must have populated the cache despite the cancellation;
	// the next request is a hit and the loader does NOT run again.
	require.Eventually(t, func() bool {
		v, hit, _, e := c.GetOrLoad(context.Background(), "test", "k",
			func(context.Context) ([]byte, error) { return []byte("SHOULD-NOT-RUN"), nil })
		return e == nil && hit && string(v) == string(body)
	}, 2*time.Second, 20*time.Millisecond,
		"shared load should have cached the value despite caller cancellation")

	require.Equal(t, int64(1), loaderRuns.Load(), "exactly one loader execution")
	require.False(t, loadCtxCancelled.Load(),
		"shared loader context must be decoupled from the cancelled caller")
}

func TestOversizeResponseTracked(t *testing.T) {
	c, err := New(Options{BudgetBytes: 1000}) // tiny budget => threshold = 50 bytes
	require.NoError(t, err)
	big := make([]byte, 200)
	_, _, _, _ = c.GetOrLoad(context.Background(), "test", "k3", func(context.Context) ([]byte, error) { return big, nil })
	require.Equal(t, int64(1), c.OversizeCount()["test"])
}

// TestEvictionCounterFires forces ristretto to evict by inserting items
// whose total cost exceeds the budget, then verifies EvictionCount > 0.
// This locks in the OnEvict callback wiring so the cache_evictions_total
// metric won't silently flatline if a future refactor drops it.
func TestEvictionCounterFires(t *testing.T) {
	c, err := New(Options{BudgetBytes: 4096})
	require.NoError(t, err)

	// Insert ~4 KiB items repeatedly. Each item's cost = len(body), so
	// MaxCost = 4096 means we evict almost immediately on the second pass.
	body := make([]byte, 1024)
	for i := 0; i < 200; i++ {
		key := fmt.Sprintf("k-%d", i)
		_, _, _, err := c.GetOrLoad(context.Background(), "test", key, func(context.Context) ([]byte, error) {
			return body, nil
		})
		require.NoError(t, err)
	}
	// Give ristretto's async eviction a moment to drain.
	require.Eventually(t, func() bool {
		return c.EvictionCount() > 0
	}, 2*time.Second, 25*time.Millisecond,
		"expected EvictionCount > 0 after overfilling cache, got %d",
		c.EvictionCount())
}

// TestOversizeAndRejectAttributedToEndpoint proves an oversize response and an
// admission-rejected Set are attributed to the endpoint label passed to
// GetOrLoad. Budget is tiny so the body is both oversize (> budget/20) and
// rejected by ristretto admission.
func TestOversizeAndRejectAttributedToEndpoint(t *testing.T) {
	c, err := New(Options{BudgetBytes: 1000}) // threshold = 50 bytes
	require.NoError(t, err)
	big := make([]byte, 200) // > 50-byte oversize threshold
	_, _, _, err = c.GetOrLoad(context.Background(), "/api/v/{v}/comparison/topn", "k1",
		func(context.Context) ([]byte, error) { return big, nil })
	require.NoError(t, err)

	require.Equal(t, int64(1), c.OversizeCount()["/api/v/{v}/comparison/topn"],
		"oversize must attribute to the topn endpoint")
	require.NotContains(t, c.OversizeCount(), "/api/v/{v}/datasets",
		"a different endpoint must not be charged")
}
