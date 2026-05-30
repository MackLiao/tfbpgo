// Package cache wraps ristretto + singleflight with the §8.1 subtleties:
// check Set() bool, call Wait() after Set(), track oversize responses.
package cache

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"github.com/dgraph-io/ristretto/v2"
	"golang.org/x/sync/singleflight"
)

// Options for the cache.
type Options struct {
	// BudgetBytes is the cost ceiling. OversizeThreshold = BudgetBytes / 20.
	BudgetBytes int64
}

// Cache is a JSON-bytes cache with stampede protection.
type Cache struct {
	store             *ristretto.Cache[string, []byte]
	sf                singleflight.Group
	oversizeThreshold int64
	hitCount          atomic.Int64
	missCount         atomic.Int64
	sharedCount       atomic.Int64
	evictionCount     atomic.Int64

	// Per-endpoint accumulators. Guarded by mu because Prometheus labels are
	// keyed by endpoint and the values are floats/counters that the bridge in
	// main.go snapshots on a ticker. Keyed by the chi route pattern.
	mu                sync.Mutex
	loadSeconds       map[string]float64
	admissionRejected map[string]int64
	oversizeCount     map[string]int64
}

// New constructs a cache. Returns an error if ristretto rejects the config.
func New(opts Options) (*Cache, error) {
	if opts.BudgetBytes <= 0 {
		return nil, fmt.Errorf("BudgetBytes must be > 0")
	}
	c := &Cache{
		oversizeThreshold: opts.BudgetBytes / 20,
		loadSeconds:       map[string]float64{},
		admissionRejected: map[string]int64{},
		oversizeCount:     map[string]int64{},
	}
	rc, err := ristretto.NewCache(&ristretto.Config[string, []byte]{
		NumCounters: opts.BudgetBytes / 32, // ~10x expected items
		MaxCost:     opts.BudgetBytes,
		BufferItems: 64,
		OnEvict:     func(_ *ristretto.Item[[]byte]) { c.evictionCount.Add(1) },
	})
	if err != nil {
		return nil, fmt.Errorf("ristretto: %w", err)
	}
	c.store = rc
	return c, nil
}

// Loader produces the JSON bytes for a cache miss.
type Loader func() ([]byte, error)

// GetOrLoad returns (bytes, hit, shared, err). On miss, calls fn under
// singleflight. `shared` is true when this caller's request was coalesced
// with at least one concurrent in-flight loader for the same key. endpoint is
// the chi route pattern used to attribute loader wall-time, oversize responses,
// and admission rejections to a low-cardinality label.
func (c *Cache) GetOrLoad(_ context.Context, endpoint, key string, fn Loader) ([]byte, bool, bool, error) {
	if v, ok := c.store.Get(key); ok {
		c.hitCount.Add(1)
		return v, true, false, nil
	}
	c.missCount.Add(1)

	v, err, shared := c.sf.Do(key, func() (any, error) {
		loadStart := time.Now()
		body, err := fn()
		elapsed := time.Since(loadStart).Seconds()
		if err != nil {
			// Still attribute the wall-time burned on a failed load so a
			// persistently-failing endpoint shows up in cache_load_seconds_total.
			c.addLoadSeconds(endpoint, elapsed)
			return nil, err
		}
		size := int64(len(body))
		admitted := c.store.Set(key, body, size)
		c.store.Wait() // §8.1 subtlety #2 — make the write visible to the next request
		c.recordLoad(endpoint, elapsed, size, admitted)
		return body, nil
	})
	if shared {
		c.sharedCount.Add(1)
	}
	if err != nil {
		return nil, false, shared, err
	}
	return v.([]byte), false, shared, nil
}

// recordLoad attributes one completed loader run to the endpoint: load-seconds
// always; oversize when the body exceeds the per-item threshold; admission
// rejection when ristretto refused the Set.
func (c *Cache) recordLoad(endpoint string, elapsed float64, size int64, admitted bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.loadSeconds[endpoint] += elapsed
	if size > c.oversizeThreshold {
		c.oversizeCount[endpoint]++
	}
	if !admitted {
		c.admissionRejected[endpoint]++
	}
}

func (c *Cache) addLoadSeconds(endpoint string, elapsed float64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.loadSeconds[endpoint] += elapsed
}

// Counters used by the metrics layer.
func (c *Cache) Hits() int64          { return c.hitCount.Load() }
func (c *Cache) Misses() int64        { return c.missCount.Load() }
func (c *Cache) SharedCalls() int64   { return c.sharedCount.Load() }
func (c *Cache) EvictionCount() int64 { return c.evictionCount.Load() }

// LoadSeconds returns a snapshot copy of cumulative loader wall-seconds per
// endpoint. Safe for the metrics bridge to range over.
func (c *Cache) LoadSeconds() map[string]float64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make(map[string]float64, len(c.loadSeconds))
	for k, v := range c.loadSeconds {
		out[k] = v
	}
	return out
}

// AdmissionRejected returns a snapshot copy of cumulative admission rejections
// per endpoint.
func (c *Cache) AdmissionRejected() map[string]int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make(map[string]int64, len(c.admissionRejected))
	for k, v := range c.admissionRejected {
		out[k] = v
	}
	return out
}

// OversizeCount returns a snapshot copy of cumulative oversize responses per
// endpoint.
func (c *Cache) OversizeCount() map[string]int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make(map[string]int64, len(c.oversizeCount))
	for k, v := range c.oversizeCount {
		out[k] = v
	}
	return out
}

// Close releases the cache.
func (c *Cache) Close() { c.store.Close() }
