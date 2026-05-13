// Package cache wraps ristretto + singleflight with the §8.1 subtleties:
// check Set() bool, call Wait() after Set(), track oversize responses.
package cache

import (
	"context"
	"fmt"
	"sync/atomic"

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
	admissionRejected atomic.Int64
	oversizeCount     atomic.Int64
	sharedCount       atomic.Int64
	evictionCount     atomic.Int64
}

// New constructs a cache. Returns an error if ristretto rejects the config.
func New(opts Options) (*Cache, error) {
	if opts.BudgetBytes <= 0 {
		return nil, fmt.Errorf("BudgetBytes must be > 0")
	}
	c := &Cache{
		oversizeThreshold: opts.BudgetBytes / 20,
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
// with at least one concurrent in-flight loader for the same key.
func (c *Cache) GetOrLoad(_ context.Context, key string, fn Loader) ([]byte, bool, bool, error) {
	if v, ok := c.store.Get(key); ok {
		c.hitCount.Add(1)
		return v, true, false, nil
	}
	c.missCount.Add(1)

	v, err, shared := c.sf.Do(key, func() (any, error) {
		body, err := fn()
		if err != nil {
			return nil, err
		}
		size := int64(len(body))
		if size > c.oversizeThreshold {
			c.oversizeCount.Add(1)
		}
		admitted := c.store.Set(key, body, size)
		if !admitted {
			c.admissionRejected.Add(1)
		}
		c.store.Wait() // §8.1 subtlety #2 — make the write visible to the next request
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

// Counters used by the metrics layer.
func (c *Cache) Hits() int64              { return c.hitCount.Load() }
func (c *Cache) Misses() int64            { return c.missCount.Load() }
func (c *Cache) AdmissionRejected() int64 { return c.admissionRejected.Load() }
func (c *Cache) OversizeCount() int64     { return c.oversizeCount.Load() }
func (c *Cache) SharedCalls() int64       { return c.sharedCount.Load() }
func (c *Cache) EvictionCount() int64     { return c.evictionCount.Load() }

// Close releases the cache.
func (c *Cache) Close() { c.store.Close() }
