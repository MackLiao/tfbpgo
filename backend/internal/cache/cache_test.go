package cache

import (
	"context"
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
			_, _, shared, _ := c.GetOrLoad(context.Background(), "k1", func() ([]byte, error) {
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
	_, hit, shared, err := c.GetOrLoad(context.Background(), "k2", func() ([]byte, error) { return body, nil })
	require.NoError(t, err)
	require.False(t, hit)
	require.False(t, shared, "uncontended miss should not be shared")
	got, hit, shared, err := c.GetOrLoad(context.Background(), "k2", func() ([]byte, error) { t.Fatal("should not run"); return nil, nil })
	require.NoError(t, err)
	require.True(t, hit)
	require.False(t, shared, "cache hit short-circuits singleflight")
	require.Equal(t, body, got)
}

func TestOversizeResponseTracked(t *testing.T) {
	c, err := New(Options{BudgetBytes: 1000}) // tiny budget => threshold = 50 bytes
	require.NoError(t, err)
	big := make([]byte, 200)
	_, _, _, _ = c.GetOrLoad(context.Background(), "k3", func() ([]byte, error) { return big, nil })
	require.Equal(t, int64(1), c.OversizeCount())
}
