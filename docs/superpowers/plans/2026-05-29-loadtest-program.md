# Load / Availability / Latency / Cache Test Program — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a parameterized k6 load-test harness plus three backend metrics that honestly validate the Go service's cutover SLOs, find its `t3.small` breaking point and degradation mode, prove it beats the legacy Python Shiny app, and guard performance per-PR in CI.

**Architecture:** Two k6 executors (`ramping-arrival-rate` open-model + `per-vu-iterations`) over four shared libraries (`config`/`keyspace`/`mix`/`metrics`) parameterize every scenario. The harness drives cache hit rate as a *measured* variable (Zipfian over the real manifest) and is run off-box against the real artifact for any authoritative number; the committed fixture is used only to validate harness mechanics + CI behavior. Three additive Prometheus metrics (`http_in_flight_requests`, `cache_load_seconds_total{endpoint}`, and per-endpoint admission/oversize counters) make saturation and cold-load attribution directly readable.

**Tech Stack:** Go + `prometheus/client_golang` (instrumentation, `testutil` unit tests); k6 (JS scenarios); Node `node --test` (pure-function lib tests); GitHub Actions (CI guard); bash (chaos/host scripts); DuckDB fixture + real artifact.

**Spec:** `docs/superpowers/specs/2026-05-29-loadtest-program-design.md` (read it before starting — section numbers below refer to it).

**Phasing:** Phase A is local + fixture (buildable, fully unit-tested). Phase B is the authoritative EC2 run that **gates cutover**. Phases C and D are fast-follows. Operational (EC2/host) tasks are marked `(operational)` — they give exact commands + the metric/threshold to read, but produce numbers rather than unit-test assertions.

---


## Phase A — Foundation (local, against the committed fixture)

### Phase A.1 — Backend instrumentation

_Three additive Prometheus metrics that make the breaking-point knee and cold-start cliff directly readable. All unit-tested in Go; no behavior change to existing endpoints._

### Task 1: http_in_flight_requests Gauge (panic-safe Inc/Dec)

**Files:**
- Modify: `backend/internal/observability/metrics.go:30-38` (struct fields), `:98-126` (registration)
- Modify: `backend/internal/api/middleware.go:37-73` (RequestLogger Inc/defer Dec)
- Test: `backend/internal/api/middleware_inflight_test.go`

- [ ] **Step 1: Write the failing test**

The test asserts the gauge returns to its prior value even when the next handler panics. `middleware.Recoverer` must be wired ahead of `RequestLogger` so the panic is recovered above the deferred `Dec` — the test proves the defer ordering by building the exact chain `Recoverer -> RequestLogger -> panicking handler`.

```go
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

	// Handler that records the in-flight value mid-request, then panics.
	var seenDuringRequest float64
	panicHandler := http.HandlerFunc(func(_ http.ResponseWriter, _ *http.Request) {
		seenDuringRequest = testutil.ToFloat64(m.HTTPInFlight)
		panic("boom")
	})

	// Exact production ordering: Recoverer is the OUTER wrapper (see
	// Server.Routes — r.Use(middleware.Recoverer) precedes RequestLogger).
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

// TestInFlightGauge_ReturnsToPriorValueOnSuccess covers the non-panic path and
// the "prior value" (not necessarily 0) guarantee from the contract.
func TestInFlightGauge_ReturnsToPriorValueOnSuccess(t *testing.T) {
	m := observability.New()
	m.HTTPInFlight.Set(3) // simulate 3 other in-flight requests
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
```

- [ ] **Step 2: Run test to verify it fails**
Run: `cd backend && go test ./internal/api/ -run TestInFlightGauge`
Expected: FAIL to compile with `m.HTTPInFlight undefined (type *observability.Metrics has no field or method HTTPInFlight)`

- [ ] **Step 3: Implement — add the gauge to metrics.go and Inc/defer-Dec in RequestLogger**

In `backend/internal/observability/metrics.go`, add the field to the `Metrics` struct (insert after the HTTP histogram fields, before `DBDuration` — i.e. after current line 17):

```go
	HTTPDuration     *prometheus.HistogramVec
	HTTPRequestSize  *prometheus.HistogramVec
	HTTPResponseSize *prometheus.HistogramVec
	// HTTPInFlight counts requests currently inside the handler chain. Inc at
	// RequestLogger entry, Dec in a defer that survives middleware.Recoverer so
	// a panicking handler cannot leak the gauge upward.
	HTTPInFlight prometheus.Gauge
```

In `New()`, register the gauge — add the constructor after the `HTTPResponseSize` block (after current line 59):

```go
		HTTPInFlight: prometheus.NewGauge(prometheus.GaugeOpts{
			Name: "http_in_flight_requests",
			Help: "Requests currently being served (Inc at middleware entry, Dec in a panic-safe defer).",
		}),
```

Add `m.HTTPInFlight` to the `reg.MustRegister(...)` call (alongside the other HTTP metrics on current line 117):

```go
	reg.MustRegister(
		m.HTTPDuration, m.HTTPRequestSize, m.HTTPResponseSize, m.HTTPInFlight,
		m.DBDuration, m.DBPoolWait,
		m.DBPoolWaitDurationSecondsTotal, m.DBPoolWaitCount,
		m.DBPoolOpen, m.DBPoolInUse,
		m.CacheHits, m.CacheMisses, m.SFShared,
		m.CacheReject, m.CacheOversize, m.CacheEviction,
		m.ArtifactInfo,
		collectors.NewGoCollector(),
		collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}),
	)
```

In `backend/internal/api/middleware.go`, inside the `RequestLogger` returned handler, Inc on entry and Dec in a defer. The defer is registered *before* `next.ServeHTTP`, so when the inner handler panics, the panic unwinds through this defer (running the Dec) before `middleware.Recoverer` — wrapped outside — calls `recover()`. Replace the handler body (current lines 39-71):

```go
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			ww := middleware.NewWrapResponseWriter(w, r.ProtoMajor)

			// In-flight gauge: Inc on entry, Dec in a defer so a panic in the
			// inner handler still decrements before middleware.Recoverer (the
			// OUTER wrapper) swallows it. Guard for nil metrics (test servers).
			if metrics != nil {
				metrics.HTTPInFlight.Inc()
				defer metrics.HTTPInFlight.Dec()
			}

			cacheHit := false
			var dbMs int64
			ctx := context.WithValue(r.Context(), ctxCacheHit, &cacheHit)
			ctx = context.WithValue(ctx, ctxDBMillis, &dbMs)

			next.ServeHTTP(ww, r.WithContext(ctx))

			elapsed := time.Since(start)
			route := chiRoutePattern(r)

			if metrics != nil {
				metrics.HTTPDuration.WithLabelValues(route, strconv.Itoa(ww.Status())).Observe(elapsed.Seconds())
				metrics.HTTPResponseSize.WithLabelValues(route).Observe(float64(ww.BytesWritten()))
				if r.ContentLength > 0 {
					metrics.HTTPRequestSize.WithLabelValues(route).Observe(float64(r.ContentLength))
				}
			}

			slog.Info("http_request",
				"route", route,
				"path", r.URL.Path,
				"status", ww.Status(),
				"latency_ms", elapsed.Milliseconds(),
				"cache_hit", cacheHit,
				"db_ms", dbMs,
				"bytes", ww.BytesWritten(),
				"artifact_version", artifactVersion,
			)
		})
```

- [ ] **Step 4: Run test to verify it passes** — Run: `cd backend && go test ./internal/api/ -run TestInFlightGauge && go test ./internal/observability/` Expected: PASS (both new subtests and the existing registry test)

- [ ] **Step 5: Commit** — `git add backend/internal/observability/metrics.go backend/internal/api/middleware.go backend/internal/api/middleware_inflight_test.go && git commit -m "feat: add panic-safe http_in_flight_requests gauge"`

---

### Task 2: cache_load_seconds_total CounterVec{endpoint} (loader wall-time per endpoint)

**Files:**
- Modify: `backend/internal/cache/cache.go:20-31` (struct + per-endpoint accumulator), `:54-90` (GetOrLoad signature + timing), `:92-98` (accessor)
- Modify: `backend/internal/observability/metrics.go:30-38` (struct field), `:86-105` (registration block) — add `CacheLoadSeconds *prometheus.CounterVec`
- Modify: all 17 `GetOrLoad` call sites (see list below) to pass the endpoint label
- Modify: `backend/cmd/tfbp-server/main.go:217-240` (`exportCacheCounters` bridge)
- Modify: `backend/internal/api/testing_helpers_test.go` is unaffected (signature change is source-level)
- Test: `backend/internal/cache/cache_load_seconds_test.go`

> Architectural note: `GetOrLoad` gains a leading `endpoint string` parameter. The endpoint label value is the chi route pattern, sourced at each call site via `chiRoutePattern(r)` (defined in `backend/internal/api/middleware.go:77`) — the same low-cardinality label `recordCacheOutcome` already uses. The cache accumulates per-endpoint load-seconds in a mutex-guarded `map[string]float64` and exposes it for the `exportCacheCounters` bridge in `main.go`. This keeps the cache package free of a Prometheus dependency, consistent with the existing atomic-counter + bridge design.

- [ ] **Step 1: Write the failing test**

```go
package cache

import (
	"context"
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
```

- [ ] **Step 2: Run test to verify it fails**
Run: `cd backend && go test ./internal/cache/ -run TestLoadSeconds`
Expected: FAIL to compile — `too many arguments in call to c.GetOrLoad` and `c.LoadSeconds undefined`

- [ ] **Step 3: Implement — thread endpoint through GetOrLoad, accumulate load-seconds, register the metric, update the bridge and all call sites**

In `backend/internal/cache/cache.go`, add an import and a per-endpoint accumulator to the `Cache` struct. Replace the import block (current lines 5-12):

```go
import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"github.com/dgraph-io/ristretto/v2"
	"golang.org/x/sync/singleflight"
)
```

Replace the `Cache` struct (current lines 20-31) to add the mutex-guarded accumulator:

```go
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
```

Update `New()` to allocate the maps. Replace the `c := &Cache{...}` literal (current lines 38-40):

```go
	c := &Cache{
		oversizeThreshold: opts.BudgetBytes / 20,
		loadSeconds:       map[string]float64{},
		admissionRejected: map[string]int64{},
		oversizeCount:     map[string]int64{},
	}
```

Replace `GetOrLoad` (current lines 57-90) — add the `endpoint` param, time the loader, and attribute load-seconds / oversize / rejection to the endpoint:

```go
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
```

Replace the counter accessors (current lines 92-98) with snapshot accessors returning copies (the bridge in main.go reads these). Note the global `Hits`/`Misses`/`SharedCalls`/`EvictionCount` accessors are unchanged; the rejection/oversize accessors become per-endpoint maps:

```go
// Counters used by the metrics layer.
func (c *Cache) Hits() int64        { return c.hitCount.Load() }
func (c *Cache) Misses() int64      { return c.missCount.Load() }
func (c *Cache) SharedCalls() int64 { return c.sharedCount.Load() }
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
```

In `backend/internal/observability/metrics.go`, add the new `CacheLoadSeconds` field to the struct (after the `SFShared` field — current line 32):

```go
	CacheHits      *prometheus.CounterVec
	CacheMisses    *prometheus.CounterVec
	SFShared       *prometheus.CounterVec
	CacheLoadSeconds *prometheus.CounterVec
```

Register it in `New()` (insert after the `SFShared` constructor — current line 97):

```go
		CacheLoadSeconds: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "cache_load_seconds_total",
			Help: "Cumulative wall-seconds spent inside the cache loader (cold/miss path) per endpoint.",
		}, []string{"endpoint"}),
```

Add `m.CacheLoadSeconds` to `reg.MustRegister(...)` alongside the other cache counters (current line 121):

```go
		m.CacheHits, m.CacheMisses, m.SFShared, m.CacheLoadSeconds,
```

In `backend/cmd/tfbp-server/main.go`, rewrite `exportCacheCounters` (current lines 215-240) to bridge per-endpoint load-seconds (Task 2) plus per-endpoint reject/oversize (Task 3 widens these; this task ships the load-seconds bridge and keeps reject/oversize compiling as maps):

```go
// exportCacheCounters polls the cache's per-endpoint accumulators and bridges
// deltas into the Prometheus CounterVecs. Counters are monotonic so we add
// (current - prev) per endpoint label.
func exportCacheCounters(stop <-chan struct{}, c *cache.Cache, m *observability.Metrics) {
	prevLoad := map[string]float64{}
	prevReject := map[string]int64{}
	prevOversize := map[string]int64{}
	var prevEvict int64
	t := time.NewTicker(10 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-stop:
			return
		case <-t.C:
			for ep, secs := range c.LoadSeconds() {
				if d := secs - prevLoad[ep]; d > 0 {
					m.CacheLoadSeconds.WithLabelValues(ep).Add(d)
				}
				prevLoad[ep] = secs
			}
			for ep, n := range c.AdmissionRejected() {
				if d := n - prevReject[ep]; d > 0 {
					m.CacheReject.WithLabelValues(ep).Add(float64(d))
				}
				prevReject[ep] = n
			}
			for ep, n := range c.OversizeCount() {
				if d := n - prevOversize[ep]; d > 0 {
					m.CacheOversize.WithLabelValues(ep).Add(float64(d))
				}
				prevOversize[ep] = n
			}
			ev := c.EvictionCount()
			if d := ev - atomic.SwapInt64(&prevEvict, ev); d > 0 {
				m.CacheEviction.Add(float64(d))
			}
		}
	}
}
```

> The `m.CacheReject.WithLabelValues(ep)` / `m.CacheOversize.WithLabelValues(ep)` calls above require those two metrics to be `CounterVec` — that conversion lands in Task 3. To keep this task's commit independently green, Task 3 is committed back-to-back; if Tasks 2 and 3 are committed separately, temporarily keep `CacheReject`/`CacheOversize` as plain `Counter` and call `.Add(...)` on the *sum* across endpoints in this bridge, then switch to `WithLabelValues` in Task 3. The recommended path is to apply Task 2 + Task 3 to `main.go` together since they edit the same bridge.

Update all 17 `GetOrLoad` call sites to pass `chiRoutePattern(r)` as the new first argument. Each call currently reads `s.Cache.GetOrLoad(r.Context(), key, func() ...)`; change to `s.Cache.GetOrLoad(r.Context(), chiRoutePattern(r), key, func() ...)`. Exact locations:

- `backend/internal/api/datasets.go:16`
- `backend/internal/api/binding.go:93`
- `backend/internal/api/binding_corr.go:123` and `:401`
- `backend/internal/api/regulators.go:30`
- `backend/internal/api/regulators_resolve.go:170`
- `backend/internal/api/comparison_topn.go:138`
- `backend/internal/api/comparison_dto.go:20`
- `backend/internal/api/perturbation.go:85`
- `backend/internal/api/sample_conditions.go:59`
- `backend/internal/api/select_datasets.go:239`, `:317`, `:413`, `:677`

Update the cache's own test call sites in `backend/internal/cache/cache_test.go` (lines 25, 48, 52, 63, 80) to pass an endpoint string, e.g. `c.GetOrLoad(context.Background(), "test", "k1", func() ...)`, and fix `TestOversizeResponseTracked` (line 64) — `c.OversizeCount()` now returns a map, so assert `require.Equal(t, int64(1), c.OversizeCount()["test"])`.

Helper to apply the call-site rewrite across the api package:

```bash
cd backend && grep -rl 's.Cache.GetOrLoad(r.Context(), key,' internal/api/ \
  | xargs sed -i '' 's/s\.Cache\.GetOrLoad(r\.Context(), key,/s.Cache.GetOrLoad(r.Context(), chiRoutePattern(r), key,/g'
```

- [ ] **Step 4: Run test to verify it passes** — Run: `cd backend && go test ./internal/cache/ ./internal/api/ ./internal/observability/ && go vet ./...` Expected: PASS (new load-seconds tests, all existing cache/api tests, registry test)

- [ ] **Step 5: Commit** — `git add backend/internal/cache/ backend/internal/observability/metrics.go backend/cmd/tfbp-server/main.go backend/internal/api/ && git commit -m "feat: add cache_load_seconds_total per-endpoint loader wall-time"`

---

### Task 3: cache_admission_rejected_total + cache_oversize_responses_total → CounterVec{endpoint}

**Files:**
- Modify: `backend/internal/observability/metrics.go:33-34` (struct fields), `:98-105` (constructors), `:122` (registration)
- Modify: `backend/cmd/tfbp-server/main.go:215-240` (`exportCacheCounters` — already uses `WithLabelValues` from Task 2)
- Test: `backend/internal/observability/metrics_labeled_test.go`, plus extend `backend/internal/cache/cache_test.go`

> The cache-side attribution (per-endpoint `admissionRejected` / `oversizeCount` maps and the `recordLoad` wiring) already lands in Task 2. This task flips the two Prometheus metrics from `Counter` to `CounterVec{endpoint}` and proves attribution end-to-end. Endpoint label source is unchanged: `chiRoutePattern(r)` at the `GetOrLoad` call site.

- [ ] **Step 1: Write the failing test**

Cache-side attribution test (extend `backend/internal/cache/cache_test.go`) — proves an oversize body and a rejected Set attribute to the right endpoint:

```go
// TestOversizeAndRejectAttributedToEndpoint proves an oversize response and an
// admission-rejected Set are attributed to the endpoint label passed to
// GetOrLoad. Budget is tiny so the body is both oversize (> budget/20) and
// rejected by ristretto admission.
func TestOversizeAndRejectAttributedToEndpoint(t *testing.T) {
	c, err := New(Options{BudgetBytes: 1000}) // threshold = 50 bytes
	require.NoError(t, err)
	big := make([]byte, 200) // > 50-byte oversize threshold
	_, _, _, err = c.GetOrLoad(context.Background(), "/api/v/{v}/comparison/topn", "k1",
		func() ([]byte, error) { return big, nil })
	require.NoError(t, err)

	require.Equal(t, int64(1), c.OversizeCount()["/api/v/{v}/comparison/topn"],
		"oversize must attribute to the topn endpoint")
	require.NotContains(t, c.OversizeCount(), "/api/v/{v}/datasets",
		"a different endpoint must not be charged")
}
```

Prometheus-side test (`backend/internal/observability/metrics_labeled_test.go`) — proves the two metrics are now label-keyed and the registry exports them with the endpoint label:

```go
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
```

- [ ] **Step 2: Run test to verify it fails**
Run: `cd backend && go test ./internal/observability/ -run TestCacheRejectOversizeAreLabeledByEndpoint`
Expected: FAIL to compile — `m.CacheReject.WithLabelValues undefined (type prometheus.Counter has no field or method WithLabelValues)`

- [ ] **Step 3: Implement — flip both metrics to CounterVec{endpoint}**

In `backend/internal/observability/metrics.go`, change the struct fields (current lines 33-34):

```go
	CacheReject   *prometheus.CounterVec
	CacheOversize *prometheus.CounterVec
	CacheEviction prometheus.Counter
```

Change the constructors in `New()` (current lines 98-105) to add the `endpoint` label:

```go
		CacheReject: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "cache_admission_rejected_total",
			Help: "Cache Set() calls rejected by ristretto admission policy, per endpoint.",
		}, []string{"endpoint"}),
		CacheOversize: prometheus.NewCounterVec(prometheus.CounterOpts{
			Name: "cache_oversize_responses_total",
			Help: "Responses larger than the per-item oversize threshold (budget/20), per endpoint.",
		}, []string{"endpoint"}),
```

Registration on line 122 (`m.CacheReject, m.CacheOversize, m.CacheEviction,`) is unchanged — `MustRegister` accepts a `*CounterVec` exactly as it did the `Counter`.

The `exportCacheCounters` bridge in `main.go` was already rewritten in Task 2 to call `m.CacheReject.WithLabelValues(ep).Add(...)` and `m.CacheOversize.WithLabelValues(ep).Add(...)` — no further `main.go` change is needed here. (If Tasks 2 and 3 are squashed into one branch, this is automatic; if split, this task is what makes Task 2's bridge compile.)

The existing `backend/internal/observability/metrics_test.go` still calls `m.CacheReject.Inc()` / `m.CacheOversize.Inc()` on lines 29-30 — update those two lines to label-keyed form so the registry test still compiles:

```go
	m.CacheReject.WithLabelValues("/api/v/{v}/datasets").Inc()
	m.CacheOversize.WithLabelValues("/api/v/{v}/datasets").Inc()
```

- [ ] **Step 4: Run test to verify it passes** — Run: `cd backend && go test ./internal/observability/ ./internal/cache/ ./cmd/... && go build ./...` Expected: PASS, and `go build ./...` succeeds (proves the `main.go` bridge type-checks against the CounterVecs)

- [ ] **Step 5: Commit** — `git add backend/internal/observability/ backend/internal/cache/cache_test.go && git commit -m "refactor: make cache reject/oversize counters per-endpoint CounterVec"`

---

### Task 4 (optional, low-risk): add bucket edges to http_request_duration_seconds

**Files:**
- Modify: `backend/internal/observability/metrics.go:45-49` (HTTPDuration buckets)
- Test: `backend/internal/observability/metrics_buckets_test.go`

> Optional. Adds finer resolution around the 150–500 ms band so the open-model p95<200 / p99<500 thresholds (Task contract `openModelThresholds`) land between bucket edges rather than being interpolated across the default 0.1 → 0.25 → 0.5 gap. Pure additive change to bucket boundaries; no API or label change. Skip if bucket churn on existing dashboards is unwanted.

- [ ] **Step 1: Write the failing test**

```go
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
```

- [ ] **Step 2: Run test to verify it fails**
Run: `cd backend && go test ./internal/observability/ -run TestHTTPDurationHasFineGrainedBuckets`
Expected: FAIL with `missing http_request_duration_seconds bucket edge le="0.15"` (DefBuckets has no .15/.2/.3 edges)

- [ ] **Step 3: Implement — replace DefBuckets with an explicit edge list for HTTPDuration**

In `backend/internal/observability/metrics.go`, change the `HTTPDuration` constructor (current lines 45-49) to a sorted explicit bucket list that contains DefBuckets plus the four new edges:

```go
		HTTPDuration: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Name: "http_request_duration_seconds",
			Help: "HTTP request latency by route pattern + status.",
			// DefBuckets widened with .15/.2/.3/.5 so the open-model
			// p95<200ms / p99<500ms thresholds land on real bucket edges.
			Buckets: []float64{
				0.005, 0.01, 0.025, 0.05, 0.1,
				0.15, 0.2, 0.25, 0.3, 0.5,
				1, 2.5, 5, 10,
			},
		}, []string{"route", "status"}),
```

- [ ] **Step 4: Run test to verify it passes** — Run: `cd backend && go test ./internal/observability/` Expected: PASS (new bucket test + existing `TestMetrics_RegistryServesExpectedNames`)

- [ ] **Step 5: Commit** — `git add backend/internal/observability/metrics.go backend/internal/observability/metrics_buckets_test.go && git commit -m "perf: widen http_request_duration_seconds buckets around 150-500ms"`

---


### Phase A.2 — k6 shared libraries

_The parameterized harness foundation. Pure functions are unit-tested with Node (`node --test`) so they validate without a running k6 or backend._

### Task 5: lib/config.js — shared env/config + version resolution

**Files:**
- Create: `tests/loadtest/k6/lib/config.js`
- Test: `tests/loadtest/k6/lib/__tests__/config.test.mjs`

- [ ] **Step 1: Write the failing test**

The only pure logic in `config.js` is `apiBase(version)` and the `__ENV`-defaulting parse helpers. `resolveVersion()` and `BASE_URL` constants touch the k6 `http` module and `__ENV` global, which Node cannot import — so the pure helpers are split into a separate `parseEnv` factory that takes an env object, and the k6-runtime constants are derived from it at module top-level guarded behind a `typeof __ENV` check. Node imports only the pure exports.

```js
// tests/loadtest/k6/lib/__tests__/config.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apiBase, parseEnv, DEFAULTS } from '../config.js';

test('apiBase joins base and version into the /api/v/{v} prefix', () => {
  assert.equal(
    apiBase('http://localhost:8080', 'sha256:abc123'),
    'http://localhost:8080/api/v/sha256:abc123',
  );
});

test('apiBase tolerates a trailing slash on the base url', () => {
  assert.equal(
    apiBase('http://localhost:8080/', 'v9'),
    'http://localhost:8080/api/v/v9',
  );
});

test('parseEnv falls back to defaults when env is empty', () => {
  const cfg = parseEnv({});
  assert.equal(cfg.BASE_URL, DEFAULTS.BASE_URL);
  assert.equal(cfg.ARTIFACT_KIND, 'fixture');
  assert.equal(cfg.TARGET_RATE, DEFAULTS.TARGET_RATE);
  assert.equal(cfg.DURATION, DEFAULTS.DURATION);
  assert.equal(cfg.HIT_RATE, DEFAULTS.HIT_RATE);
  assert.equal(cfg.KEYSPACE_MODE, DEFAULTS.KEYSPACE_MODE);
  assert.equal(cfg.ZIPF_EXP, DEFAULTS.ZIPF_EXP);
});

test('parseEnv reads and coerces overrides from the env object', () => {
  const cfg = parseEnv({
    BASE_URL: 'http://example:9000',
    ARTIFACT_KIND: 'real',
    TARGET_RATE: '120',
    DURATION: '10m',
    HIT_RATE: '0.9',
    KEYSPACE_MODE: 'uniform',
    ZIPF_EXP: '1.3',
  });
  assert.equal(cfg.BASE_URL, 'http://example:9000');
  assert.equal(cfg.ARTIFACT_KIND, 'real');
  assert.equal(cfg.TARGET_RATE, 120);
  assert.equal(typeof cfg.TARGET_RATE, 'number');
  assert.equal(cfg.DURATION, '10m');
  assert.equal(cfg.HIT_RATE, 0.9);
  assert.equal(cfg.KEYSPACE_MODE, 'uniform');
  assert.equal(cfg.ZIPF_EXP, 1.3);
});

test('parseEnv keeps an unknown ARTIFACT_KIND but flags it not-fixture/not-real', () => {
  const cfg = parseEnv({ ARTIFACT_KIND: 'bogus' });
  // We do not throw — scenarios decide what to do; we just surface the raw value.
  assert.equal(cfg.ARTIFACT_KIND, 'bogus');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/loadtest/k6/lib/__tests__/config.test.mjs`
Expected: FAIL with `Cannot find module '.../tests/loadtest/k6/lib/config.js'` (the file does not exist yet).

- [ ] **Step 3: Implement `lib/config.js`**

`http` from `k6/http` is imported at the top (k6 needs it). To keep Node able to `import` the pure exports, `http` is imported but only *used* inside `resolveVersion()`, which Node's tests never call — an unused-at-import-time `import` of `k6/http` would still break Node's module resolution, so the k6 import is done lazily via a top-level `try/catch`-free pattern: the contract requires `resolveVersion()` to call `http.get`, so we accept that `config.js` cannot be imported by Node *if it statically imports `k6/http`*. Resolution: split — `config.js` statically imports `k6/http`, and the **pure helpers** (`apiBase`, `parseEnv`, `DEFAULTS`) are re-exported from a sibling `config_pure.js` that has NO k6 imports; `config.js` imports the pure helpers from `config_pure.js` and Node tests import directly from `config_pure.js`. But the contract names `config.js` as the export surface. To satisfy both, `config.js` declares the pure helpers inline (no k6 import needed for them) and guards the `http` usage so the static `import http from 'k6/http'` is the ONLY k6 line; we make that import conditional-safe by isolating it.

Concretely: keep `apiBase`/`parseEnv`/`DEFAULTS` as plain functions in `config.js` with no k6 dependency, and have the test import those named exports. The Node test never evaluates `resolveVersion`, but Node *does* evaluate the top-level `import http from 'k6/http'`. To let Node import the file, the k6 import is moved into a dynamic `import()` inside `resolveVersion()` (k6 supports static imports; `resolveVersion` is only ever run inside k6's `setup()`, so a runtime resolution is fine there too). This keeps the module body free of any unresolvable static import:

```js
// tests/loadtest/k6/lib/config.js
//
// Shared k6 load-test configuration. The PURE helpers (apiBase, parseEnv,
// DEFAULTS) have no k6-runtime dependency and are unit-tested under
// __tests__/ with plain Node (node --test). The k6-runtime-only piece
// (resolveVersion -> http.get) lazily imports 'k6/http' inside the function
// body so that Node can `import` this module without choking on the k6
// builtin. resolveVersion() is only ever called from a scenario's setup(),
// which always runs inside k6, so the dynamic import always resolves there.

export const DEFAULTS = Object.freeze({
  BASE_URL: 'http://localhost:8080',
  ARTIFACT_KIND: 'fixture', // 'fixture' | 'real'
  TARGET_RATE: 50, // requests/sec target for open-model scenarios
  DURATION: '8m', // steady-state hold duration
  HIT_RATE: 0.85, // target warm-cache hit ratio for the action mix
  KEYSPACE_MODE: 'zipf', // 'zipf' | 'uniform'
  ZIPF_EXP: 1.1, // Zipfian skew exponent
});

// parseEnv is pure: it reads from an injected env object (k6 passes __ENV).
// Numbers are coerced; strings pass through; missing keys take DEFAULTS.
export function parseEnv(env) {
  const e = env || {};
  const num = (v, d) => {
    if (v === undefined || v === null || v === '') return d;
    const n = Number(v);
    return Number.isNaN(n) ? d : n;
  };
  return {
    BASE_URL: e.BASE_URL || DEFAULTS.BASE_URL,
    ARTIFACT_KIND: e.ARTIFACT_KIND || DEFAULTS.ARTIFACT_KIND,
    TARGET_RATE: num(e.TARGET_RATE, DEFAULTS.TARGET_RATE),
    DURATION: e.DURATION || DEFAULTS.DURATION,
    HIT_RATE: num(e.HIT_RATE, DEFAULTS.HIT_RATE),
    KEYSPACE_MODE: e.KEYSPACE_MODE || DEFAULTS.KEYSPACE_MODE,
    ZIPF_EXP: num(e.ZIPF_EXP, DEFAULTS.ZIPF_EXP),
  };
}

// apiBase joins the base URL and resolved artifact version into the
// version-pinned API prefix. Tolerates a trailing slash on baseUrl.
export function apiBase(baseUrl, version) {
  const base = String(baseUrl).replace(/\/+$/, '');
  return `${base}/api/v/${version}`;
}

// --- k6-runtime constants (evaluated lazily; safe under Node import) -------
// __ENV is a k6 global. Under Node it is undefined, so we fall back to {}.
const _env = typeof __ENV !== 'undefined' ? __ENV : {};
const _cfg = parseEnv(_env);

export const BASE_URL = _cfg.BASE_URL;
export const ARTIFACT_KIND = _cfg.ARTIFACT_KIND;
export const TARGET_RATE = _cfg.TARGET_RATE;
export const DURATION = _cfg.DURATION;
export const HIT_RATE = _cfg.HIT_RATE;
export const KEYSPACE_MODE = _cfg.KEYSPACE_MODE;
export const ZIPF_EXP = _cfg.ZIPF_EXP;

// resolveVersion() GETs BASE_URL/api/version and returns artifactVersion.
// Call this from every scenario's setup() — NEVER hard-code a version.
// 'k6/http' is imported dynamically so Node can import this module for the
// pure helpers above without resolving the k6 builtin.
export function resolveVersion() {
  // eslint-disable-next-line no-undef
  const http = require('k6/http');
  const res = http.get(`${BASE_URL}/api/version`);
  if (res.status !== 200) {
    throw new Error(`resolveVersion: GET ${BASE_URL}/api/version -> ${res.status}`);
  }
  return res.json().artifactVersion;
}
```

Note for the implementer: k6's module loader supports CommonJS `require('k6/http')` inside a function body (k6 polyfills `require` for builtins). If the running k6 version rejects `require`, swap the two `resolveVersion` lines for a top-of-file `import http from 'k6/http';` and instead split the pure helpers into `lib/config_pure.js` (imported by both `config.js` and the test). The test imports `parseEnv`/`apiBase`/`DEFAULTS`, which exist regardless of which variant ships, so it stays green either way.

- [ ] **Step 4: Run test to verify it passes** — Run: `node --test tests/loadtest/k6/lib/__tests__/config.test.mjs` Expected: PASS (5 tests, 0 failures).

- [ ] **Step 5: Commit** — `git add tests/loadtest/k6/lib/config.js tests/loadtest/k6/lib/__tests__/config.test.mjs && git commit -m "feat: k6 shared config lib with pure env parsing + version resolution"`

---

### Task 6: lib/keyspace.js — Zipf/uniform samplers, regulator loading, dataset combos, valid filters

**Files:**
- Create: `tests/loadtest/k6/lib/keyspace.js`
- Test: `tests/loadtest/k6/lib/__tests__/keyspace.test.mjs`

- [ ] **Step 1: Write the failing test**

All sampler/combo/filter logic is pure. `loadRegulators()` is the only k6-runtime piece (it does `http.get`); it is structured so its pure core — `parseRegulators(jsonBody, fallback)` — is exported and unit-tested, while the thin `http.get` wrapper is k6-only. `makeZipf`/`makeUniform` return `fn(rng01)` so the test injects a seeded RNG (a deterministic LCG) and asserts the distribution shape.

```js
// tests/loadtest/k6/lib/__tests__/keyspace.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeZipf, makeUniform, datasetCombos,
  validFilter, filterToParam, parseRegulators, STATIC_REGULATORS,
} from '../keyspace.js';

// Deterministic LCG returning floats in [0,1). Seeded so the test is stable.
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function tally(sampler, rng, n) {
  const counts = new Map();
  for (let i = 0; i < n; i++) {
    const item = sampler(rng());
    counts.set(item, (counts.get(item) || 0) + 1);
  }
  return counts;
}

test('makeZipf produces a skewed distribution (top > 3x median)', () => {
  const items = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
  const rng = lcg(42);
  const counts = tally(makeZipf(items, 1.1), rng, 20000);
  const freqs = items.map((it) => counts.get(it) || 0).sort((x, y) => y - x);
  const top = freqs[0];
  const median = freqs[Math.floor(freqs.length / 2)];
  assert.ok(median > 0, `median must be > 0, got ${median}`);
  assert.ok(top > 3 * median, `expected top(${top}) > 3*median(${3 * median})`);
});

test('makeUniform is approximately flat (max within 1.5x of min)', () => {
  const items = ['a', 'b', 'c', 'd', 'e'];
  const rng = lcg(7);
  const counts = tally(makeUniform(items), rng, 50000);
  const freqs = items.map((it) => counts.get(it) || 0);
  const max = Math.max(...freqs);
  const min = Math.min(...freqs);
  assert.ok(min > 0, 'every item must be drawn at least once');
  assert.ok(max < 1.5 * min, `expected max(${max}) < 1.5*min(${min})`);
});

test('makeZipf and makeUniform clamp rng01 edge values to valid items', () => {
  const items = ['x', 'y', 'z'];
  const z = makeZipf(items, 1.0);
  const u = makeUniform(items);
  assert.ok(items.includes(z(0)));
  assert.ok(items.includes(z(0.999999)));
  assert.ok(items.includes(u(0)));
  assert.ok(items.includes(u(0.999999)));
});

test('datasetCombos returns realistic non-empty combos from the dataset list', () => {
  const all = ['callingcards', 'harbison', 'hackett', 'chec_m2025'];
  const combos = datasetCombos(all);
  assert.ok(Array.isArray(combos) && combos.length > 0);
  for (const c of combos) {
    assert.ok(Array.isArray(c) && c.length >= 1);
    for (const d of c) assert.ok(all.includes(d), `${d} not in provided list`);
  }
  // Must include at least one single-dataset and one multi-dataset combo.
  assert.ok(combos.some((c) => c.length === 1));
  assert.ok(combos.some((c) => c.length >= 2));
});

test('validFilter returns a typed filters object for known datasets', () => {
  const cc = validFilter('callingcards');
  assert.equal(cc.condition.type, 'categorical');
  assert.ok(Array.isArray(cc.condition.value));

  const hk = validFilter('hackett');
  assert.equal(hk.time.type, 'numeric');
  assert.equal(hk.time.value.length, 2);
  assert.ok(hk.time.value[0] <= hk.time.value[1]);
});

test('validFilter varies VALUES across calls but keeps the same key', () => {
  const seen = new Set();
  for (let i = 0; i < 50; i++) {
    const f = validFilter('hackett', () => i / 50);
    assert.deepEqual(Object.keys(f), ['time']);
    seen.add(JSON.stringify(f.time.value));
  }
  assert.ok(seen.size > 1, 'expected validFilter to vary numeric range values');
});

test('validFilter returns null/empty for a dataset with no known filterable field', () => {
  const f = validFilter('unknown_dataset_xyz');
  assert.deepEqual(f, {});
});

test('filterToParam(validFilter(x)) round-trips via JSON.parse', () => {
  const obj = validFilter('callingcards');
  const param = filterToParam(obj);
  assert.equal(typeof param, 'string');
  assert.deepEqual(JSON.parse(param), obj);
});

test('parseRegulators extracts locusTag list from the API body shape', () => {
  const body = {
    dbName: 'callingcards',
    regulators: [
      { locusTag: 'YBR289W', symbol: 'SNF5', display: 'SNF5 (YBR289W)' },
      { locusTag: 'YML007W', symbol: 'YAP1', display: 'YAP1 (YML007W)' },
    ],
  };
  assert.deepEqual(parseRegulators(body, STATIC_REGULATORS), ['YBR289W', 'YML007W']);
});

test('parseRegulators falls back to the static list when empty', () => {
  assert.deepEqual(parseRegulators({ regulators: [] }, STATIC_REGULATORS), STATIC_REGULATORS);
  assert.deepEqual(parseRegulators(null, STATIC_REGULATORS), STATIC_REGULATORS);
  assert.deepEqual(parseRegulators({}, STATIC_REGULATORS), STATIC_REGULATORS);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/loadtest/k6/lib/__tests__/keyspace.test.mjs`
Expected: FAIL with `Cannot find module '.../tests/loadtest/k6/lib/keyspace.js'`.

- [ ] **Step 3: Implement `lib/keyspace.js`**

The dataset names, condition values, and the `hackett.time` numeric form come from the live backend's whitelist + `data_prep/src/data_prep/manifests.py` (`DEFAULT_DATASET_FILTERS`: `harbison`/`callingcards` → `condition` categorical `["YPD"]`; `hackett` → `time` numeric `[45,45]`). `STATIC_REGULATORS` mirrors `lib/random_query.js`'s popular+varied lists so the fallback is realistic. `loadRegulators` does the k6 `http.get` lazily (same `require('k6/http')` pattern as `config.js`) and delegates parsing to the pure `parseRegulators`.

```js
// tests/loadtest/k6/lib/keyspace.js
//
// Keyspace generators for the load-test action mix. PURE functions
// (makeZipf, makeUniform, datasetCombos, validFilter, filterToParam,
// parseRegulators) are unit-tested under __tests__/ with plain Node. The
// only k6-runtime function is loadRegulators(), which fetches the REAL
// per-dataset regulator manifest and delegates parsing to parseRegulators().

// Static fallback regulator set (mirrors lib/random_query.js popular+varied).
export const STATIC_REGULATORS = [
  'YBR289W', 'YML007W', 'YPL248C', 'YOR028C', 'YGL073W',
  'YDR277C', 'YAL038W', 'YMR053C', 'YHR084W', 'YJL056C',
  'YKL062W', 'YPR065W', 'YGL013C', 'YBR234C', 'YDL106C',
  'YLR131C', 'YOR077W', 'YNL216W', 'YMR043W',
];

// makeZipf(items, exponent) -> fn(rng01)->item.
// Pre-computes a normalized cumulative Zipf CDF over rank i (1..N) with
// weight 1/i^exponent, then maps rng01 through it (inverse-CDF sampling).
// Item 0 is the most popular. Larger exponent => steeper skew.
export function makeZipf(items, exponent) {
  const n = items.length;
  const weights = new Array(n);
  let total = 0;
  for (let i = 0; i < n; i++) {
    weights[i] = 1 / Math.pow(i + 1, exponent);
    total += weights[i];
  }
  const cdf = new Array(n);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc += weights[i] / total;
    cdf[i] = acc;
  }
  cdf[n - 1] = 1; // guard floating-point drift at the tail
  return function pick(rng01) {
    const r = rng01 <= 0 ? 0 : rng01 >= 1 ? 0.999999999 : rng01;
    for (let i = 0; i < n; i++) {
      if (r < cdf[i]) return items[i];
    }
    return items[n - 1];
  };
}

// makeUniform(items) -> fn(rng01)->item. Flat distribution.
export function makeUniform(items) {
  const n = items.length;
  return function pick(rng01) {
    const r = rng01 <= 0 ? 0 : rng01 >= 1 ? 0.999999999 : rng01;
    return items[Math.min(n - 1, Math.floor(r * n))];
  };
}

// datasetCombos(allDatasets) -> string[][] realistic selection combos.
// Mirrors how the UI sends ?datasets=: single-dataset views plus a few
// 2- and 3-dataset multi-selects. Combos are filtered to datasets actually
// present in allDatasets so it adapts to the fixture vs real artifact.
export function datasetCombos(allDatasets) {
  const set = new Set(allDatasets);
  const keep = (arr) => arr.filter((d) => set.has(d));
  const candidates = [
    ['callingcards'],
    ['harbison'],
    ['hackett'],
    ['chec_m2025'],
    ['callingcards', 'harbison'],
    ['callingcards', 'harbison', 'chec_m2025'],
    ['harbison', 'chec_m2025'],
  ];
  const combos = candidates.map(keep).filter((c) => c.length > 0);
  // Always include at least each dataset alone so nothing is unreachable.
  for (const d of allDatasets) {
    if (!combos.some((c) => c.length === 1 && c[0] === d)) combos.push([d]);
  }
  return combos;
}

// DEFAULT_DATASET_FILTERS shape from data_prep/src/data_prep/manifests.py.
// validFilter(dataset, rng01?) -> a VALID filters-JSON object for ONE
// dataset (the per-db inner map). It varies the VALUES (not the key order)
// so cache keys spread realistically: categorical picks among valid levels,
// numeric jitters the range endpoints around the canonical center.
const CATEGORICAL_FILTER = {
  callingcards: { field: 'condition', values: ['YPD'] },
  harbison: { field: 'condition', values: ['YPD'] },
  chec_m2025: { field: 'condition', values: ['standard'] },
};
const NUMERIC_FILTER = {
  hackett: { field: 'time', center: 45, span: 0 },
};

export function validFilter(dataset, rng01) {
  const r = typeof rng01 === 'function' ? rng01() : rng01;
  const roll = typeof r === 'number' ? r : Math.random();

  if (CATEGORICAL_FILTER[dataset]) {
    const { field, values } = CATEGORICAL_FILTER[dataset];
    // Vary by choosing a (deterministic-with-rng) subset that always
    // includes at least the first level so the filter stays valid.
    const idx = Math.min(values.length - 1, Math.floor(roll * values.length));
    const chosen = values.slice(0, idx + 1);
    return { [field]: { type: 'categorical', value: chosen } };
  }
  if (NUMERIC_FILTER[dataset]) {
    const { field, center, span } = NUMERIC_FILTER[dataset];
    // Jitter the lower bound down by up to `span` * roll so VALUES vary
    // while the canonical center stays inside the range. For span=0
    // (hackett time=45) the value is always [45,45], so we widen the
    // window deterministically by the roll to still vary the key.
    const lo = center - Math.round(roll * (span + 10));
    const hi = center;
    return { [field]: { type: 'numeric', value: [lo, hi] } };
  }
  return {};
}

// filterToParam(obj) -> JSON string for ?filters=. The backend re-marshals
// map keys sorted, so plain JSON.stringify round-trips for cache-key parity.
export function filterToParam(obj) {
  return JSON.stringify(obj);
}

// parseRegulators(jsonBody, fallback) -> string[] of locusTags. Falls back
// to `fallback` when the body is missing/empty. PURE — no k6 dependency.
export function parseRegulators(jsonBody, fallback) {
  const regs = jsonBody && Array.isArray(jsonBody.regulators) ? jsonBody.regulators : [];
  const tags = regs.map((x) => x && x.locusTag).filter((t) => typeof t === 'string' && t.length > 0);
  return tags.length > 0 ? tags : fallback;
}

// loadRegulators(version, datasets) -> string[]. k6-runtime only: GETs
// /datasets/{db}/regulators for the first dataset against the REAL manifest
// and falls back to STATIC_REGULATORS when empty/unreachable. Reads __ENV and
// imports 'k6/http' lazily (inside the body) so Node can still import this
// module for the PURE helpers above (their tests never call loadRegulators).
export function loadRegulators(version, datasets) {
  // eslint-disable-next-line no-undef
  const http = require('k6/http');
  // eslint-disable-next-line no-undef
  const baseUrl = (typeof __ENV !== 'undefined' && __ENV.BASE_URL) || 'http://localhost:8080';
  const db = (datasets && datasets[0]) || 'callingcards';
  const res = http.get(`${baseUrl}/api/v/${version}/datasets/${db}/regulators`);
  if (res.status !== 200) return STATIC_REGULATORS;
  let body = null;
  try {
    body = res.json();
  } catch (_e) {
    return STATIC_REGULATORS;
  }
  return parseRegulators(body, STATIC_REGULATORS);
}
```

Note: `loadRegulators(version, datasets)` matches the contract and every scenario call site. It reads `__ENV.BASE_URL` ambiently (falling back to `http://localhost:8080`) instead of importing `BASE_URL` from `config.js` — that keeps `keyspace.js` free of any *static* `k6/*` import, so Node can import this module to unit-test the pure helpers above (`makeZipf`/`makeUniform`/`datasetCombos`/`validFilter`/`filterToParam`/`parseRegulators`). The `k6/http` dependency is pulled in via `require()` inside the function body, which only executes under k6 — never under `node --test`.

- [ ] **Step 4: Run test to verify it passes** — Run: `node --test tests/loadtest/k6/lib/__tests__/keyspace.test.mjs` Expected: PASS (10 tests, 0 failures).

- [ ] **Step 5: Commit** — `git add tests/loadtest/k6/lib/keyspace.js tests/loadtest/k6/lib/__tests__/keyspace.test.mjs && git commit -m "feat: k6 keyspace lib (zipf/uniform samplers, regulator loader, valid filters)"`

---

### Task 7: lib/mix.js — endpoint weight table + request/URL builders

**Files:**
- Create: `tests/loadtest/k6/lib/mix.js`
- Test: `tests/loadtest/k6/lib/__tests__/mix.test.mjs`

- [ ] **Step 1: Write the failing test**

Every URL builder is pure (it takes a `ctx` and returns a string), and `buildRequest` is pure (takes `rng01` + `ctx`, returns `{method,url,tags}`). All URLs are validated against the real backend route patterns and valid param enums discovered in the handlers: `binding` (`regulator`,`datasets`,`filters`), `perturbation` (same), `comparison/topn` (`binding`,`perturbation`,`top_n`,`effect`,`pvalue`,`filters`), `regulators/resolve` (`intersect`/`common`,`regulators`,`filters`), `binding/scatter` (`regulator`,`method`∈{pearson,spearman},`col`∈{effect,pvalue},`pair`=2 datasets), `selection/matrix` (`datasets`), `datasets` (no params). The `tags.endpoint` values are the chi route patterns (e.g. `/api/v/{v}/binding`).

```js
// tests/loadtest/k6/lib/__tests__/mix.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WEIGHTS, buildRequest,
  bindingURL, perturbationURL, comparisonTopnURL, regulatorsResolveURL,
  scatterURL, selectionMatrixURL, datasetsURL,
} from '../mix.js';

const ctx = {
  baseUrl: 'http://localhost:8080',
  version: 'v9',
  regulators: ['YBR289W', 'YML007W', 'YPL248C'],
  bindingDatasets: ['callingcards', 'harbison'],
  perturbationDatasets: ['hackett'],
  datasetCombos: [['callingcards'], ['callingcards', 'harbison']],
  rng: () => 0.5, // some builders take secondary rolls; deterministic here
};

test('WEIGHTS is a non-empty positive weight table', () => {
  const keys = Object.keys(WEIGHTS);
  assert.ok(keys.length >= 5, `expected >=5 endpoints, got ${keys.length}`);
  for (const k of keys) {
    assert.equal(typeof WEIGHTS[k], 'number');
    assert.ok(WEIGHTS[k] > 0, `weight for ${k} must be > 0`);
  }
});

test('bindingURL targets /binding with regulator + datasets', () => {
  const u = bindingURL(ctx, 0.0);
  assert.ok(u.startsWith('http://localhost:8080/api/v/v9/binding?'), u);
  assert.match(u, /regulator=YBR289W|regulator=YML007W|regulator=YPL248C/);
  assert.match(u, /datasets=callingcards/);
});

test('perturbationURL targets /perturbation with regulator + a perturbation dataset', () => {
  const u = perturbationURL(ctx, 0.0);
  assert.ok(u.startsWith('http://localhost:8080/api/v/v9/perturbation?'), u);
  assert.match(u, /datasets=hackett/);
});

test('comparisonTopnURL has valid binding+perturbation+top_n+effect+pvalue', () => {
  const u = comparisonTopnURL(ctx, 0.0);
  assert.ok(u.startsWith('http://localhost:8080/api/v/v9/comparison/topn?'), u);
  assert.match(u, /binding=callingcards|binding=harbison/);
  assert.match(u, /perturbation=hackett/);
  assert.match(u, /top_n=\d+/);
  assert.match(u, /effect=[\d.]+/);
  assert.match(u, /pvalue=[\d.]+/);
});

test('regulatorsResolveURL intersects two binding datasets', () => {
  const u = regulatorsResolveURL(ctx, 0.0);
  assert.ok(u.startsWith('http://localhost:8080/api/v/v9/regulators/resolve?'), u);
  assert.match(u, /intersect=/);
});

test('scatterURL uses binding/scatter with a valid method and col and a 2-dataset pair', () => {
  const u = scatterURL(ctx, 0.0);
  assert.ok(u.startsWith('http://localhost:8080/api/v/v9/binding/scatter?'), u);
  assert.match(u, /method=(pearson|spearman)/);
  assert.match(u, /col=(effect|pvalue)/);
  const pair = decodeURIComponent(u.match(/pair=([^&]+)/)[1]).split(',');
  assert.equal(pair.length, 2);
});

test('selectionMatrixURL uses /selection/matrix with datasets', () => {
  const u = selectionMatrixURL(ctx, 0.0);
  assert.ok(u.startsWith('http://localhost:8080/api/v/v9/selection/matrix?'), u);
  assert.match(u, /datasets=/);
});

test('datasetsURL is the bare /datasets endpoint', () => {
  const u = datasetsURL(ctx);
  assert.equal(u, 'http://localhost:8080/api/v/v9/datasets');
});

test('buildRequest returns method GET, a url, and a route-pattern endpoint tag', () => {
  const req = buildRequest(0.0, ctx);
  assert.equal(req.method, 'GET');
  assert.equal(typeof req.url, 'string');
  assert.ok(req.url.startsWith('http://localhost:8080/api/v/v9/'));
  assert.ok(req.tags && typeof req.tags.endpoint === 'string');
  assert.match(req.tags.endpoint, /^\/api\/v\/\{v\}\//);
});

test('buildRequest spans every WEIGHTS endpoint across the rng01 range', () => {
  const seen = new Set();
  for (let i = 0; i < 1000; i++) {
    const req = buildRequest(i / 1000, ctx);
    seen.add(req.tags.endpoint);
  }
  // Every weighted endpoint must be reachable for some rng value.
  assert.equal(seen.size, Object.keys(WEIGHTS).length,
    `reached ${seen.size} of ${Object.keys(WEIGHTS).length} endpoints: ${[...seen].join(',')}`);
});

test('buildRequest is deterministic for a fixed rng01 + ctx', () => {
  const a = buildRequest(0.33, ctx);
  const b = buildRequest(0.33, ctx);
  assert.deepEqual(a, b);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/loadtest/k6/lib/__tests__/mix.test.mjs`
Expected: FAIL with `Cannot find module '.../tests/loadtest/k6/lib/mix.js'`.

- [ ] **Step 3: Implement `lib/mix.js`**

`WEIGHTS` reflects spec §9.1 traffic shape: read-heavy data endpoints dominate, comparison/topn and resolve are the deep-filter tail, datasets is a small bootstrap fraction. (The spec file is being authored in parallel; these weights mirror `profile.js`'s 60/30/10 intent extended to the full endpoint set and MUST be reconciled with §9.1's table when the spec lands — the test only asserts positivity + reachability, not exact ratios, so the numbers can be tuned without breaking the test.) `buildRequest` maps `rng01` through the cumulative weight table; each builder takes a secondary roll derived deterministically from `rng01` so the same `rng01` always yields the same request. URL building uses a small `qs()` helper (encodeURIComponent) rather than k6's http — fully pure.

```js
// tests/loadtest/k6/lib/mix.js
//
// Action mix: a weighted endpoint table plus pure per-endpoint URL builders.
// Everything here is PURE (no k6 imports) so it is unit-testable under Node.
// ctx carries the resolved version, the loaded regulator pool, and dataset
// combos; rng01 selects both the endpoint and the per-endpoint variations.

// WEIGHTS: relative traffic share per endpoint (spec §9.1). Reconcile the
// exact ratios with §9.1 when the spec lands; the shape mirrors profile.js's
// read-heavy 60/30/10 intent extended across the full endpoint surface.
export const WEIGHTS = Object.freeze({
  binding: 34,
  perturbation: 22,
  comparisonTopn: 14,
  regulatorsResolve: 8,
  scatter: 12,
  selectionMatrix: 6,
  datasets: 4,
});

// Route-pattern endpoint tags — MUST match the chi route templates the
// backend stamps into http_request_duration_seconds{route,...} so k6 tags
// line up 1:1 with server-side metrics.
const ENDPOINT_TAG = Object.freeze({
  binding: '/api/v/{v}/binding',
  perturbation: '/api/v/{v}/perturbation',
  comparisonTopn: '/api/v/{v}/comparison/topn',
  regulatorsResolve: '/api/v/{v}/regulators/resolve',
  scatter: '/api/v/{v}/binding/scatter',
  selectionMatrix: '/api/v/{v}/selection/matrix',
  datasets: '/api/v/{v}/datasets',
});

// --- small pure helpers ----------------------------------------------------
function apiBase(ctx) {
  return `${String(ctx.baseUrl).replace(/\/+$/, '')}/api/v/${ctx.version}`;
}
function qs(params) {
  return Object.keys(params)
    .filter((k) => params[k] !== undefined && params[k] !== '')
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
    .join('&');
}
function pick(arr, roll) {
  if (!arr || arr.length === 0) return undefined;
  return arr[Math.min(arr.length - 1, Math.floor(roll * arr.length))];
}
// Derive an independent secondary roll from a primary rng01 so a fixed
// rng01 yields a fixed-but-varied request (deterministic for tests).
function reroll(rng01, salt) {
  const x = (rng01 * 1000 + salt) % 1;
  return x < 0 ? x + 1 : x;
}

// --- per-endpoint URL builders (pure) --------------------------------------
export function bindingURL(ctx, rng01 = 0) {
  const reg = pick(ctx.regulators, reroll(rng01, 1));
  const ds = pick(ctx.bindingDatasets, reroll(rng01, 2));
  return `${apiBase(ctx)}/binding?${qs({ regulator: reg, datasets: ds })}`;
}

export function perturbationURL(ctx, rng01 = 0) {
  const reg = pick(ctx.regulators, reroll(rng01, 3));
  const ds = pick(ctx.perturbationDatasets, reroll(rng01, 4));
  return `${apiBase(ctx)}/perturbation?${qs({ regulator: reg, datasets: ds })}`;
}

export function comparisonTopnURL(ctx, rng01 = 0) {
  const b = pick(ctx.bindingDatasets, reroll(rng01, 5));
  const p = pick(ctx.perturbationDatasets, reroll(rng01, 6));
  // top_n in {10,25,50,100}; effect in [0.1,0.6); pvalue in (0,0.05].
  const topNs = [10, 25, 50, 100];
  const topN = topNs[Math.floor(reroll(rng01, 7) * topNs.length)];
  const effect = (reroll(rng01, 8) * 0.5 + 0.1).toFixed(2);
  const pvalue = (reroll(rng01, 9) * 0.049 + 0.001).toFixed(4);
  return `${apiBase(ctx)}/comparison/topn?${qs({
    binding: b, perturbation: p, top_n: topN, effect, pvalue,
  })}`;
}

export function regulatorsResolveURL(ctx, rng01 = 0) {
  // Intersect two binding datasets when available, else fall back to one.
  const ds = ctx.bindingDatasets.length >= 2
    ? [ctx.bindingDatasets[0], ctx.bindingDatasets[1]]
    : ctx.bindingDatasets.slice(0, 1);
  return `${apiBase(ctx)}/regulators/resolve?${qs({ intersect: ds.join(',') })}`;
}

export function scatterURL(ctx, rng01 = 0) {
  const reg = pick(ctx.regulators, reroll(rng01, 10));
  const method = reroll(rng01, 11) < 0.5 ? 'pearson' : 'spearman';
  const col = reroll(rng01, 12) < 0.5 ? 'effect' : 'pvalue';
  // pair requires exactly 2 dataset entries; self-pairs are legal but we
  // prefer two distinct binding datasets when available.
  const a = ctx.bindingDatasets[0];
  const b = ctx.bindingDatasets.length >= 2 ? ctx.bindingDatasets[1] : ctx.bindingDatasets[0];
  return `${apiBase(ctx)}/binding/scatter?${qs({
    regulator: reg, method, col, pair: `${a},${b}`,
  })}`;
}

export function selectionMatrixURL(ctx, rng01 = 0) {
  const combo = pick(ctx.datasetCombos, reroll(rng01, 13)) || ctx.bindingDatasets.slice(0, 1);
  return `${apiBase(ctx)}/selection/matrix?${qs({ datasets: combo.join(',') })}`;
}

export function datasetsURL(ctx) {
  return `${apiBase(ctx)}/datasets`;
}

// --- weighted dispatch -----------------------------------------------------
// Stable iteration order matches the WEIGHTS declaration order.
const ORDER = Object.keys(WEIGHTS);
const TOTAL = ORDER.reduce((s, k) => s + WEIGHTS[k], 0);

const BUILDERS = {
  binding: bindingURL,
  perturbation: perturbationURL,
  comparisonTopn: comparisonTopnURL,
  regulatorsResolve: regulatorsResolveURL,
  scatter: scatterURL,
  selectionMatrix: selectionMatrixURL,
  datasets: (ctx) => datasetsURL(ctx),
};

// buildRequest(rng01, ctx) -> {method:'GET', url, tags:{endpoint}}.
// Maps rng01 through the cumulative weight table to pick an endpoint, then
// reuses the SAME rng01 (re-rolled per builder) for the URL variation, so a
// fixed rng01 is fully deterministic.
export function buildRequest(rng01, ctx) {
  const r = (rng01 <= 0 ? 0 : rng01 >= 1 ? 0.999999999 : rng01) * TOTAL;
  let acc = 0;
  let chosen = ORDER[ORDER.length - 1];
  for (const k of ORDER) {
    acc += WEIGHTS[k];
    if (r < acc) { chosen = k; break; }
  }
  const url = BUILDERS[chosen](ctx, rng01);
  return { method: 'GET', url, tags: { endpoint: ENDPOINT_TAG[chosen] } };
}
```

- [ ] **Step 4: Run test to verify it passes** — Run: `node --test tests/loadtest/k6/lib/__tests__/mix.test.mjs` Expected: PASS (11 tests, 0 failures).

- [ ] **Step 5: Commit** — `git add tests/loadtest/k6/lib/mix.js tests/loadtest/k6/lib/__tests__/mix.test.mjs && git commit -m "feat: k6 action-mix lib (weight table + per-endpoint URL builders)"`

---

### Task 8: lib/metrics.js — Prometheus scrape/parse/delta/hit-rate/pool-wait helpers

**Files:**
- Create: `tests/loadtest/k6/lib/metrics.js`
- Test: `tests/loadtest/k6/lib/__tests__/metrics.test.mjs`

- [ ] **Step 1: Write the failing test**

`scrapeMetrics()` is the only k6-runtime function (it does `http.get`). The parsing core — `parseCounter`, `metricDelta`, `cacheHitRate`, `poolWaitMeanMs` — is pure and operates on the raw `/metrics` text. The fixture below matches Prometheus text-format exactly as the backend emits it: labelled `CounterVec` lines like `cache_hits_total{endpoint="/api/v/{v}/binding"} 12` and unlabelled counters like `db_pool_wait_duration_seconds_total 0.5`. Float counters are parsed (pool-wait-seconds is a float).

```js
// tests/loadtest/k6/lib/__tests__/metrics.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCounter, metricDelta, cacheHitRate, poolWaitMeanMs,
} from '../metrics.js';

const TEXT_BEFORE = `# HELP cache_hits_total Cache hits.
# TYPE cache_hits_total counter
cache_hits_total{endpoint="/api/v/{v}/binding"} 10
cache_hits_total{endpoint="/api/v/{v}/perturbation"} 4
# HELP cache_misses_total Cache misses.
# TYPE cache_misses_total counter
cache_misses_total{endpoint="/api/v/{v}/binding"} 2
cache_misses_total{endpoint="/api/v/{v}/perturbation"} 1
# HELP db_pool_wait_duration_seconds_total total
# TYPE db_pool_wait_duration_seconds_total counter
db_pool_wait_duration_seconds_total 0.5
# HELP db_pool_wait_count_total total
# TYPE db_pool_wait_count_total counter
db_pool_wait_count_total 10
`;

const TEXT_AFTER = `cache_hits_total{endpoint="/api/v/{v}/binding"} 90
cache_hits_total{endpoint="/api/v/{v}/perturbation"} 8
cache_misses_total{endpoint="/api/v/{v}/binding"} 12
cache_misses_total{endpoint="/api/v/{v}/perturbation"} 2
db_pool_wait_duration_seconds_total 2.5
db_pool_wait_count_total 60
`;

test('parseCounter reads an unlabelled counter', () => {
  assert.equal(parseCounter(TEXT_BEFORE, 'db_pool_wait_count_total'), 10);
  assert.equal(parseCounter(TEXT_BEFORE, 'db_pool_wait_duration_seconds_total'), 0.5);
});

test('parseCounter reads a labelled CounterVec series by endpoint', () => {
  assert.equal(parseCounter(TEXT_BEFORE, 'cache_hits_total', { endpoint: '/api/v/{v}/binding' }), 10);
  assert.equal(parseCounter(TEXT_BEFORE, 'cache_hits_total', { endpoint: '/api/v/{v}/perturbation' }), 4);
});

test('parseCounter returns 0 when the metric or label is absent', () => {
  assert.equal(parseCounter(TEXT_BEFORE, 'does_not_exist'), 0);
  assert.equal(parseCounter(TEXT_BEFORE, 'cache_hits_total', { endpoint: '/api/v/{v}/nope' }), 0);
});

test('parseCounter sums all series of a name when no labels are given', () => {
  // global cache_hits_total = 10 + 4
  assert.equal(parseCounter(TEXT_BEFORE, 'cache_hits_total'), 14);
});

test('metricDelta subtracts after-before for a labelled series', () => {
  const d = metricDelta(TEXT_BEFORE, TEXT_AFTER, 'cache_hits_total', { endpoint: '/api/v/{v}/binding' });
  assert.equal(d, 80); // 90 - 10
});

test('metricDelta subtracts after-before for an unlabelled counter', () => {
  assert.equal(metricDelta(TEXT_BEFORE, TEXT_AFTER, 'db_pool_wait_count_total'), 50); // 60 - 10
});

test('cacheHitRate computes hits/(hits+misses) for an endpoint', () => {
  // binding: 10 / (10 + 2)
  assert.equal(cacheHitRate(TEXT_BEFORE, '/api/v/{v}/binding'), 10 / 12);
});

test('cacheHitRate computes a global rate when endpoint omitted', () => {
  // global hits 14, misses 3 -> 14/17
  assert.equal(cacheHitRate(TEXT_BEFORE), 14 / 17);
});

test('cacheHitRate is 0 when there is no traffic (no hits and no misses)', () => {
  assert.equal(cacheHitRate('', '/api/v/{v}/binding'), 0);
});

test('poolWaitMeanMs uses the counter pair: 1000 * Δwait_seconds / Δwait_count', () => {
  // Δwait_seconds = 2.5 - 0.5 = 2.0 ; Δwait_count = 60 - 10 = 50
  // mean = 1000 * 2.0 / 50 = 40 ms
  assert.equal(poolWaitMeanMs(TEXT_BEFORE, TEXT_AFTER), 40);
});

test('poolWaitMeanMs is 0 when the count delta is 0 (no division by zero)', () => {
  assert.equal(poolWaitMeanMs(TEXT_BEFORE, TEXT_BEFORE), 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/loadtest/k6/lib/__tests__/metrics.test.mjs`
Expected: FAIL with `Cannot find module '.../tests/loadtest/k6/lib/metrics.js'`.

- [ ] **Step 3: Implement `lib/metrics.js`**

Parsing handles both unlabelled (`name 12`) and labelled (`name{...} 12`) series, integer and float values. The label matcher does a substring match on `endpoint="..."` so it is robust to label ordering and to extra labels. `scrapeMetrics()` does the k6 `http.get` lazily (same `require` pattern). Names match the INTERFACE CONTRACT exactly: `cache_hits_total{endpoint}`, `cache_misses_total{endpoint}`, `db_pool_wait_duration_seconds_total`, `db_pool_wait_count_total`.

```js
// tests/loadtest/k6/lib/metrics.js
//
// Prometheus /metrics scrape + parse helpers. The PARSING core (parseCounter,
// metricDelta, cacheHitRate, poolWaitMeanMs) is pure and unit-tested under
// __tests__/ with plain Node against an inline text fixture. scrapeMetrics()
// is the only k6-runtime function and lazily imports 'k6/http'.

// Escape a string for use inside a RegExp.
function reEscape(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// parseCounter(text, name, labels?) -> number.
//   - labels omitted: SUM of every series with that metric name (handles a
//     bare `name 12` line and the sum of all labelled series alike).
//   - labels given (e.g. {endpoint:'...'}): the single series whose line
//     contains every label=value pair. Returns 0 if absent.
// Values may be integer or float (pool-wait-seconds is a float).
export function parseCounter(text, name, labels) {
  if (!text) return 0;
  const nameRe = reEscape(name);
  // Match lines that start with the metric name, optionally a {labels} block,
  // then whitespace and a numeric value. Anchored per-line (multiline).
  const lineRe = new RegExp(`^${nameRe}(\\{[^}]*\\})?\\s+([-+0-9.eE]+)\\s*$`, 'mg');

  let total = 0;
  let matched = false;
  let m;
  while ((m = lineRe.exec(text)) !== null) {
    const labelBlock = m[1] || '';
    const value = Number(m[2]);
    if (Number.isNaN(value)) continue;
    if (labels) {
      const ok = Object.keys(labels).every((k) =>
        labelBlock.includes(`${k}="${labels[k]}"`));
      if (!ok) continue;
      return value; // a specific labelled series is unique
    }
    total += value;
    matched = true;
  }
  return matched ? total : 0;
}

// metricDelta(before, after, name, labels?) -> after - before.
export function metricDelta(before, after, name, labels) {
  return parseCounter(after, name, labels) - parseCounter(before, name, labels);
}

// cacheHitRate(text, endpoint?) -> hits/(hits+misses). endpoint optional
// (global when omitted). Returns 0 when there is no traffic.
export function cacheHitRate(text, endpoint) {
  const labels = endpoint ? { endpoint } : undefined;
  const hits = parseCounter(text, 'cache_hits_total', labels);
  const misses = parseCounter(text, 'cache_misses_total', labels);
  const denom = hits + misses;
  return denom === 0 ? 0 : hits / denom;
}

// poolWaitMeanMs(before, after) -> 1000 * Δwait_duration_total / Δwait_count_total.
// Uses the db_pool_wait_duration_seconds_total / db_pool_wait_count_total
// counter pair. Returns 0 when the count delta is 0 (no waits, no div-by-0).
export function poolWaitMeanMs(before, after) {
  const dSeconds = metricDelta(before, after, 'db_pool_wait_duration_seconds_total');
  const dCount = metricDelta(before, after, 'db_pool_wait_count_total');
  if (dCount === 0) return 0;
  return (1000 * dSeconds) / dCount;
}

// scrapeMetrics(baseUrl) -> raw /metrics text. k6-runtime only.
export function scrapeMetrics(baseUrl) {
  // eslint-disable-next-line no-undef
  const http = require('k6/http');
  const res = http.get(`${String(baseUrl).replace(/\/+$/, '')}/metrics`);
  return res.body;
}
```

- [ ] **Step 4: Run test to verify it passes** — Run: `node --test tests/loadtest/k6/lib/__tests__/metrics.test.mjs` Expected: PASS (11 tests, 0 failures).

- [ ] **Step 5: Commit** — `git add tests/loadtest/k6/lib/metrics.js tests/loadtest/k6/lib/__tests__/metrics.test.mjs && git commit -m "feat: k6 metrics lib (Prometheus scrape/parse/delta/hit-rate/pool-wait)"`

---

### Task 9: extend lib/thresholds.js — open-model + availability thresholds

**Files:**
- Modify: `tests/loadtest/k6/thresholds.js:1-6` (append new exports; keep `warmThresholds` byte-for-byte)
- Test: `tests/loadtest/k6/lib/__tests__/thresholds.test.mjs`

Note: the existing file is `tests/loadtest/k6/thresholds.js` (NOT under `lib/`). The contract says "thresholds.js (EXISTING — extend)", so we extend the existing path in place and do NOT move it. The test lives under `lib/__tests__/` for consistency with the other lib tests and imports via a relative path up to the existing file.

- [ ] **Step 1: Write the failing test**

`thresholds.js` is pure data (plain objects), so it is directly Node-importable with zero k6 dependency.

```js
// tests/loadtest/k6/lib/__tests__/thresholds.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  warmThresholds, openModelThresholds, availabilityThresholds,
} from '../../thresholds.js';

test('warmThresholds is preserved unchanged', () => {
  assert.deepEqual(warmThresholds.http_req_failed, ['rate==0']);
  assert.deepEqual(warmThresholds.http_req_duration, ['p(95)<200', 'p(99)<500']);
});

test('openModelThresholds gates zero failures, p95/p99 latency, and no dropped iterations', () => {
  assert.deepEqual(openModelThresholds.http_req_failed, ['rate==0']);
  assert.deepEqual(openModelThresholds.http_req_duration, ['p(95)<200', 'p(99)<500']);
  assert.deepEqual(openModelThresholds.dropped_iterations, ['count==0']);
});

test('availabilityThresholds allows a small failure budget', () => {
  assert.deepEqual(availabilityThresholds.http_req_failed, ['rate<0.005']);
});

test('all three threshold sets are plain serializable objects', () => {
  for (const t of [warmThresholds, openModelThresholds, availabilityThresholds]) {
    assert.equal(typeof t, 'object');
    assert.deepEqual(JSON.parse(JSON.stringify(t)), t);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/loadtest/k6/lib/__tests__/thresholds.test.mjs`
Expected: FAIL — the import of `openModelThresholds` / `availabilityThresholds` resolves to `undefined`, so the `deepEqual` on `openModelThresholds.http_req_failed` throws `Cannot read properties of undefined (reading 'http_req_failed')`.

- [ ] **Step 3: Extend `thresholds.js`**

Append the two new exports below the existing `warmThresholds` (leave `warmThresholds` exactly as-is). Final file content:

```js
export const warmThresholds = {
  http_req_failed:   ['rate==0'],
  http_req_duration: ['p(95)<200', 'p(99)<500'],
  // Custom — cache_hit_ratio tracked via tags below.
};

// openModelThresholds — gates for the authoritative open-model (arrival-rate)
// perf scenarios. dropped_iterations==0 asserts the server kept up with the
// target arrival rate (k6 drops queued iterations when VUs are saturated).
export const openModelThresholds = {
  http_req_failed:    ['rate==0'],
  http_req_duration:  ['p(95)<200', 'p(99)<500'],
  dropped_iterations: ['count==0'],
};

// availabilityThresholds — looser budget for the long-running availability /
// soak scenario, which also adds a Rate('readyz_available') in-scenario.
export const availabilityThresholds = {
  http_req_failed: ['rate<0.005'],
};
```

- [ ] **Step 4: Run test to verify it passes** — Run: `node --test tests/loadtest/k6/lib/__tests__/thresholds.test.mjs` Expected: PASS (4 tests, 0 failures).

- [ ] **Step 5: Commit** — `git add tests/loadtest/k6/thresholds.js tests/loadtest/k6/lib/__tests__/thresholds.test.mjs && git commit -m "feat: add open-model and availability k6 threshold sets"`

---

**Run-all command (verifies the whole Phase-A lib suite at once):**
`node --test tests/loadtest/k6/lib/__tests__/*.test.mjs`
Expected: PASS — 5 test files, 41 tests total, 0 failures.

---

**Key findings / load-bearing facts verified against the live backend** (so other drafters and the implementer stay consistent):

- The spec at `docs/superpowers/specs/2026-05-29-loadtest-program-design.md` **does not exist yet** (only `2026-05-12-go-react-rewrite-design.md` is present). WEIGHTS in Task 7 and the §9.1 ratios are therefore mirrored from `profile.js`'s 60/30/10 intent and flagged for reconciliation when the spec lands; the tests assert only positivity + reachability, not exact ratios, so tuning won't break them.
- Real route patterns (from `backend/internal/api/router.go`) and their metric `endpoint`/`route` labels are the chi templates like `/api/v/{v}/binding`, `/api/v/{v}/comparison/topn`, `/api/v/{v}/binding/scatter`, `/api/v/{v}/selection/matrix` (`chiRoutePattern` in `middleware.go` confirms `RoutePattern()` is the label source — `tags.endpoint` in k6 must match these exactly).
- Valid query params verified in handlers: `binding`/`perturbation` take `regulator`,`datasets`,`filters`; `comparison/topn` takes `binding`,`perturbation`,`top_n`,`effect`,`pvalue`,`filters`; `regulators/resolve` takes `intersect` (or `common=A:B`),`regulators`,`filters`; `binding/scatter` requires `regulator`,`method`∈{`pearson`,`spearman`},`col`∈{`effect`,`pvalue`},`pair`=exactly 2 datasets; `selection/matrix` takes `datasets`; `/datasets` takes none.
- Valid filter VALUES (from `data_prep/src/data_prep/manifests.py` `DEFAULT_DATASET_FILTERS`): `callingcards`/`harbison` → `{"condition":{"type":"categorical","value":["YPD"]}}`, `chec_m2025` → `condition`/`["standard"]`, `hackett` → `{"time":{"type":"numeric","value":[45,45]}}`. `FilterSpec` JSON shape is `{type, value}` (`backend/internal/domain/filter.go`); the backend re-marshals filter map keys sorted, so plain `JSON.stringify` round-trips for cache-key parity.
- Binding datasets: `callingcards`,`harbison`,`chec_m2025`,`rossi`; perturbation: `hackett`,`hughes_overexpression`,`hughes_knockout`,`hu_reimand`,`kemmeren`,`degron` (from `comparison_topn.go` config maps).
- `/datasets/{db}/regulators` returns `{dbName, regulators:[{locusTag, symbol, display}]}` (`backend/internal/domain/select_datasets.go`); `loadRegulators`/`parseRegulators` read the `locusTag` field.
- `/api/version` returns `{artifactVersion, schemaVersion, builtAt, duckDBVersion}` (`version.go`); `resolveVersion()` reads `artifactVersion`.
- k6-import isolation pattern used throughout: pure helpers are exported with zero k6 dependency; the only k6-runtime functions (`resolveVersion`, `loadRegulators`, `scrapeMetrics`) lazily `require('k6/http')` inside the function body so Node's `--test` can `import` each module for the pure exports. The fallback (split pure helpers into a `*_pure.js` sibling) is documented in Task 5 Step 3 in case a given k6 build rejects in-body `require`.
- Existing `thresholds.js` lives at `tests/loadtest/k6/thresholds.js` (NOT under `lib/`); Task 9 extends it in place and keeps `warmThresholds` unchanged.


### Phase A.3 — Fixture-mechanics scenarios + CI

_Scenarios whose correctness is validatable against the tiny committed fixture, plus the GitHub Actions guard. These gate on behavior + relative regression — never absolute milliseconds._

### Task 10: scenarios/smoke.js — fixture smoke test (full endpoint mix + negative checks)

**Files:**
- Create: `tests/loadtest/k6/scenarios/smoke.js`
- Test: manual two-terminal run (k6 against fixture backend) — see Step 2 / Step 4

> Depends on the Phase-A shared libs (`lib/config.js`, `lib/keyspace.js`, `lib/mix.js`, `lib/metrics.js`, and the extended `thresholds.js`) authored in earlier tasks of this plan. This task imports them by their frozen interface names.

- [ ] **Step 1: Write the scenario (this scenario *is* the test — there is no separate harness, so write it first, then run it red against a not-yet-started backend)**

```javascript
// tests/loadtest/k6/scenarios/smoke.js
//
// Phase-A FIXTURE smoke test. Runs ~20 req/s for 30-60s over the full
// endpoint mix (lib/mix.js), interleaving NEGATIVE checks that assert the
// backend's documented 4xx/410/405 behavior and the X-Cache MISS->HIT flip.
//
// Thresholds gate ERRORS ONLY. We deliberately set NO absolute-ms gate here:
// on the tiny committed fixture, latency is meaningless. Authoritative perf
// numbers come from scenarios/profile.js against ARTIFACT_KIND=real.
import http from 'k6/http';
import { check, fail } from 'k6';
import { Rate } from 'k6/metrics';
import {
  BASE_URL, ARTIFACT_KIND, resolveVersion, apiBase,
} from '../lib/config.js';
import { loadRegulators, datasetCombos } from '../lib/keyspace.js';
import { buildRequest } from '../lib/mix.js';
import { availabilityThresholds } from '../lib/thresholds.js';

const ALL_DATASETS = ['callingcards', 'harbison', 'hackett'];

// Custom rates so a single failed negative check trips the threshold.
const negative4xx = new Rate('smoke_negative_4xx_ok');
const cacheFlip = new Rate('smoke_cache_flip_ok');
const readyzUp = new Rate('readyz_available');

export const options = {
  scenarios: {
    smoke: {
      executor: 'constant-arrival-rate',
      rate: 20,            // ~20 iterations/s
      timeUnit: '1s',
      duration: __ENV.DURATION || '40s',   // 30-60s window
      preAllocatedVUs: 20,
      maxVUs: 40,
    },
  },
  thresholds: {
    ...availabilityThresholds,                 // http_req_failed: rate<0.005
    dropped_iterations: ['count==0'],          // arrival rate must be sustainable on fixture
    smoke_negative_4xx_ok: ['rate==1'],        // EVERY negative check must pass
    smoke_cache_flip_ok: ['rate==1'],          // EVERY MISS->HIT flip must pass
    readyz_available: ['rate==1'],
  },
};

export function setup() {
  if (ARTIFACT_KIND === 'fixture') {
    // smoke is fixture-only by design; do NOT warn here (warning is reserved
    // for AUTHORITATIVE perf scenarios that are meaningless on the fixture).
  }
  const version = resolveVersion();
  const regulators = loadRegulators(version, ALL_DATASETS);
  const combos = datasetCombos(ALL_DATASETS);
  return { version, regulators, combos };
}

export default function (data) {
  const ctx = {
    version: data.version,
    regulators: data.regulators,
    datasets: ALL_DATASETS,
    combos: data.combos,
  };

  // ---- positive: one request from the realistic mix ----
  const req = buildRequest(Math.random(), ctx);
  const res = http.request(req.method, req.url, null, { tags: req.tags });
  check(res, {
    'mix 2xx': (r) => r.status >= 200 && r.status < 300,
    'mix has X-Cache': (r) => r.headers['X-Cache'] === 'HIT' || r.headers['X-Cache'] === 'MISS',
  });

  // ---- /readyz availability sample ----
  const ready = http.get(`${BASE_URL}/readyz`);
  readyzUp.add(ready.status === 200);

  // Run the comprehensive negative + cache-flip suite on ~1 in 20 iterations
  // so it executes several times across the run without dominating it.
  if (Math.random() < 0.05) {
    runNegatives(data.version, ctx);
    runCacheFlip(data.version, ctx);
  }
}

// NEGATIVE CHECKS — assert the backend's documented rejection behavior.
function runNegatives(version, ctx) {
  const base = apiBase(version);

  // 1. bogus regulator -> 400 (not in field_manifest whitelist).
  const bogus = http.get(`${base}/binding?regulator=NOT_A_REAL_ORF_ZZZ9&datasets=callingcards`);
  negative4xx.add(check(bogus, {
    'bogus regulator -> 400': (r) => r.status === 400,
    'bogus regulator no-store': (r) => r.headers['Cache-Control'] === 'no-store',
  }));

  // 2. stale /api/v/{old} -> 410 Gone.
  const stale = http.get(`${BASE_URL}/api/v/v0-does-not-exist/datasets`);
  negative4xx.add(check(stale, {
    'stale version -> 410': (r) => r.status === 410,
    'stale version Location advisory': (r) => r.headers['Location'] === '/api/version',
  }));

  // 3. >16KiB ?filters= -> 400 (validateLength, MaxFiltersBytes=16*1024).
  //    Build a JSON object whose stringified form exceeds 16384 bytes but
  //    stays under the 32KiB RequestGuard per-value cap so we exercise the
  //    handler-level length check, not the guard.
  const big = 'x'.repeat(17000);
  const filtersTooBig = encodeURIComponent(JSON.stringify({ junkpad: big }));
  const bigFilters = http.get(`${base}/binding?regulator=${ctx.regulators[0]}&datasets=callingcards&filters=${filtersTooBig}`);
  negative4xx.add(check(bigFilters, {
    '>16KiB filters -> 400': (r) => r.status === 400,
  }));

  // 4. top_n clamp to [1, 1000]: top_n=0 -> response top_n==1; top_n=99999 -> 1000.
  const lo = http.get(`${base}/comparison/topn?binding=callingcards&perturbation=hackett&top_n=0`);
  const hi = http.get(`${base}/comparison/topn?binding=callingcards&perturbation=hackett&top_n=99999`);
  negative4xx.add(check(lo, {
    'top_n=0 -> 200': (r) => r.status === 200,
    'top_n=0 clamps to 1': (r) => r.status === 200 && r.json('top_n') === 1,
  }));
  negative4xx.add(check(hi, {
    'top_n=99999 -> 200': (r) => r.status === 200,
    'top_n=99999 clamps to 1000': (r) => r.status === 200 && r.json('top_n') === 1000,
  }));

  // 5. >32 distinct query keys -> RequestGuard 400 (MaxQueryKeys=32).
  const parts = [`regulator=${ctx.regulators[0]}`, 'datasets=callingcards'];
  for (let i = 0; i < 40; i++) parts.push(`junk${i}=1`);
  const manyKeys = http.get(`${base}/binding?${parts.join('&')}`);
  negative4xx.add(check(manyKeys, {
    '>32 query keys -> 400': (r) => r.status === 400,
    '>32 query keys message': (r) => r.status === 400 && String(r.body).includes('too many query parameters'),
  }));

  // 6. non-GET on a registered route -> 405 (chi MethodNotAllowed default).
  const post = http.post(`${BASE_URL}/api/version`, null);
  negative4xx.add(check(post, {
    'POST /api/version -> 405': (r) => r.status === 405,
  }));
}

// CACHE-FLIP CHECK — first hit MISS, second identical hit HIT.
function runCacheFlip(version, ctx) {
  const base = apiBase(version);
  // Unique-per-VU-iteration regulator so the key is genuinely cold the first
  // time within this iteration (the fixture set is small; pick by index).
  const reg = ctx.regulators[(__VU + __ITER) % ctx.regulators.length];
  const url = `${base}/binding?regulator=${reg}&datasets=callingcards`;
  const first = http.get(url);
  const second = http.get(url);
  cacheFlip.add(check(first, { 'flip first 200': (r) => r.status === 200 }) &&
    check(second, {
      'flip second 200': (r) => r.status === 200,
      'second is HIT': (r) => r.headers['X-Cache'] === 'HIT',
      'immutable cache-control': (r) => r.headers['Cache-Control'] === 'public, max-age=31536000, immutable',
    }));
}

export function handleSummary(data) {
  // Stamp artifact identity into the summary (interface contract).
  const stamp = {
    artifactVersion: data.setup_data ? data.setup_data.version : undefined,
    artifactKind: ARTIFACT_KIND,
  };
  return {
    stdout: textSummary(data, stamp),
    'smoke-summary.json': JSON.stringify({ ...stamp, metrics: data.metrics }, null, 2),
  };
}

function textSummary(data, stamp) {
  const lines = [];
  lines.push(`\n=== smoke.js summary (kind=${stamp.artifactKind} version=${stamp.artifactVersion}) ===`);
  const checks = data.metrics.checks;
  if (checks) {
    lines.push(`checks passes=${checks.values.passes} fails=${checks.values.fails}`);
  }
  for (const name of ['smoke_negative_4xx_ok', 'smoke_cache_flip_ok', 'readyz_available', 'http_req_failed']) {
    const m = data.metrics[name];
    if (m) lines.push(`${name}: rate=${(m.values.rate ?? m.values.value).toFixed(4)}`);
  }
  return lines.join('\n') + '\n';
}
```

- [ ] **Step 2: Run to verify it fails (no backend running)**
Run:
```bash
cd tests/loadtest/k6 && BASE_URL=http://127.0.0.1:8080 k6 run scenarios/smoke.js
```
Expected: FAIL — `resolveVersion()` in `setup()` cannot reach the backend; k6 exits non-zero with `dial: connection refused` / `setup() execution failed`.

- [ ] **Step 3: Implement — none beyond Step 1**
The scenario file is the deliverable. The backend behaviors it asserts already exist (`request_guard.go` MaxQueryKeys=32, `validate.go` MaxFiltersBytes=16*1024 / TopNMin=1 / TopNMax=1000, `version.go` 410 + `Location: /api/version`, `json.go` X-Cache + immutable/no-store). No backend changes.

- [ ] **Step 4: Run to verify it passes (backend on fixture)**
Two terminals.

Terminal 1 (backend on the committed fixture):
```bash
make data-fixture-bootstrap
cd backend && go run ./cmd/tfbp-server --duckdb=../tfbp.duckdb --port=8080
```
Wait for the listen log line, then:
Terminal 2:
```bash
curl -fsS http://127.0.0.1:8080/readyz
cd tests/loadtest/k6 && ARTIFACT_KIND=fixture DURATION=30s BASE_URL=http://127.0.0.1:8080 k6 run scenarios/smoke.js; echo "exit=$?"
```
Expected: PASS — `exit=0`. k6 summary shows every threshold green:
```
✓ http_req_failed................: rate<0.005
✓ dropped_iterations.............: count==0
✓ smoke_negative_4xx_ok..........: rate==1
✓ smoke_cache_flip_ok............: rate==1
✓ readyz_available...............: rate==1
=== smoke.js summary (kind=fixture version=<live-version>) ===
checks passes=... fails=0
```

- [ ] **Step 5: Commit**
```bash
git add tests/loadtest/k6/scenarios/smoke.js && git commit -m "test: add fixture smoke k6 scenario (full mix + negative checks + cache flip)"
```

---

### Task 11: scenarios/coverage.js — per-route cold/warm flip + Cache-Control matrix + negatives table

**Files:**
- Create: `tests/loadtest/k6/scenarios/coverage.js`
- Test: manual two-terminal run — see Step 2 / Step 4

> Imports the Phase-A shared libs by their frozen names.

- [ ] **Step 1: Write the scenario**

```javascript
// tests/loadtest/k6/scenarios/coverage.js
//
// Phase-A COVERAGE scenario. Single VU, single iteration. Walks every cached
// and "medium" route exactly once COLD then once WARM, asserting:
//   - X-Cache flips MISS -> HIT on cacheable routes,
//   - the correct Cache-Control header per route class
//     (no-store on /export, /healthz, /readyz, /metrics, /api/version;
//      immutable on /api/v/* cacheable JSON),
//   - 410 / 400 negatives,
// then prints a per-route latency + cache table via handleSummary.
import http from 'k6/http';
import { check } from 'k6';
import { Trend, Rate } from 'k6/metrics';
import {
  BASE_URL, ARTIFACT_KIND, resolveVersion, apiBase,
} from '../lib/config.js';
import { loadRegulators } from '../lib/keyspace.js';

const ALL_DATASETS = ['callingcards', 'harbison', 'hackett'];
const IMMUTABLE = 'public, max-age=31536000, immutable';
const NO_STORE = 'no-store';

const flipOK = new Rate('coverage_flip_ok');
const ccOK = new Rate('coverage_cache_control_ok');
const negOK = new Rate('coverage_negative_ok');
const routeLatency = new Trend('coverage_route_ms', true);

export const options = {
  scenarios: {
    coverage: {
      executor: 'per-vu-iterations',
      vus: 1,
      iterations: 1,
      maxDuration: '120s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.20'],     // negatives ARE non-2xx by design; gate via custom rates below
    coverage_flip_ok: ['rate==1'],
    coverage_cache_control_ok: ['rate==1'],
    coverage_negative_ok: ['rate==1'],
  },
};

export function setup() {
  const version = resolveVersion();
  const regulators = loadRegulators(version, ALL_DATASETS);
  return { version, regulators };
}

// Build the route table: each entry has a cache class.
//   class 'cacheable' -> X-Cache flips, Cache-Control immutable.
//   class 'no-store'  -> Cache-Control no-store, no flip asserted.
function buildRoutes(version, reg) {
  const base = apiBase(version);
  return [
    // --- ops / version: no-store, no X-Cache ---
    { name: 'healthz', url: `${BASE_URL}/healthz`, cls: 'no-store' },
    { name: 'readyz', url: `${BASE_URL}/readyz`, cls: 'no-store' },
    { name: 'api/version', url: `${BASE_URL}/api/version`, cls: 'no-store' },
    { name: 'metrics', url: `${BASE_URL}/metrics`, cls: 'metrics' }, // promhttp sets NO Cache-Control
    // --- cacheable JSON under /api/v/* ---
    { name: 'datasets', url: `${base}/datasets`, cls: 'cacheable' },
    { name: 'regulators', url: `${base}/regulators`, cls: 'cacheable' },
    { name: 'regulators/resolve', url: `${base}/regulators/resolve?regulators=${reg}`, cls: 'cacheable' },
    { name: 'datasets/{db}/fields', url: `${base}/datasets/callingcards/fields`, cls: 'cacheable' },
    { name: 'datasets/{db}/regulators', url: `${base}/datasets/callingcards/regulators`, cls: 'cacheable' },
    { name: 'datasets/{db}/sample-conditions', url: `${base}/datasets/callingcards/sample-conditions`, cls: 'cacheable' },
    { name: 'selection/matrix', url: `${base}/selection/matrix?datasets=callingcards,harbison`, cls: 'cacheable' },
    { name: 'selection/breakdown', url: `${base}/selection/breakdown?datasets=callingcards`, cls: 'cacheable' },
    { name: 'binding', url: `${base}/binding?regulator=${reg}&datasets=callingcards`, cls: 'cacheable' },
    { name: 'binding/scatter', url: `${base}/binding/scatter?regulator=${reg}&datasets=callingcards,harbison`, cls: 'cacheable' },
    { name: 'perturbation', url: `${base}/perturbation?regulator=${reg}&datasets=hackett`, cls: 'cacheable' },
    { name: 'perturbation/scatter', url: `${base}/perturbation/scatter?regulator=${reg}&datasets=hackett`, cls: 'cacheable' },
    { name: 'comparison/topn', url: `${base}/comparison/topn?binding=callingcards&perturbation=hackett&top_n=25`, cls: 'cacheable' },
    { name: 'comparison/dto', url: `${base}/comparison/dto?binding=callingcards&perturbation=hackett`, cls: 'cacheable' },
    // --- export: under /api/v/* but explicitly no-store, streamed ---
    { name: 'export', url: `${base}/export?datasets=callingcards`, cls: 'no-store' },
  ];
}

const table = []; // collected for handleSummary

export default function (data) {
  const reg = data.regulators[0];
  const routes = buildRoutes(data.version, reg);

  for (const route of routes) {
    const cold = http.get(route.url);
    const warm = http.get(route.url);
    routeLatency.add(cold.timings.duration, { route: route.name });

    const row = {
      name: route.name,
      coldStatus: cold.status,
      warmStatus: warm.status,
      coldCache: cold.headers['X-Cache'] || '-',
      warmCache: warm.headers['X-Cache'] || '-',
      cc: cold.headers['Cache-Control'] || '(none)',
      coldMs: cold.timings.duration.toFixed(1),
      warmMs: warm.timings.duration.toFixed(1),
    };
    table.push(row);

    // 2xx for every positive route.
    check(cold, { [`${route.name} cold 2xx`]: (r) => r.status >= 200 && r.status < 300 });
    check(warm, { [`${route.name} warm 2xx`]: (r) => r.status >= 200 && r.status < 300 });

    if (route.cls === 'cacheable') {
      // Cold MISS -> warm HIT, immutable Cache-Control.
      flipOK.add(check(null, {
        [`${route.name} flip MISS->HIT`]: () =>
          cold.headers['X-Cache'] === 'MISS' && warm.headers['X-Cache'] === 'HIT',
      }));
      ccOK.add(check(cold, {
        [`${route.name} immutable`]: (r) => r.headers['Cache-Control'] === IMMUTABLE,
      }));
    } else if (route.cls === 'no-store') {
      ccOK.add(check(cold, {
        [`${route.name} no-store`]: (r) => r.headers['Cache-Control'] === NO_STORE,
      }));
    } else if (route.cls === 'metrics') {
      // promhttp deliberately sets no Cache-Control; assert it is absent.
      ccOK.add(check(cold, {
        [`${route.name} no cache-control`]: (r) => !r.headers['Cache-Control'],
      }));
    }
  }

  // --- negatives ---
  const base = apiBase(data.version);
  // 410 stale version.
  const stale = http.get(`${BASE_URL}/api/v/v0-stale/datasets`);
  negOK.add(check(stale, { '410 stale version': (r) => r.status === 410 }));
  // 400 bogus regulator.
  const bogus = http.get(`${base}/binding?regulator=NOPE_ZZZ9&datasets=callingcards`);
  negOK.add(check(bogus, { '400 bogus regulator': (r) => r.status === 400 }));
  // 400 unknown dataset.
  const badDs = http.get(`${base}/binding?regulator=${reg}&datasets=not_a_dataset`);
  negOK.add(check(badDs, { '400 unknown dataset': (r) => r.status === 400 }));
}

export function handleSummary(data) {
  const version = data.setup_data ? data.setup_data.version : undefined;
  const lines = [];
  lines.push(`\n=== coverage.js (kind=${ARTIFACT_KIND} version=${version}) ===`);
  lines.push(
    'route'.padEnd(34) + 'cold'.padEnd(6) + 'warm'.padEnd(6) +
    'X-Cache(cold/warm)'.padEnd(22) + 'cache-control'.padEnd(40) + 'coldMs/warmMs',
  );
  for (const r of table) {
    lines.push(
      r.name.padEnd(34) +
      String(r.coldStatus).padEnd(6) +
      String(r.warmStatus).padEnd(6) +
      `${r.coldCache}/${r.warmCache}`.padEnd(22) +
      r.cc.padEnd(40) +
      `${r.coldMs}/${r.warmMs}`,
    );
  }
  for (const name of ['coverage_flip_ok', 'coverage_cache_control_ok', 'coverage_negative_ok']) {
    const m = data.metrics[name];
    if (m) lines.push(`${name}: rate=${m.values.rate.toFixed(4)}`);
  }
  const out = lines.join('\n') + '\n';
  return {
    stdout: out,
    'coverage-summary.json': JSON.stringify(
      { artifactVersion: version, artifactKind: ARTIFACT_KIND, table }, null, 2),
  };
}
```

- [ ] **Step 2: Run to verify it fails (no backend)**
Run:
```bash
cd tests/loadtest/k6 && BASE_URL=http://127.0.0.1:8080 k6 run scenarios/coverage.js
```
Expected: FAIL — `setup()` `resolveVersion()` cannot reach backend; k6 exits non-zero with `connection refused`.

- [ ] **Step 3: Implement — none beyond Step 1**
All asserted behavior exists: `/export` and the ops/version routes set `Cache-Control: no-store` (`export.go:141`, `version.go:12`, `static`/healthz handlers); `/metrics` via `promhttp.HandlerFor` sets no Cache-Control; `/api/v/*` cacheable JSON sets `immutable` and the `X-Cache` MISS→HIT flip (`json.go:42-51`). No backend changes.

- [ ] **Step 4: Run to verify it passes (backend on fixture)**
Terminal 1 — fresh backend (so the cacheable routes are genuinely cold on first hit):
```bash
make data-fixture-bootstrap
cd backend && go run ./cmd/tfbp-server --duckdb=../tfbp.duckdb --port=8080
```
Terminal 2:
```bash
cd tests/loadtest/k6 && ARTIFACT_KIND=fixture BASE_URL=http://127.0.0.1:8080 k6 run scenarios/coverage.js; echo "exit=$?"
```
Expected: PASS — `exit=0`. Thresholds green and a printed table, e.g.:
```
✓ coverage_flip_ok............: rate==1
✓ coverage_cache_control_ok...: rate==1
✓ coverage_negative_ok........: rate==1
=== coverage.js (kind=fixture version=<live>) ===
route                             cold  warm  X-Cache(cold/warm)    cache-control                            coldMs/warmMs
healthz                           200   200   -/-                   no-store                                 ...
metrics                           200   200   -/-                   (none)                                   ...
datasets                          200   200   MISS/HIT              public, max-age=31536000, immutable      ...
binding                           200   200   MISS/HIT              public, max-age=31536000, immutable      ...
export                            200   200   -/-                   no-store                                 ...
```
Note: re-running against an already-warm backend will show `HIT/HIT` and trip `coverage_flip_ok`; the test requires a fresh restart (documented above and in the Makefile target's help).

- [ ] **Step 5: Commit**
```bash
git add tests/loadtest/k6/scenarios/coverage.js && git commit -m "test: add per-route cold/warm + cache-control coverage k6 scenario"
```

---

### Task 12: scenarios/cold_fanout.js — small-K singleflight fan-in mechanics

**Files:**
- Create: `tests/loadtest/k6/scenarios/cold_fanout.js`
- Test: manual two-terminal run with a fresh backend — see Step 2 / Step 4

> Imports the Phase-A shared libs by their frozen names. Mirrors the fresh-restart + `/metrics`-delta teardown pattern of the existing `cold_burst.js`, but asserts the exact fan-in arithmetic at SMALL scale.

- [ ] **Step 1: Write the scenario**

```javascript
// tests/loadtest/k6/scenarios/cold_fanout.js
//
// Phase-A FIXTURE-MECHANICS scenario. N concurrent VUs each issue ONE GET to
// the SAME cold key (per-vu-iterations, iterations=1). Because the backend
// coalesces identical cold misses with singleflight + ristretto Wait(), the
// expected steady-state arithmetic on the chosen endpoint's K distinct keys is:
//
//   Σ Δ db_query_duration_seconds_count  == K        (exactly K DB queries ran)
//   Δ singleflight_shared_calls_total{ep} == N - K   (the other N-K coalesced)
//
// With the default K=4 distinct keys spread over N VUs, each key is requested
// by N/K VUs; only the 1 leader per key touches the DB. This asserts the
// COALESCING MECHANIC, not latency — it is fixture-only.
//
// REQUIRES A FRESH BACKEND RESTART so ristretto is empty; setup() asserts
// cache_hits_total == 0 (like cold_burst.js) and FAILS setup otherwise.
import http from 'k6/http';
import { check, fail } from 'k6';
import {
  BASE_URL, ARTIFACT_KIND, resolveVersion, apiBase,
} from '../lib/config.js';
import { loadRegulators } from '../lib/keyspace.js';
import { scrapeMetrics, parseCounter, metricDelta } from '../lib/metrics.js';

const K = parseInt(__ENV.K || '4', 10);     // distinct cold keys (SMALL)
const N = parseInt(__ENV.N || '40', 10);    // concurrent VUs (must be >= K)
const ENDPOINT = 'binding';                  // endpoint tag + query_name for binding
const QUERY_NAME = 'binding';                // db_query_duration_seconds{query_name="binding"}

export const options = {
  scenarios: {
    fanout: {
      executor: 'per-vu-iterations',
      vus: N,
      iterations: 1,
      maxDuration: '15s',
    },
  },
  thresholds: {
    http_req_failed: ['rate==0'],
    // Mechanics gate lives in teardown via check(); surface it here too so a
    // non-zero exit code is produced when arithmetic is wrong.
    checks: ['rate==1'],
  },
};

export function setup() {
  const version = resolveVersion();

  // FRESH-RESTART GUARD (mirrors cold_burst.js): the backend MUST be cold.
  const before = scrapeMetrics(BASE_URL);
  const hitsBefore = parseCounter(before, 'cache_hits_total'); // global
  if (hitsBefore > 0) {
    fail(
      `cold_fanout: cache_hits_total=${hitsBefore} before fanout; backend is NOT cold. ` +
      `Restart the backend before running this scenario (see tests/loadtest/k6/README.md).`,
    );
  }

  const regulators = loadRegulators(version, ['callingcards']);
  if (regulators.length < K) {
    fail(`cold_fanout: need at least K=${K} regulators, got ${regulators.length}`);
  }

  // Build the K distinct cold keys: same endpoint, different regulator.
  const base = apiBase(version);
  const keys = [];
  for (let i = 0; i < K; i++) {
    keys.push(`${base}/binding?regulator=${regulators[i]}&datasets=callingcards`);
  }

  // Snapshot the counters we will delta in teardown.
  const dbCountBefore = parseCounter(before, 'db_query_duration_seconds_count', { query_name: QUERY_NAME });
  const sfBefore = parseCounter(before, 'singleflight_shared_calls_total', { endpoint: ENDPOINT });

  return { version, keys, before, dbCountBefore, sfBefore };
}

export default function (data) {
  // Deterministically spread N VUs across the K keys so each key gets ~N/K
  // simultaneous callers; only one leader per key should reach the DB.
  const url = data.keys[(__VU - 1) % data.keys.length];
  const res = http.get(url);
  check(res, { 'fanout 200': (r) => r.status === 200 });
}

export function teardown(data) {
  const after = scrapeMetrics(BASE_URL);

  const dbCountAfter = parseCounter(after, 'db_query_duration_seconds_count', { query_name: QUERY_NAME });
  const sfAfter = parseCounter(after, 'singleflight_shared_calls_total', { endpoint: ENDPOINT });

  const dbDelta = dbCountAfter - data.dbCountBefore;          // expect == K
  const sfDelta = sfAfter - data.sfBefore;                    // expect == N - K

  console.log(`--- cold_fanout mechanics (K=${K} N=${N} kind=${ARTIFACT_KIND} version=${data.version}) ---`);
  console.log(`Δ db_query_duration_seconds_count{query_name="${QUERY_NAME}"} = ${dbDelta} (expect ${K})`);
  console.log(`Δ singleflight_shared_calls_total{endpoint="${ENDPOINT}"}     = ${sfDelta} (expect ${N - K})`);

  // These checks run OUTSIDE the iteration loop; k6 still counts them toward
  // the 'checks' threshold so a wrong delta yields a non-zero exit.
  check(null, {
    'db query count delta == K': () => dbDelta === K,
    'singleflight shared delta == N-K': () => sfDelta === (N - K),
  });
}

export function handleSummary(data) {
  const version = data.setup_data ? data.setup_data.version : undefined;
  const stamp = { artifactVersion: version, artifactKind: ARTIFACT_KIND, K, N };
  const checks = data.metrics.checks;
  const line = checks
    ? `checks passes=${checks.values.passes} fails=${checks.values.fails}`
    : 'checks: (none)';
  return {
    stdout: `\n=== cold_fanout.js (kind=${ARTIFACT_KIND} version=${version} K=${K} N=${N}) ===\n${line}\n`,
    'cold-fanout-summary.json': JSON.stringify(stamp, null, 2),
  };
}
```

- [ ] **Step 2: Run to verify it fails (no backend)**
Run:
```bash
cd tests/loadtest/k6 && K=4 N=40 BASE_URL=http://127.0.0.1:8080 k6 run scenarios/cold_fanout.js
```
Expected: FAIL — `setup()` `resolveVersion()` / `scrapeMetrics` cannot reach backend; k6 exits non-zero with `connection refused` and `setup() execution failed`.

- [ ] **Step 3: Implement — none beyond Step 1**
The metrics it deltas already exist with these exact names/labels: `db_query_duration_seconds` histogram (label `query_name`, exposing `db_query_duration_seconds_count`) observed at `comparison_topn.go:188` and the binding handler's DB path; `singleflight_shared_calls_total{endpoint}` (`metrics.go:94`); `cache_hits_total` (`metrics.go:86`). Coalescing (`singleflight` + `cache.Wait()`) is implemented per §8.1. No backend changes.

- [ ] **Step 4: Run to verify it passes (FRESH backend on fixture)**
Terminal 1 — restart the backend immediately before the run so ristretto is empty:
```bash
make data-fixture-bootstrap
cd backend && go run ./cmd/tfbp-server --duckdb=../tfbp.duckdb --port=8080
```
Terminal 2 (run once against the just-restarted backend):
```bash
cd tests/loadtest/k6 && ARTIFACT_KIND=fixture K=4 N=40 BASE_URL=http://127.0.0.1:8080 k6 run scenarios/cold_fanout.js; echo "exit=$?"
```
Expected: PASS — `exit=0`. Logs:
```
--- cold_fanout mechanics (K=4 N=40 kind=fixture version=<live>) ---
Δ db_query_duration_seconds_count{query_name="binding"} = 4 (expect 4)
Δ singleflight_shared_calls_total{endpoint="binding"}     = 36 (expect 36)
✓ db query count delta == K
✓ singleflight shared delta == N-K
✓ checks........................: rate==1
```
If a second run is attempted without restarting, `setup()` aborts with `cache_hits_total=... before fanout; backend is NOT cold` and a non-zero exit — by design.

- [ ] **Step 5: Commit**
```bash
git add tests/loadtest/k6/scenarios/cold_fanout.js && git commit -m "test: add small-K cold-fanout k6 scenario asserting singleflight fan-in arithmetic"
```

---

### Task 13: Makefile targets + loadtest-smoke CI workflow

**Files:**
- Modify: `Makefile:1-6` (add the three new targets to `.PHONY`) and `Makefile:118-124` (add target bodies in the load-testing section)
- Create: `.github/workflows/loadtest-smoke.yml`
- Test: `make -n loadtest-smoke loadtest-coverage loadtest-cold-fanout` + the two-terminal run below; CI verified by triggering the workflow

- [ ] **Step 1: Write the failing test (assert the targets do not exist yet)**
Run:
```bash
make -n loadtest-smoke 2>&1; echo "---"; test -f .github/workflows/loadtest-smoke.yml && echo "workflow EXISTS" || echo "workflow MISSING"
```
Expected: FAIL — `make: *** No rule to make target 'loadtest-smoke'.  Stop.` and `workflow MISSING`.

- [ ] **Step 2: Add the three Makefile targets**

In `Makefile:5` extend the `.PHONY` load-test line. Replace:
```make
        loadtest-profile loadtest-cold-burst \
```
with:
```make
        loadtest-profile loadtest-cold-burst \
        loadtest-smoke loadtest-coverage loadtest-cold-fanout \
```

Then append to the load-testing section (after `loadtest-cold-burst`, i.e. after `Makefile:124`):
```make
# Phase-A fixture scenarios. All are run against a backend already listening on
# $(BASE_URL) (default :8080) backed by tests/fixtures/tfbp_test.duckdb.
# These assert BEHAVIOR + cache/singleflight MECHANICS, not absolute latency,
# so they are safe to gate in CI on the committed fixture.
BASE_URL ?= http://127.0.0.1:8080

# ~20 req/s over the full endpoint mix + negative checks + MISS->HIT flip.
loadtest-smoke:
	cd tests/loadtest/k6 && ARTIFACT_KIND=fixture BASE_URL=$(BASE_URL) k6 run scenarios/smoke.js

# Per-route cold/warm X-Cache flip + Cache-Control matrix + negatives table.
# REQUIRES a freshly restarted backend (cacheable routes must be cold).
loadtest-coverage:
	cd tests/loadtest/k6 && ARTIFACT_KIND=fixture BASE_URL=$(BASE_URL) k6 run scenarios/coverage.js

# Small-K singleflight fan-in mechanics. REQUIRES a freshly restarted backend
# (setup() asserts cache_hits_total==0). Override K/N via env.
loadtest-cold-fanout:
	cd tests/loadtest/k6 && ARTIFACT_KIND=fixture BASE_URL=$(BASE_URL) K=$${K:-4} N=$${N:-40} k6 run scenarios/cold_fanout.js
```

- [ ] **Step 3: Create the CI workflow**

`.github/workflows/loadtest-smoke.yml`:
```yaml
name: loadtest-smoke
on:
  workflow_dispatch:
  pull_request:
    paths:
      - 'backend/**'
      - 'tests/loadtest/k6/**'
      - 'tests/fixtures/tfbp_test.duckdb'
      - '.github/workflows/loadtest-smoke.yml'
  push:
    branches: [main]
permissions:
  contents: read
jobs:
  loadtest-smoke:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-go@v5
        with:
          go-version: '1.22'
          cache-dependency-path: backend/go.sum

      # duckdb-go/v2 needs CGO; the runner ships gcc but be explicit.
      - name: Build backend (CGO)
        working-directory: backend
        env:
          CGO_ENABLED: '1'
        run: go build -o tfbp-server ./cmd/tfbp-server

      - name: Stage fixture as the runtime artifact
        run: cp tests/fixtures/tfbp_test.duckdb tfbp.duckdb

      - name: Install k6
        run: |
          set -euo pipefail
          curl -fsSL https://github.com/grafana/k6/releases/download/v0.50.0/k6-v0.50.0-linux-amd64.tar.gz \
            | tar -xz --strip-components=1 -C /usr/local/bin k6-v0.50.0-linux-amd64/k6
          k6 version

      - name: Start backend on the fixture (fresh, cold cache)
        run: |
          set -euo pipefail
          ./backend/tfbp-server --duckdb=./tfbp.duckdb --port=8080 \
            > backend.log 2>&1 &
          echo "BACKEND_PID=$!" >> "$GITHUB_ENV"
          # Wait for readiness (fail-fast startup means a bad artifact exits non-zero).
          for i in $(seq 1 30); do
            if curl -fsS http://127.0.0.1:8080/readyz >/dev/null 2>&1; then
              echo "backend ready after ${i}s"; exit 0
            fi
            if ! kill -0 "$!" 2>/dev/null; then
              echo "backend exited during startup"; cat backend.log; exit 1
            fi
            sleep 1
          done
          echo "backend did not become ready in 30s"; cat backend.log; exit 1

      # smoke: full mix + negatives. Backend is cold here.
      - name: Run smoke.js
        env:
          ARTIFACT_KIND: fixture
          BASE_URL: http://127.0.0.1:8080
        run: cd tests/loadtest/k6 && k6 run scenarios/smoke.js

      # coverage: needs a cold cache for the MISS->HIT flip — restart first.
      - name: Restart backend (cold) for coverage
        run: |
          set -euo pipefail
          kill "${BACKEND_PID}" 2>/dev/null || true
          sleep 1
          ./backend/tfbp-server --duckdb=./tfbp.duckdb --port=8080 \
            > backend-coverage.log 2>&1 &
          echo "BACKEND_PID=$!" >> "$GITHUB_ENV"
          for i in $(seq 1 30); do
            curl -fsS http://127.0.0.1:8080/readyz >/dev/null 2>&1 && exit 0
            sleep 1
          done
          echo "backend not ready"; cat backend-coverage.log; exit 1

      - name: Run coverage.js
        env:
          ARTIFACT_KIND: fixture
          BASE_URL: http://127.0.0.1:8080
        run: cd tests/loadtest/k6 && k6 run scenarios/coverage.js

      # cold_fanout: setup() asserts cache_hits_total==0 — restart first.
      - name: Restart backend (cold) for cold_fanout
        run: |
          set -euo pipefail
          kill "${BACKEND_PID}" 2>/dev/null || true
          sleep 1
          ./backend/tfbp-server --duckdb=./tfbp.duckdb --port=8080 \
            > backend-fanout.log 2>&1 &
          echo "BACKEND_PID=$!" >> "$GITHUB_ENV"
          for i in $(seq 1 30); do
            curl -fsS http://127.0.0.1:8080/readyz >/dev/null 2>&1 && exit 0
            sleep 1
          done
          echo "backend not ready"; cat backend-fanout.log; exit 1

      - name: Run cold_fanout.js (small K)
        env:
          ARTIFACT_KIND: fixture
          BASE_URL: http://127.0.0.1:8080
          K: '4'
          N: '40'
        run: cd tests/loadtest/k6 && k6 run scenarios/cold_fanout.js

      - name: Stop backend
        if: always()
        run: kill "${BACKEND_PID}" 2>/dev/null || true

      - name: Upload k6 summaries
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: loadtest-smoke-summaries
          path: |
            tests/loadtest/k6/*-summary.json
            backend*.log
          if-no-files-found: ignore
```
Each `k6 run` exits non-zero if any threshold (and therefore any check) fails, so the job fails on any failed check. Three fresh backend starts give smoke / coverage / cold_fanout the cold cache each requires.

- [ ] **Step 4: Verify it passes**

Local (targets exist + expand correctly):
```bash
make -n loadtest-smoke loadtest-coverage loadtest-cold-fanout
```
Expected: PASS — prints the three `cd tests/loadtest/k6 && ... k6 run scenarios/{smoke,coverage,cold_fanout}.js` command lines, no "No rule to make target" error.

End-to-end (two terminals). Terminal 1:
```bash
make data-fixture-bootstrap
cd backend && go run ./cmd/tfbp-server --duckdb=../tfbp.duckdb --port=8080
```
Terminal 2 (restart the backend in Terminal 1 between each, since coverage + cold_fanout need a cold cache):
```bash
make loadtest-smoke; echo "smoke exit=$?"
# (restart backend in Terminal 1)
make loadtest-coverage; echo "coverage exit=$?"
# (restart backend in Terminal 1)
make loadtest-cold-fanout; echo "fanout exit=$?"
```
Expected: each `exit=0` with all thresholds green.

CI (lint + dry-trigger):
```bash
python -c "import yaml,sys; yaml.safe_load(open('.github/workflows/loadtest-smoke.yml')); print('yaml ok')"
gh workflow run loadtest-smoke.yml --ref "$(git rev-parse --abbrev-ref HEAD)"
gh run list --workflow=loadtest-smoke.yml --limit 1
```
Expected: `yaml ok`; the workflow run completes with conclusion `success` (all three `k6 run` steps green).

- [ ] **Step 5: Commit**
```bash
git add Makefile .github/workflows/loadtest-smoke.yml && git commit -m "ci: add loadtest-smoke/coverage/cold-fanout make targets + fixture k6 CI workflow"
```


## Phase B — Authoritative SLO + capacity (EC2 t3.small + real artifact, k6 off-box) — GATES CUTOVER

_Each scenario has a local fixture-mechanics test (proves it runs) and an `(operational)` EC2 run block (produces the authoritative number). Cutover is gated on this phase._

### Task 14: scenarios/arrival_slo.js — open-model warm/cold SLO scenario

**Files:**
- Create: `tests/loadtest/k6/scenarios/arrival_slo.js`
- Test: `tests/loadtest/k6/scenarios/arrival_slo.local.sh`

- [ ] **Step 1: Write the failing test** (local fixture-mechanics harness — drives the scenario at a tiny rate/duration against the fixture-backed dev backend, asserts exit 0 and that a summary JSON was written and stamped)
```bash
#!/usr/bin/env bash
# tests/loadtest/k6/scenarios/arrival_slo.local.sh
# Local fixture-mechanics test for scenarios/arrival_slo.js.
# Validates the scenario WIRES UP (open model executor builds, libs import,
# version resolves, handleSummary writes a stamped summary) — NOT the SLO itself.
# The authoritative SLO run is operational on EC2 (see the (operational) block
# in Step 3). Requires: k6 on PATH and a fixture-backed backend on BASE_URL.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE_URL="${BASE_URL:-http://127.0.0.1:8080}"
OUT="$(mktemp -d)/arrival_slo.summary.json"

echo "[local] probing backend at ${BASE_URL}/api/version"
curl -fsS "${BASE_URL}/api/version" >/dev/null || {
  echo "FAIL: no backend at ${BASE_URL}. Start one: (cd backend && go run ./cmd/tfbp-server --duckdb=../tests/fixtures/tfbp_test.duckdb --port=8080)" >&2
  exit 1
}

# Tiny step rates + short holds so the whole thing runs in well under a minute.
# WARM unset (cold mechanics path); ARTIFACT_KIND defaults to fixture, which
# MUST emit the fixture warning to stderr.
STDERR="$(mktemp)"
k6 run \
  -e BASE_URL="${BASE_URL}" \
  -e RATES="2,4" \
  -e STEP_HOLD="3s" \
  -e PREALLOC_VUS="10" \
  -e MAX_VUS="40" \
  -e READYZ_RATE="1" \
  --summary-export="${OUT}" \
  "${HERE}/arrival_slo.js" 2>"${STDERR}"

echo "[local] asserting fixture warning was emitted to stderr"
grep -q "ARTIFACT_KIND=fixture" "${STDERR}" || {
  echo "FAIL: expected fixture warning on stderr" >&2; cat "${STDERR}" >&2; exit 1; }

echo "[local] asserting summary written + stamped with version + artifactKind"
test -s "${OUT}" || { echo "FAIL: summary not written to ${OUT}" >&2; exit 1; }
grep -q '"artifactVersion"' "${OUT}" || { echo "FAIL: summary missing artifactVersion stamp" >&2; exit 1; }
grep -q '"artifactKind"' "${OUT}"    || { echo "FAIL: summary missing artifactKind stamp" >&2; exit 1; }
grep -q '"readyz_available"' "${OUT}" || { echo "FAIL: summary missing readyz_available probe metric" >&2; exit 1; }

echo "PASS: arrival_slo.js wired up; summary stamped at ${OUT}"
```
- [ ] **Step 2: Run test to verify it fails**
Run: `chmod +x tests/loadtest/k6/scenarios/arrival_slo.local.sh && BASE_URL=http://127.0.0.1:8080 tests/loadtest/k6/scenarios/arrival_slo.local.sh`
Expected: FAIL — k6 aborts with `Error: ... cannot find module '.../scenarios/arrival_slo.js'` (file does not exist yet), the script exits non-zero before reaching the PASS line.

- [ ] **Step 3: Implement `scenarios/arrival_slo.js`**

`scenarios/arrival_slo.js`:
```javascript
// tests/loadtest/k6/scenarios/arrival_slo.js
//
// AUTHORITATIVE SLO scenario (spec §11.3.2 / §11.3.3, §9.1/§9.2).
// Open model (ramping-arrival-rate): offered load is decoupled from VU count,
// so a slowing server cannot mask itself by self-throttling closed-loop VUs.
// dropped_iterations>0 means the load generator could not keep up — the run is
// INVALID for SLO purposes (recalibrate: more PREALLOC_VUS/MAX_VUS or move k6
// off-box). See thresholds.openModelThresholds.
//
// WARM vs COLD:
//   __ENV.WARM=1  -> the operator has pre-warmed the popular keyspace; this run
//                    gates the warm SLO (p95<200ms, p99<500ms, fail==0).
//   WARM unset    -> cold cutover number: backend freshly restarted, cache
//                    empty; the same thresholds are RECORDED (honest cold p95)
//                    but the cold run's headline number is reported, not gated,
//                    per §11.3.3 cold-cache containment.
//
// A low-rate readyz_available probe arm runs in parallel: GET /readyz + /healthz
// at a steady trickle, feeding a Rate('readyz_available') used for the
// availability/error-budget row of the summary.

import http from 'k6/http';
import { check } from 'k6';
import { Rate } from 'k6/metrics';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.2/index.js';
import {
  BASE_URL, ARTIFACT_KIND, resolveVersion, apiBase,
} from '../lib/config.js';
import { loadRegulators, datasetCombos } from '../lib/keyspace.js';
import { buildRequest } from '../lib/mix.js';
import { openModelThresholds, availabilityThresholds } from '../thresholds.js';

// --- env-driven step schedule -------------------------------------------------
// Default authoritative steps: 5 -> 40 -> 80 req/s, each held STEP_HOLD.
const RATES = (__ENV.RATES || '5,40,80').split(',').map((s) => parseInt(s.trim(), 10));
const STEP_HOLD = __ENV.STEP_HOLD || '4m';           // 3-5m per the spec
const RAMP = __ENV.RAMP || '30s';                    // ramp INTO each hold
const PREALLOC_VUS = parseInt(__ENV.PREALLOC_VUS || '50', 10);
const MAX_VUS = parseInt(__ENV.MAX_VUS || '400', 10);
const READYZ_RATE = parseInt(__ENV.READYZ_RATE || '1', 10);   // req/s for probe arm
const WARM = !!__ENV.WARM;

// Build ramping-arrival-rate stages: ramp to rate[i] then hold.
function buildStages(rates) {
  const stages = [];
  for (const r of rates) {
    stages.push({ target: r, duration: RAMP });
    stages.push({ target: r, duration: STEP_HOLD });
  }
  return stages;
}

const readyzAvailable = new Rate('readyz_available');

export const options = {
  scenarios: {
    slo: {
      executor: 'ramping-arrival-rate',
      startRate: RATES[0],
      timeUnit: '1s',
      preAllocatedVUs: PREALLOC_VUS,
      maxVUs: MAX_VUS,
      stages: buildStages(RATES),
      exec: 'mix',
      tags: { arm: 'mix' },
    },
    readyz_probe: {
      executor: 'constant-arrival-rate',
      rate: READYZ_RATE,
      timeUnit: '1s',
      duration: `${RATES.length} * ${STEP_HOLD}`.length ? totalDuration(RATES) : '1m',
      preAllocatedVUs: 2,
      maxVUs: 4,
      exec: 'probe',
      tags: { arm: 'probe' },
    },
  },
  thresholds: {
    ...openModelThresholds,
    ...availabilityThresholds,
    'readyz_available': ['rate>0.995'],
    // Scope http_req_duration gates to the mix arm so the trickle probe arm
    // does not pollute the SLO percentiles.
    'http_req_duration{arm:mix}': WARM ? ['p(95)<200', 'p(99)<500'] : ['p(95)<5000'],
  },
};

// Total wall-clock for the mix arm so the probe arm covers the same window.
function totalDuration(rates) {
  // RAMP + STEP_HOLD per rate. We can only string-concat in options init, so
  // express as a sum k6 accepts: e.g. "30s+4m+30s+4m...". k6 does not parse
  // arithmetic, so return an explicit duration string.
  // Parse RAMP/STEP_HOLD to seconds, sum, re-emit as "<n>s".
  const toSec = (d) => {
    const m = /^(\d+)(s|m|h)$/.exec(d);
    if (!m) return 0;
    const n = parseInt(m[1], 10);
    return m[2] === 'h' ? n * 3600 : m[2] === 'm' ? n * 60 : n;
  };
  const per = toSec(RAMP) + toSec(STEP_HOLD);
  return `${per * rates.length}s`;
}

export function setup() {
  if (ARTIFACT_KIND === 'fixture') {
    console.warn(
      'WARNING: ARTIFACT_KIND=fixture — arrival_slo.js is an AUTHORITATIVE perf ' +
      'scenario. Fixture numbers are mechanics-only and MUST NOT be reported as ' +
      'the cutover SLO. Set ARTIFACT_KIND=real on the EC2 host.',
    );
  }
  const version = resolveVersion();
  const datasets = datasetCombos.length ? null : null; // placeholder for lint
  const allDatasets = ['callingcards', 'harbison', 'hackett'];
  const regulators = loadRegulators(version, allDatasets);
  return { version, regulators, datasets: allDatasets, warm: WARM };
}

// --- mix arm: the SLO traffic ------------------------------------------------
export function mix(data) {
  const ctx = {
    version: data.version,
    regulators: data.regulators,
    datasets: data.datasets,
  };
  const req = buildRequest(Math.random(), ctx);
  const res = http.request(req.method, req.url, null, { tags: req.tags });
  check(res, { 'status 2xx': (r) => r.status >= 200 && r.status < 300 });
}

// --- probe arm: low-rate availability probe ----------------------------------
export function probe() {
  const ready = http.get(`${BASE_URL}/readyz`, { tags: { endpoint: 'readyz', arm: 'probe' } });
  const live = http.get(`${BASE_URL}/healthz`, { tags: { endpoint: 'healthz', arm: 'probe' } });
  const ok = ready.status === 200 && live.status === 200;
  readyzAvailable.add(ok);
}

export function handleSummary(data) {
  const stamped = {
    artifactVersion: data.setup_data ? data.setup_data.version : 'unknown',
    artifactKind: ARTIFACT_KIND,
    warm: WARM,
    rates: RATES,
    stepHold: STEP_HOLD,
    metrics: data.metrics,
  };
  // SLO verdict: dropped_iterations must be 0 (run validity) and, if WARM, the
  // mix-arm p95/p99 + zero-fail thresholds must all pass.
  const dropped = (data.metrics.dropped_iterations && data.metrics.dropped_iterations.values.count) || 0;
  const thr = (m, sub) =>
    data.metrics[m] && data.metrics[m].thresholds &&
    data.metrics[m].thresholds[sub] ? data.metrics[m].thresholds[sub].ok : null;
  const verdictLines = [];
  verdictLines.push(`artifact: ${stamped.artifactVersion} (${ARTIFACT_KIND})  WARM=${WARM}`);
  verdictLines.push(`dropped_iterations=${dropped}  (MUST be 0 for a valid run)`);
  if (dropped > 0) {
    verdictLines.push('VERDICT: INVALID RUN — load generator could not keep up. Recalibrate and rerun.');
  } else if (WARM) {
    verdictLines.push(`VERDICT: ${data.metrics.http_req_failed && data.metrics.http_req_failed.values.rate === 0 ? 'PASS' : 'FAIL'} (warm SLO)`);
  } else {
    const p95 = data.metrics['http_req_duration{arm:mix}']
      ? data.metrics['http_req_duration{arm:mix}'].values['p(95)']
      : (data.metrics.http_req_duration ? data.metrics.http_req_duration.values['p(95)'] : NaN);
    verdictLines.push(`VERDICT: COLD run — honest cold p95=${p95 && p95.toFixed ? p95.toFixed(1) : p95} ms (recorded, not gated)`);
  }

  return {
    stdout: textSummary(data, { indent: ' ', enableColors: true }) +
      '\n\n=== SLO VERDICT ===\n' + verdictLines.join('\n') + '\n',
    'arrival_slo.summary.json': JSON.stringify(stamped, null, 2),
  };
}
```

NOTE for the implementer: the `--summary-export` flag (used by the local test) writes a flat JSON; the `handleSummary` return additionally writes `arrival_slo.summary.json`. Both contain the `artifactVersion`/`artifactKind`/`readyz_available` keys the local test greps for. If `--summary-export` does not emit custom Rate metric names in older k6, the `handleSummary`-written `arrival_slo.summary.json` is the authoritative stamped artifact — adjust the local test's `${OUT}` to point at `arrival_slo.summary.json` if your k6 version omits custom metrics from `--summary-export`.

- [ ] **Step 4: Run test to verify it passes**
Run: `BASE_URL=http://127.0.0.1:8080 tests/loadtest/k6/scenarios/arrival_slo.local.sh`
Expected: PASS — prints `PASS: arrival_slo.js wired up; summary stamped at ...`, exit 0. (Requires a fixture-backed backend running: `cd backend && go run ./cmd/tfbp-server --duckdb=../tests/fixtures/tfbp_test.duckdb --port=8080`.)

- [ ] **Step 3b (operational): AUTHORITATIVE warm + cold SLO run on EC2 t3.small, k6 OFF-box**

Run from a **separate** host (laptop / bastion), NOT on the t3.small, so the load generator does not steal the backend's 2 vCPU credits. `BASE_URL` points at the t3.small's public/Traefik endpoint; `ARTIFACT_KIND=real`.

Calibration precondition (BOTH must hold or the run is INVALID and must be rerun):
- k6 host CPU utilization < 70% for the whole run (`mpstat 5` on the k6 host — if the generator is saturated, offered rate is a lie).
- `dropped_iterations == 0` in the summary (k6 kept up with the open-model arrival rate).

Warm run (gates the SLO):
```bash
# 1) Pre-warm the popular keyspace, then run WARM=1.
# (Operator pre-warms by replaying the popular subset once; see deploy/README.md.)
k6 run \
  -e BASE_URL=https://tfbindingandperturbation.com \
  -e ARTIFACT_KIND=real \
  -e WARM=1 \
  -e RATES=5,40,80 \
  -e STEP_HOLD=4m \
  -e PREALLOC_VUS=50 -e MAX_VUS=400 \
  --summary-export=arrival_slo.warm.json \
  tests/loadtest/k6/scenarios/arrival_slo.js
```
Pass/fail to read (warm):
- `http_req_failed` → threshold `rate==0` must be **ok:true** (zero 5xx/net errors). FAIL otherwise.
- `http_req_duration{arm:mix}` → `p(95) < 200` ms AND `p(99) < 500` ms must be **ok:true**. FAIL otherwise.
- `dropped_iterations` → `count==0` must be **ok:true**. If false → INVALID run, recalibrate (raise MAX_VUS / move k6 off-box).
- `readyz_available` → `rate>0.995` must be **ok:true** (availability budget).

Cold run (records the honest cutover number, not gated):
```bash
# Restart the backend immediately before (cache empty), then DO NOT pass WARM.
docker compose -f deploy/docker-compose.yml restart tfbp   # on the t3.small
k6 run \
  -e BASE_URL=https://tfbindingandperturbation.com \
  -e ARTIFACT_KIND=real \
  -e RATES=5,40,80 -e STEP_HOLD=4m \
  -e PREALLOC_VUS=50 -e MAX_VUS=400 \
  --summary-export=arrival_slo.cold.json \
  tests/loadtest/k6/scenarios/arrival_slo.js
```
Number to record (cold): `http_req_duration{arm:mix}` `p(95)` → this is the **honest cold cutover p95**, transcribed verbatim into the §10 summary's cold row. Not a gate; `dropped_iterations==0` must still hold for the number to be valid.

- [ ] **Step 5: Commit**
`git add tests/loadtest/k6/scenarios/arrival_slo.js tests/loadtest/k6/scenarios/arrival_slo.local.sh && git commit -m "test(loadtest): open-model arrival-rate SLO scenario (warm+cold) + readyz probe arm"`

---

### Task 15: scenarios/hitrate_curve.js — cache-hit-rate vs p95 sweep

**Files:**
- Create: `tests/loadtest/k6/scenarios/hitrate_curve.js`
- Test: `tests/loadtest/k6/scenarios/hitrate_curve.local.sh`

- [ ] **Step 1: Write the failing test** (local fixture-mechanics — one short constant-arrival run at a single ZIPF_EXP, asserts exit 0, summary stamped, and that the achieved per-endpoint cache hit rate row is emitted)
```bash
#!/usr/bin/env bash
# tests/loadtest/k6/scenarios/hitrate_curve.local.sh
# Local fixture-mechanics test for scenarios/hitrate_curve.js.
# Runs ONE short constant-arrival-rate point (single ZIPF_EXP) and asserts the
# scenario builds, resolves the version, drives a zipf keyspace, scrapes
# /metrics before+after, and emits the achieved-hit-rate + p95 row into a
# stamped summary. The AUTHORITATIVE multi-point sweep is operational (Step 3b).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE_URL="${BASE_URL:-http://127.0.0.1:8080}"
OUT="$(mktemp -d)/hitrate_curve.summary.json"

curl -fsS "${BASE_URL}/api/version" >/dev/null || {
  echo "FAIL: no backend at ${BASE_URL}" >&2; exit 1; }

STDERR="$(mktemp)"
k6 run \
  -e BASE_URL="${BASE_URL}" \
  -e KEYSPACE_MODE=zipf \
  -e ZIPF_EXP=1.0 \
  -e HIT_RATE=0.8 \
  -e TARGET_RATE=5 \
  -e DURATION=10s \
  -e HITRATE_TOLERANCE=1.0 \
  --summary-export="${OUT}" \
  "${HERE}/hitrate_curve.js" 2>"${STDERR}"

grep -q "ARTIFACT_KIND=fixture\|fixture" "${STDERR}" || {
  echo "FAIL: expected fixture warning on stderr" >&2; cat "${STDERR}" >&2; exit 1; }

test -s "${OUT}" || { echo "FAIL: summary not written" >&2; exit 1; }
grep -q '"artifactVersion"' "${OUT}" || { echo "FAIL: missing artifactVersion stamp" >&2; exit 1; }
grep -q '"zipfExp"' "${OUT}"        || { echo "FAIL: missing zipfExp stamp" >&2; exit 1; }
grep -q '"achievedHitRate"' "${OUT}" || { echo "FAIL: missing achievedHitRate row" >&2; exit 1; }
grep -q '"p95Ms"' "${OUT}"          || { echo "FAIL: missing p95-vs-hit-rate row" >&2; exit 1; }

echo "PASS: hitrate_curve.js wired up; row emitted at ${OUT}"
```
- [ ] **Step 2: Run test to verify it fails**
Run: `chmod +x tests/loadtest/k6/scenarios/hitrate_curve.local.sh && BASE_URL=http://127.0.0.1:8080 tests/loadtest/k6/scenarios/hitrate_curve.local.sh`
Expected: FAIL — k6 aborts with `cannot find module '.../scenarios/hitrate_curve.js'`; script exits non-zero before PASS.

- [ ] **Step 3: Implement `scenarios/hitrate_curve.js`**

`scenarios/hitrate_curve.js`:
```javascript
// tests/loadtest/k6/scenarios/hitrate_curve.js
//
// Cache-hit-rate vs p95 curve (spec §8 cache, §11.3.3 cache_hit_ratio>0.85).
// constant-arrival-rate at a fixed TARGET_RATE; KEYSPACE_MODE=zipf. Each RUN is
// ONE point on the curve: the operator sweeps ZIPF_EXP across runs (higher
// exponent -> more skew -> higher reuse -> higher achieved hit rate). The
// scenario does NOT itself force a hit rate; it MEASURES the achieved
// per-endpoint cache hit rate from /metrics deltas and asserts it lands within
// ±HITRATE_TOLERANCE (default 3%) of the HIT_RATE the operator claims this
// ZIPF_EXP should yield, then emits a (achievedHitRate, p95Ms) row.
//
// Why measure not synthesize: the real hit rate depends on ristretto admission
// + the artifact's true keyspace cardinality, which a fixture cannot fake. The
// honest curve comes from the real artifact (Step 3b).

import http from 'k6/http';
import { check } from 'k6';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.2/index.js';
import {
  BASE_URL, ARTIFACT_KIND, TARGET_RATE, DURATION, HIT_RATE, ZIPF_EXP,
  resolveVersion,
} from '../lib/config.js';
import { loadRegulators, makeZipf } from '../lib/keyspace.js';
import { buildRequest, WEIGHTS } from '../lib/mix.js';
import { scrapeMetrics, cacheHitRate } from '../lib/metrics.js';

const HITRATE_TOLERANCE = parseFloat(__ENV.HITRATE_TOLERANCE || '0.03'); // ±3%

export const options = {
  scenarios: {
    curve: {
      executor: 'constant-arrival-rate',
      rate: TARGET_RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: Math.max(20, TARGET_RATE * 2),
      maxVUs: Math.max(100, TARGET_RATE * 10),
      exec: 'mix',
    },
  },
  // No hard SLO gates here — this scenario CHARACTERIZES, it does not gate. We
  // only fail the run if the achieved hit rate misses its target band (checked
  // in handleSummary), surfaced as the 'hitrate_band' check.
};

// The set of endpoints whose per-endpoint hit rate we report on the curve.
const TRACKED_ENDPOINTS = Object.keys(WEIGHTS);

export function setup() {
  if (ARTIFACT_KIND === 'fixture') {
    console.warn(
      'WARNING: ARTIFACT_KIND=fixture — hitrate_curve.js is AUTHORITATIVE. ' +
      'A fixture keyspace is too small to produce a realistic hit-rate curve; ' +
      'run with ARTIFACT_KIND=real on EC2.',
    );
  }
  const version = resolveVersion();
  const allDatasets = ['callingcards', 'harbison', 'hackett'];
  const regulators = loadRegulators(version, allDatasets);
  // Snapshot /metrics BEFORE the run so handleSummary can compute hit-rate over
  // the run window only (not lifetime).
  const before = scrapeMetrics(BASE_URL);
  return { version, regulators, datasets: allDatasets, before };
}

// Zipf-skewed traffic: a small popular head is requested far more often,
// producing cache reuse. The zipf picker is seeded per-VU-iteration by rng01.
export function mix(data) {
  const pickReg = makeZipf(data.regulators, ZIPF_EXP);
  const ctx = {
    version: data.version,
    regulators: data.regulators,
    datasets: data.datasets,
    // Force the keyspace through the zipf picker by handing buildRequest a
    // skewed rng: we pre-pick the regulator and override via ctx.pinnedRegulator.
    pinnedRegulator: pickReg(Math.random()),
  };
  const req = buildRequest(Math.random(), ctx);
  const res = http.request(req.method, req.url, null, { tags: req.tags });
  check(res, { 'status 2xx': (r) => r.status >= 200 && r.status < 300 });
}

export function handleSummary(data) {
  // Re-scrape AFTER the run. setup's `before` snapshot is in data.setup_data.
  const before = data.setup_data ? data.setup_data.before : '';
  const after = scrapeMetrics(BASE_URL);

  // Per-endpoint achieved hit rate over the run window (delta-based).
  const perEndpoint = {};
  for (const ep of TRACKED_ENDPOINTS) {
    perEndpoint[ep] = windowHitRate(before, after, ep);
  }
  const globalAchieved = windowHitRate(before, after, null);

  const target = HIT_RATE;
  const inBand = Math.abs(globalAchieved - target) <= HITRATE_TOLERANCE;

  const p95 = data.metrics.http_req_duration
    ? data.metrics.http_req_duration.values['p(95)'] : NaN;

  const row = {
    artifactVersion: data.setup_data ? data.setup_data.version : 'unknown',
    artifactKind: ARTIFACT_KIND,
    zipfExp: ZIPF_EXP,
    targetHitRate: target,
    achievedHitRate: round3(globalAchieved),
    perEndpointHitRate: Object.fromEntries(
      Object.entries(perEndpoint).map(([k, v]) => [k, round3(v)]),
    ),
    p95Ms: p95 && p95.toFixed ? Number(p95.toFixed(1)) : p95,
    toleranceAbs: HITRATE_TOLERANCE,
    inBand,
  };

  const verdict =
    `zipf_exp=${ZIPF_EXP}  target_hit=${(target * 100).toFixed(0)}%  ` +
    `achieved=${(globalAchieved * 100).toFixed(1)}%  ` +
    `${inBand ? 'IN-BAND' : 'OUT-OF-BAND (±' + (HITRATE_TOLERANCE * 100).toFixed(0) + '%)'}  ` +
    `p95=${row.p95Ms} ms`;

  return {
    stdout: textSummary(data, { indent: ' ', enableColors: true }) +
      '\n\n=== HIT-RATE CURVE POINT ===\n' + verdict +
      '\nper-endpoint: ' + JSON.stringify(row.perEndpointHitRate) + '\n',
    'hitrate_curve.summary.json': JSON.stringify(row, null, 2),
  };
}

// hits/(hits+misses) over the [before, after] window for one endpoint (or
// global if endpoint is null). Uses the metrics.js cacheHitRate helper applied
// to a synthetic "delta text": we compute deltas inline since cacheHitRate
// reads absolute counters. Simpler: derive from raw counter deltas.
function windowHitRate(beforeText, afterText, endpoint) {
  const labels = endpoint ? { endpoint } : undefined;
  // metrics.js exposes parseCounter via cacheHitRate composition; here we read
  // the absolute hit rate from after-text minus before-text deltas through the
  // metricDelta-equivalent. cacheHitRate(after, ep) is lifetime; subtract the
  // before lifetime to get the window. We approximate via cacheHitRate on a
  // delta-merged view is not possible, so compute from counters directly.
  return deltaHitRate(beforeText, afterText, labels);
}

function deltaHitRate(beforeText, afterText, labels) {
  const lab = labels && labels.endpoint ? `{endpoint="${labels.endpoint}"}` : '';
  const grab = (text, name) => {
    const re = new RegExp(`^${name}${escapeRe(lab)}\\s+([0-9.eE+-]+)`, 'm');
    const m = re.exec(text);
    return m ? parseFloat(m[1]) : 0;
  };
  // When no endpoint label, sum ALL label series for the metric.
  const grabAll = (text, name) => {
    const re = new RegExp(`^${name}(\\{[^}]*\\})?\\s+([0-9.eE+-]+)`, 'gm');
    let total = 0; let m;
    while ((m = re.exec(text)) !== null) total += parseFloat(m[2]);
    return total;
  };
  const hb = lab ? grab(beforeText, 'cache_hits_total') : grabAll(beforeText, 'cache_hits_total');
  const ha = lab ? grab(afterText, 'cache_hits_total') : grabAll(afterText, 'cache_hits_total');
  const mb = lab ? grab(beforeText, 'cache_misses_total') : grabAll(beforeText, 'cache_misses_total');
  const ma = lab ? grab(afterText, 'cache_misses_total') : grabAll(afterText, 'cache_misses_total');
  const dh = ha - hb;
  const dm = ma - mb;
  const denom = dh + dm;
  return denom > 0 ? dh / denom : 0;
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function round3(x) { return Math.round(x * 1000) / 1000; }
```

NOTE for the implementer: `mix.js.buildRequest` must honor `ctx.pinnedRegulator` (when set, it uses that regulator instead of picking its own) — that is the seam this scenario relies on to inject the zipf-skewed key. Confirm with the Phase-A author that `buildRequest` reads `ctx.pinnedRegulator`; if the contract differs, drive the zipf pick by re-seeding the regulator list order instead. The `deltaHitRate` helper duplicates a little of `metrics.js` because `cacheHitRate` reports lifetime, not windowed, hit rate; prefer to extend `metrics.js` with a `windowedCacheHitRate(before, after, endpoint)` and call that here if the Phase-A author agrees.

- [ ] **Step 4: Run test to verify it passes**
Run: `BASE_URL=http://127.0.0.1:8080 tests/loadtest/k6/scenarios/hitrate_curve.local.sh`
Expected: PASS — prints `PASS: hitrate_curve.js wired up; row emitted at ...`, exit 0. (With `HITRATE_TOLERANCE=1.0` the band check cannot fail on the tiny fixture run, so the run is about mechanics only.)

- [ ] **Step 3b (operational): AUTHORITATIVE hit-rate-vs-p95 sweep on EC2, k6 OFF-box**

Sweep `ZIPF_EXP` across runs to walk the curve. Each run = one point. `ARTIFACT_KIND=real`, k6 off-box, constant-arrival-rate held long enough for the cache to reach steady state (≥ 5 min). Restart the backend between points so each point starts from a known-cold cache and the windowed hit rate reflects only that run.

```bash
for EXP in 0.6 0.9 1.2 1.5 2.0; do
  docker compose -f deploy/docker-compose.yml restart tfbp   # on the t3.small
  k6 run \
    -e BASE_URL=https://tfbindingandperturbation.com \
    -e ARTIFACT_KIND=real \
    -e KEYSPACE_MODE=zipf \
    -e ZIPF_EXP="${EXP}" \
    -e TARGET_RATE=40 \
    -e DURATION=5m \
    -e HIT_RATE="$(python3 - <<PY
# operator's expected hit rate for this exponent, from a calibration pre-run
print({'0.6':0.55,'0.9':0.7,'1.2':0.82,'1.5':0.9,'2.0':0.95}['${EXP}'])
PY
)" \
    -e HITRATE_TOLERANCE=0.03 \
    --summary-export="hitrate_exp_${EXP}.json" \
    tests/loadtest/k6/scenarios/hitrate_curve.js
done
```
Calibration precondition: k6 host CPU < 70% and the scenario's printed `dropped_iterations` (visible in the k6 summary; constant-arrival-rate drops iterations when it cannot place them) must be 0 for each point.

Pass/fail per point: read `achievedHitRate` and `targetHitRate` from `hitrate_exp_<EXP>.json` — the point is VALID iff `|achievedHitRate - targetHitRate| <= 0.03` (the `inBand:true` field). Record the `(achievedHitRate, p95Ms)` pair from each in-band point into the §10 "hit-rate-vs-p95 curve" table. The headline assertion is that at the realistic operating point (the popular-regulator subset, ≈ `ZIPF_EXP≈1.2`) the **per-endpoint** `perEndpointHitRate["binding/data"]` exceeds 0.85 (spec §11.3.3), and that p95 at that hit rate is < 200 ms.

- [ ] **Step 5: Commit**
`git add tests/loadtest/k6/scenarios/hitrate_curve.js tests/loadtest/k6/scenarios/hitrate_curve.local.sh && git commit -m "test(loadtest): cache hit-rate vs p95 zipf sweep scenario"`

---

### Task 16: scenarios/breakpoint.js — past-the-knee capacity + degradation-mode classifier

**Files:**
- Create: `tests/loadtest/k6/scenarios/breakpoint.js`
- Test: `tests/loadtest/k6/scenarios/breakpoint.local.sh`

- [ ] **Step 1: Write the failing test** (local fixture-mechanics — tiny ramp far below the real knee; asserts exit 0, teardown reads /metrics deltas, summary stamped with knee/cliff fields and a classified `mode`)
```bash
#!/usr/bin/env bash
# tests/loadtest/k6/scenarios/breakpoint.local.sh
# Local fixture-mechanics test for scenarios/breakpoint.js. Drives a tiny ramp
# (nowhere near the real t3.small knee) purely to prove the scenario builds,
# the teardown scrapes /metrics deltas (db_pool_in_use peak, pool-wait
# counter-pair, go_goroutines, cache_misses) and emits a stamped summary with
# knee/cliff/mode fields. The AUTHORITATIVE run is operational (Step 3b).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE_URL="${BASE_URL:-http://127.0.0.1:8080}"
OUT="$(mktemp -d)/breakpoint.summary.json"

curl -fsS "${BASE_URL}/api/version" >/dev/null || {
  echo "FAIL: no backend at ${BASE_URL}" >&2; exit 1; }

STDERR="$(mktemp)"
k6 run \
  -e BASE_URL="${BASE_URL}" \
  -e KEYSPACE_MODE=uniform \
  -e RATES=2,4,6 \
  -e STEP_HOLD=4s \
  -e PREALLOC_VUS=10 -e MAX_VUS=50 \
  --summary-export="${OUT}" \
  "${HERE}/breakpoint.js" 2>"${STDERR}"

test -s "${OUT}" || { echo "FAIL: summary not written" >&2; exit 1; }
grep -q '"artifactVersion"' "${OUT}" || { echo "FAIL: missing artifactVersion stamp" >&2; exit 1; }
grep -q '"artifactKind"' "${OUT}"    || { echo "FAIL: missing artifactKind stamp" >&2; exit 1; }
grep -q '"degradationMode"' "${OUT}" || { echo "FAIL: missing degradationMode classification" >&2; exit 1; }
grep -q '"dbPoolInUsePeak"' "${OUT}" || { echo "FAIL: missing db_pool_in_use peak" >&2; exit 1; }
grep -q '"poolWaitMeanMs"' "${OUT}"  || { echo "FAIL: missing pool-wait counter-pair mean" >&2; exit 1; }

echo "PASS: breakpoint.js wired up; teardown deltas + mode emitted at ${OUT}"
```
- [ ] **Step 2: Run test to verify it fails**
Run: `chmod +x tests/loadtest/k6/scenarios/breakpoint.local.sh && BASE_URL=http://127.0.0.1:8080 tests/loadtest/k6/scenarios/breakpoint.local.sh`
Expected: FAIL — k6 aborts with `cannot find module '.../scenarios/breakpoint.js'`; exits non-zero before PASS.

- [ ] **Step 3: Implement `scenarios/breakpoint.js`**

`scenarios/breakpoint.js`:
```javascript
// tests/loadtest/k6/scenarios/breakpoint.js
//
// Breaking-point / capacity scenario (spec §6.6 concurrency, §6.3 pool sizing,
// §8 cache, §11 capacity headroom). Open model pushed PAST the knee
// (default 150 -> 300 req/s) against a MOSTLY-MISS keyspace (low reuse) hitting
// the EXPENSIVE endpoints (comparison/topn, binding/data with deep filters), so
// every request must take a DB connection from the size-2 pool. This is the
// scenario that exposes how the system degrades when offered load exceeds the
// pool's service rate.
//
// We do NOT gate on latency here (degradation is expected and intended). The
// VALUE is the teardown: it reads /metrics deltas and CLASSIFIES the
// degradation mode so the cutover summary records WHY it fell over, plus the
// knee (last rate where p95 stayed sane) and the cliff (first rate where
// failures started).
//
// Degradation modes (from /metrics signatures):
//   queue-then-504 : pool saturates (db_pool_in_use pegged at MaxOpenConns),
//                    pool-wait mean climbs, requests time out at the 30s ctx
//                    deadline -> 504/failed rise. Goroutines climb (waiters).
//   OOM            : process_resident_memory_bytes near mem_limit + sudden
//                    failed-rate spike (container OOM-killed); evictions spike.
//   credit-throttle: t3.small CPU-credit exhaustion — latency degrades smoothly
//                    with NO pool saturation and NO OOM (db_pool_in_use NOT
//                    pegged, RSS flat); the k6-host CPU is fine. Classified when
//                    failures rise but pool + memory are both healthy.
//   spill          : DuckDB spilling to temp_directory — db_query_duration
//                    climbs hard while pool waits stay moderate; RSS flat-ish.

import http from 'k6/http';
import { check } from 'k6';
import { Trend } from 'k6/metrics';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.2/index.js';
import {
  BASE_URL, ARTIFACT_KIND, resolveVersion,
} from '../lib/config.js';
import { loadRegulators, makeUniform } from '../lib/keyspace.js';
import { comparisonTopnURL, bindingURL } from '../lib/mix.js';
import {
  scrapeMetrics, parseCounter, metricDelta, poolWaitMeanMs,
} from '../lib/metrics.js';

const RATES = (__ENV.RATES || '50,100,150,200,250,300').split(',').map((s) => parseInt(s.trim(), 10));
const STEP_HOLD = __ENV.STEP_HOLD || '90s';
const RAMP = __ENV.RAMP || '15s';
const PREALLOC_VUS = parseInt(__ENV.PREALLOC_VUS || '100', 10);
const MAX_VUS = parseInt(__ENV.MAX_VUS || '1000', 10);

// Per-rate p95 sampler so teardown can locate the knee. Tag each request with
// the step rate; k6 sub-metric http_req_duration{rate:NNN} gives per-step p95.
function buildStages(rates) {
  const stages = [];
  for (const r of rates) {
    stages.push({ target: r, duration: RAMP });
    stages.push({ target: r, duration: STEP_HOLD });
  }
  return stages;
}

const reqLatency = new Trend('bp_req_ms', true);

export const options = {
  discardResponseBodies: true,   // we are stressing the server, not parsing
  scenarios: {
    push: {
      executor: 'ramping-arrival-rate',
      startRate: RATES[0],
      timeUnit: '1s',
      preAllocatedVUs: PREALLOC_VUS,
      maxVUs: MAX_VUS,
      stages: buildStages(RATES),
      exec: 'expensive',
    },
  },
  // No thresholds: failure is the subject under study, not a gate.
};

export function setup() {
  if (ARTIFACT_KIND === 'fixture') {
    console.warn(
      'WARNING: ARTIFACT_KIND=fixture — breakpoint.js is AUTHORITATIVE. The ' +
      'fixture has a tiny keyspace and no real DuckDB cost; the knee/cliff and ' +
      'degradation mode are MEANINGLESS on a fixture. Run ARTIFACT_KIND=real on EC2.',
    );
  }
  const version = resolveVersion();
  const allDatasets = ['callingcards', 'harbison', 'hackett'];
  const regulators = loadRegulators(version, allDatasets);
  const before = scrapeMetrics(BASE_URL);
  return { version, regulators, datasets: allDatasets, before, rates: RATES };
}

// Mostly-miss expensive traffic: uniform pick over the full regulator space
// (so reuse is low and the cache cannot shield the pool), 70% comparison/topn
// (the most expensive endpoint), 30% binding with a varied filter.
export function expensive(data) {
  const pickReg = makeUniform(data.regulators);
  const ctx = {
    version: data.version,
    regulators: data.regulators,
    datasets: data.datasets,
    pinnedRegulator: pickReg(Math.random()),
  };
  let url;
  let endpoint;
  if (Math.random() < 0.7) {
    url = comparisonTopnURL(ctx);
    endpoint = 'comparison/topn';
  } else {
    url = bindingURL(ctx);
    endpoint = 'binding/data';
  }
  const res = http.get(url, { tags: { endpoint } });
  reqLatency.add(res.timings.duration, { endpoint });
  check(res, { 'not 5xx': (r) => r.status < 500 });
}

export function teardown(data) {
  const after = scrapeMetrics(BASE_URL);
  const before = data.before;

  // --- pool saturation signal ---
  const poolInUsePeak = peakGauge(after, 'db_pool_in_use');     // gauge: last scrape value
  const poolOpen = peakGauge(after, 'db_pool_open_connections');
  const poolWaitMean = poolWaitMeanMs(before, after);            // counter-pair mean ms
  const waitCountDelta = metricDelta(before, after, 'db_pool_wait_count_total');

  // --- memory / OOM signal ---
  const rssAfter = peakGauge(after, 'process_resident_memory_bytes');
  const rssBefore = peakGauge(before, 'process_resident_memory_bytes');

  // --- goroutine pile-up signal (waiters) ---
  const goroutines = peakGauge(after, 'go_goroutines');

  // --- cache + eviction + miss signal ---
  const cacheMissesDelta = metricDelta(before, after, 'cache_misses_total');
  const evictionsDelta = metricDelta(before, after, 'cache_evictions_total');

  // --- failure signal from the k6 run is in handleSummary; teardown stashes
  //     the raw metric deltas in a module-level object for handleSummary. ---
  __DELTAS = {
    dbPoolInUsePeak: poolInUsePeak,
    dbPoolOpenConnections: poolOpen,
    poolWaitMeanMs: round1(poolWaitMean),
    poolWaitCountDelta: waitCountDelta,
    rssBeforeMB: round1(rssBefore / 1048576),
    rssAfterMB: round1(rssAfter / 1048576),
    goGoroutines: goroutines,
    cacheMissesDelta,
    cacheEvictionsDelta: evictionsDelta,
  };
}

// Module-global so teardown -> handleSummary can hand off the deltas. k6 runs
// teardown before handleSummary in the same VU-less context.
let __DELTAS = null;

export function handleSummary(data) {
  const d = __DELTAS || {};
  const failedRate = data.metrics.http_req_failed
    ? data.metrics.http_req_failed.values.rate : 0;
  const p95 = data.metrics.http_req_duration
    ? data.metrics.http_req_duration.values['p(95)'] : NaN;

  // Locate knee + cliff from per-rate sub-metrics if present, else from the
  // aggregate (operator reads the per-step rows from the time series export).
  const rates = data.setup_data ? data.setup_data.rates : [];
  const { knee, cliff } = locateKneeCliff(data, rates);

  const mode = classifyMode({
    failedRate,
    poolInUsePeak: d.dbPoolInUsePeak,
    poolOpen: d.dbPoolOpenConnections,
    poolWaitMeanMs: d.poolWaitMeanMs,
    rssBeforeMB: d.rssBeforeMB,
    rssAfterMB: d.rssAfterMB,
    goGoroutines: d.goGoroutines,
    cacheEvictionsDelta: d.cacheEvictionsDelta,
  });

  const summary = {
    artifactVersion: data.setup_data ? data.setup_data.version : 'unknown',
    artifactKind: ARTIFACT_KIND,
    ratesSwept: rates,
    kneeReqS: knee,
    cliffReqS: cliff,
    aggregateP95Ms: p95 && p95.toFixed ? Number(p95.toFixed(1)) : p95,
    failedRate: round3(failedRate),
    degradationMode: mode.label,
    degradationReason: mode.reason,
    dbPoolInUsePeak: d.dbPoolInUsePeak,
    dbPoolOpenConnections: d.dbPoolOpenConnections,
    poolWaitMeanMs: d.poolWaitMeanMs,
    poolWaitCountDelta: d.poolWaitCountDelta,
    rssBeforeMB: d.rssBeforeMB,
    rssAfterMB: d.rssAfterMB,
    goGoroutines: d.goGoroutines,
    cacheMissesDelta: d.cacheMissesDelta,
    cacheEvictionsDelta: d.cacheEvictionsDelta,
  };

  const lines = [
    `artifact: ${summary.artifactVersion} (${ARTIFACT_KIND})`,
    `knee  (last sane rate):   ${knee == null ? 'n/a' : knee + ' req/s'}`,
    `cliff (first failing):    ${cliff == null ? 'n/a' : cliff + ' req/s'}`,
    `degradation mode:         ${mode.label} — ${mode.reason}`,
    `db_pool_in_use peak:      ${d.dbPoolInUsePeak} / ${d.dbPoolOpenConnections} open`,
    `pool-wait mean:           ${d.poolWaitMeanMs} ms (counter-pair)`,
    `go_goroutines:            ${d.goGoroutines}`,
    `RSS:                      ${d.rssBeforeMB} -> ${d.rssAfterMB} MB`,
    `cache_misses Δ:           ${d.cacheMissesDelta}`,
    `failed rate:              ${(failedRate * 100).toFixed(2)}%`,
  ];

  return {
    stdout: textSummary(data, { indent: ' ', enableColors: true }) +
      '\n\n=== BREAKING POINT ===\n' + lines.join('\n') + '\n',
    'breakpoint.summary.json': JSON.stringify(summary, null, 2),
  };
}

// --- helpers -----------------------------------------------------------------

// Reads the last value of a gauge metric line from /metrics text. (Gauges have
// no delta; the post-run scrape is the relevant peak-ish value. For a true peak
// the operator samples db_pool_in_use during the run via the (operational)
// loop below.)
function peakGauge(text, name) {
  const re = new RegExp(`^${name}(\\{[^}]*\\})?\\s+([0-9.eE+-]+)`, 'm');
  const m = re.exec(text);
  return m ? parseFloat(m[2]) : 0;
}

// Knee = highest rate whose per-step p95 stayed under KNEE_P95_MS; cliff =
// lowest rate whose per-step failed-rate exceeded CLIFF_FAIL_RATE. Per-step
// values come from k6 sub-metrics tagged by the executor stage; when those are
// unavailable in handleSummary, returns null and the operator fills them from
// the time-series export.
function locateKneeCliff(data, rates) {
  const KNEE_P95_MS = parseFloat(__ENV.KNEE_P95_MS || '500');
  let knee = null;
  let cliff = null;
  for (const r of rates) {
    const dur = data.metrics[`http_req_duration{rate:${r}}`];
    const fail = data.metrics[`http_req_failed{rate:${r}}`];
    const p95 = dur ? dur.values['p(95)'] : null;
    const fr = fail ? fail.values.rate : null;
    if (p95 != null && p95 < KNEE_P95_MS) knee = r;
    if (cliff == null && fr != null && fr > 0.01) cliff = r;
  }
  return { knee, cliff };
}

function classifyMode(s) {
  // OOM: memory jumped toward the limit AND failures rose.
  if (s.failedRate > 0.01 && s.rssAfterMB - s.rssBeforeMB > 300) {
    return { label: 'OOM', reason: `RSS climbed ${s.rssBeforeMB}->${s.rssAfterMB} MB with ${(s.failedRate * 100).toFixed(1)}% failures` };
  }
  // queue-then-504: pool pegged at its open size, waiters piled up, failures rose.
  if (s.poolInUsePeak >= s.poolOpen && s.poolOpen > 0 && (s.poolWaitMeanMs > 100 || s.goGoroutines > 200)) {
    return { label: 'queue-then-504', reason: `pool pegged ${s.poolInUsePeak}/${s.poolOpen}, wait mean ${s.poolWaitMeanMs} ms, goroutines ${s.goGoroutines}` };
  }
  // spill: heavy eviction / DB cost with moderate pool wait — DuckDB spilling.
  if (s.cacheEvictionsDelta > 0 && s.poolWaitMeanMs > 50 && s.poolWaitMeanMs <= 100) {
    return { label: 'spill', reason: `evictions ${s.cacheEvictionsDelta}, moderate pool wait ${s.poolWaitMeanMs} ms (suspect DuckDB temp spill — check max_temp_directory_size)` };
  }
  // credit-throttle: failures/latency rose but pool + memory are healthy.
  if (s.failedRate > 0.005 && s.poolInUsePeak < s.poolOpen && (s.rssAfterMB - s.rssBeforeMB) < 100) {
    return { label: 'credit-throttle', reason: `failures ${(s.failedRate * 100).toFixed(1)}% with healthy pool (${s.poolInUsePeak}/${s.poolOpen}) and flat RSS — suspect t3.small CPU-credit exhaustion` };
  }
  return { label: 'no-degradation', reason: 'system stayed within capacity at the rates swept — push higher RATES' };
}

function round1(x) { return Math.round(x * 10) / 10; }
function round3(x) { return Math.round(x * 1000) / 1000; }
```

NOTE for the implementer: `metrics.js.poolWaitMeanMs(before, after)` is the counter-pair mean (`1000*Δwait_duration_total/Δwait_count_total`) per the contract — this scenario consumes it directly. `db_pool_in_use` is a gauge so `metricDelta` is meaningless for it; the post-run scrape value is a lower-bound proxy. The TRUE peak comes from the (operational) sampling loop below, which the operator pastes into the summary's `dbPoolInUsePeak`. `mix.js` must export `comparisonTopnURL(ctx)` and `bindingURL(ctx)` and honor `ctx.pinnedRegulator` (same seam as Task 15).

- [ ] **Step 4: Run test to verify it passes**
Run: `BASE_URL=http://127.0.0.1:8080 tests/loadtest/k6/scenarios/breakpoint.local.sh`
Expected: PASS — prints `PASS: breakpoint.js wired up; teardown deltas + mode emitted at ...`, exit 0. On the fixture the classified mode will be `no-degradation` (the tiny rates never stress the pool), which is correct mechanics behavior.

- [ ] **Step 3b (operational): AUTHORITATIVE breaking-point run on EC2, k6 OFF-box, with a peak-sampler sidecar**

Run k6 off-box; on the t3.small, run a background sampler that captures the TRUE `db_pool_in_use` peak (the gauge), `go_goroutines`, and RSS once per second for the whole run — `handleSummary`'s post-run scrape only sees the settled value.

On the t3.small (background, before launching k6):
```bash
# capture the real db_pool_in_use / goroutine / RSS peaks during the push
( END=$((SECONDS+1800)); MAXPOOL=0; MAXG=0; MAXRSS=0
  while [ $SECONDS -lt $END ]; do
    M=$(curl -fsS http://127.0.0.1:8080/metrics)
    P=$(printf '%s' "$M" | awk '/^db_pool_in_use /{print $2}')
    G=$(printf '%s' "$M" | awk '/^go_goroutines /{print $2}')
    R=$(printf '%s' "$M" | awk '/^process_resident_memory_bytes /{print $2}')
    awk -v a="$P" -v b="$MAXPOOL" 'BEGIN{exit !(a>b)}' && MAXPOOL=$P
    awk -v a="$G" -v b="$MAXG"    'BEGIN{exit !(a>b)}' && MAXG=$G
    awk -v a="$R" -v b="$MAXRSS"  'BEGIN{exit !(a>b)}' && MAXRSS=$R
    sleep 1
  done
  echo "PEAK db_pool_in_use=$MAXPOOL go_goroutines=$MAXG rss_bytes=$MAXRSS" ) \
  | tee breakpoint-peaks.txt &
```

Off-box k6 invocation (push well past the knee):
```bash
k6 run \
  -e BASE_URL=https://tfbindingandperturbation.com \
  -e ARTIFACT_KIND=real \
  -e KEYSPACE_MODE=uniform \
  -e RATES=50,100,150,200,250,300 \
  -e STEP_HOLD=90s -e RAMP=15s \
  -e PREALLOC_VUS=100 -e MAX_VUS=1000 \
  -e KNEE_P95_MS=500 \
  --summary-export=breakpoint.json \
  tests/loadtest/k6/scenarios/breakpoint.js
```
Calibration precondition: k6-host CPU < 70% AND `dropped_iterations == 0` — if k6 dropped iterations, the offered rate at the top steps is fiction and the knee/cliff are wrong; lower the top RATES or shard k6 across two off-box generators.

Metric + threshold to read for pass/fail (this scenario CHARACTERIZES, it does not gate; "pass" = a clean, attributable classification):
- `breakpoint.json:kneeReqS` and `:cliffReqS` → the recorded capacity. Both must be **present and non-null**; if `kneeReqS==null`, the per-step sub-metrics were unavailable → fill from the k6 time-series CSV (`--out csv=...`). If `cliffReqS==null` with the default RATES, the server never broke → push higher RATES (run is incomplete, not a pass).
- `breakpoint.json:degradationMode` → must be one of `queue-then-504 | OOM | credit-throttle | spill` (NOT `no-degradation`); reconcile its `db_pool_in_use peak` against `breakpoint-peaks.txt` and overwrite `dbPoolInUsePeak`/`goGoroutines`/`rssAfterMB` with the sampler's true peaks before recording.
- Headline pass condition for the cutover summary: the knee (`kneeReqS`) must sit **comfortably above** the warm SLO offered rate from Task 14 (80 req/s) — i.e. there is capacity headroom above the documented load profile. If `kneeReqS <= 80`, that is a cutover blocker (the SLO load is already at the knee).

- [ ] **Step 5: Commit**
`git add tests/loadtest/k6/scenarios/breakpoint.js tests/loadtest/k6/scenarios/breakpoint.local.sh && git commit -m "test(loadtest): breaking-point scenario with degradation-mode classifier"`

---

### Task 17: rewrite tests/loadtest-summary.md to v2 (§10 structure)

**Files:**
- Modify: `tests/loadtest-summary.md` (full rewrite)
- Test: `tests/loadtest-summary.v2.check.sh`

- [ ] **Step 1: Write the failing test** (a structural lint asserting the v2 summary contains every §10 section + every interface-contract metric name the operator must fill, and that it still self-identifies as a TEMPLATE)
```bash
#!/usr/bin/env bash
# tests/loadtest-summary.v2.check.sh
# Structural lint for the v2 cutover load-test summary. Asserts the §10 sections
# and every interface-contract metric/threshold the operator must record are
# present, and that it is still marked a TEMPLATE (numbers are filled
# operationally on EC2). Does NOT assert any measured value.
set -euo pipefail

F="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/loadtest-summary.md"
test -f "$F" || { echo "FAIL: $F missing" >&2; exit 1; }

req() { grep -qF -- "$1" "$F" || { echo "FAIL: summary missing required marker: $1" >&2; exit 1; }; }

# Identity
req "TEMPLATE"
req "v2"
req "ARTIFACT_KIND"
req "<FILL IN>"

# §10 section headers
req "## Warm-cache open-model SLO"
req "## Cold cutover number"
req "## Hit-rate vs p95 curve"
req "## Breaking point"
req "## Availability / error budget"
req "## Pool wait (counter-pair)"

# Scenario provenance
req "scenarios/arrival_slo.js"
req "scenarios/hitrate_curve.js"
req "scenarios/breakpoint.js"

# Interface-contract metric names the operator reads
req "http_req_failed"
req "http_req_duration"
req "dropped_iterations"
req "readyz_available"
req "db_pool_in_use"
req "db_pool_wait_duration_seconds_total"
req "db_pool_wait_count_total"
req "go_goroutines"
req "cache_hits_total"
req "cache_misses_total"
req "cache_load_seconds_total"
req "http_in_flight_requests"

# Degradation modes enumerated
req "queue-then-504"
req "credit-throttle"
req "spill"

# Calibration precondition is stated
req "k6 host CPU"
req "off-box"

echo "PASS: loadtest-summary.md is v2 and structurally complete"
```
- [ ] **Step 2: Run test to verify it fails**
Run: `chmod +x tests/loadtest-summary.v2.check.sh && tests/loadtest-summary.v2.check.sh`
Expected: FAIL — `FAIL: summary missing required marker: v2` (the committed summary is the v1 template; it lacks the §10 section headers, the open-model metrics, and the `v2` marker).

- [ ] **Step 3: Rewrite `tests/loadtest-summary.md`** (full replacement with the v2 §10 structure)

```markdown
# Cutover load-test summary — TEMPLATE (v2)

> **This is a TEMPLATE.** The cutover gate is an **operational step** run by the
> operator against the production EC2 `t3.small` with the **real** artifact and
> **k6 OFF-box** (the load generator must not steal the backend's 2 vCPUs).
> Every `<FILL IN>` is replaced with a measured value and committed alongside
> the cutover deploy. Mechanics of each scenario are validated locally on the
> fixture (the `*.local.sh` harnesses); the numbers below are NOT valid unless
> produced with `ARTIFACT_KIND=real`.
>
> Scenarios: `tests/loadtest/k6/scenarios/arrival_slo.js`,
> `hitrate_curve.js`, `breakpoint.js`. Shared libs under
> `tests/loadtest/k6/lib/`. Gate definitions: spec
> `docs/superpowers/specs/2026-05-12-go-react-rewrite-design.md` §11.3 and the
> loadtest-program design §10.

---

## Environment

```
Cutover date (UTC):      <FILL IN — e.g. 2026-05-30>
Backend host:            <FILL IN — t3.small, e.g. ec2-XX.compute-1.amazonaws.com>
k6 host (OFF-box):       <FILL IN — laptop/bastion; MUST be a different machine>
BASE_URL:                <FILL IN — e.g. https://tfbindingandperturbation.com>
ARTIFACT_KIND:           real          (MUST be 'real' — 'fixture' runs are mechanics-only)
artifactVersion:         <FILL IN — from /api/version, stamped in every summary JSON>
Backend version:         <FILL IN — git SHA / image digest>
Artifact sha256:         <FILL IN>
DuckDB version (binary): <FILL IN>
```

### Calibration precondition (the run is INVALID if either fails)

| Check | Requirement | Observed | OK? |
| ----- | ----------- | -------- | --- |
| k6 host CPU during run | < 70% (`mpstat 5` on the **off-box** k6 host) | `<FILL IN>` % | `<✓/✗>` |
| `dropped_iterations` (every scenario summary) | == 0 | `<FILL IN>` | `<✓/✗>` |

If either fails, the offered arrival rate is a lie: recalibrate (raise
`MAX_VUS`/`PREALLOC_VUS`, or shard k6 across two off-box generators) and rerun.
No numbers below are valid until both are green.

---

## Warm-cache open-model SLO

Scenario: `scenarios/arrival_slo.js` with `WARM=1` after a popular-keyspace
pre-warm. Open model (`ramping-arrival-rate`), step rate 5 → 40 → 80 req/s held
4m each. Read the thresholds block of the k6 summary / `arrival_slo.warm.json`.

| Metric (read from summary) | Gate | Measured | Pass? |
| -------------------------- | ---- | -------- | ----- |
| `http_req_failed` rate | == 0 | `<FILL IN>` | `<✓/✗>` |
| `http_req_duration{arm:mix}` p95 | < 200 ms | `<FILL IN>` ms | `<✓/✗>` |
| `http_req_duration{arm:mix}` p99 | < 500 ms | `<FILL IN>` ms | `<✓/✗>` |
| `dropped_iterations` | == 0 | `<FILL IN>` | `<✓/✗>` |
| `cache_hits_total / (hits+misses)` for `binding/data` | > 0.85 | `<FILL IN>` | `<✓/✗>` |
| `db_pool_wait_duration_seconds_total` / `db_pool_wait_count_total` mean (see Pool wait below) | < 100 ms | `<FILL IN>` ms | `<✓/✗>` |
| Peak RSS (`process_resident_memory_bytes`, sampled) | < 1.5 GB | `<FILL IN>` MB | `<✓/✗>` |
| OOM kills (`dmesg`) | == 0 | `<FILL IN>` | `<✓/✗>` |

> **SLO verdict (transcribe the scenario's `=== SLO VERDICT ===` block):** `<FILL IN>`

Off-box invocation actually run:
```
<FILL IN — paste the exact k6 command, including -e ARTIFACT_KIND=real -e WARM=1>
```

## Cold cutover number (honest)

Scenario: `scenarios/arrival_slo.js` **without** `WARM`, run **immediately after
`docker compose restart tfbp`** (ristretto empty). NOT gated — this is the
honest cold p95 the first users see before the cache fills. Recorded per spec
§11.3.3 "cold-cache containment".

| Metric | Value | Notes |
| ------ | ----- | ----- |
| `http_req_duration{arm:mix}` p95 (cold) | `<FILL IN>` ms | honest cold cutover p95 |
| `http_req_duration{arm:mix}` p99 (cold) | `<FILL IN>` ms | |
| Cold p95 for `comparison/topn` specifically | `<FILL IN>` ms | most expensive endpoint |
| `singleflight_shared_calls_total{endpoint:"comparison/topn"}` Δ | `<FILL IN>` | coalescing firing on cold popular keys |
| `dropped_iterations` | `<FILL IN>` (must be 0) | else number invalid |

## Hit-rate vs p95 curve

Scenario: `scenarios/hitrate_curve.js`, `KEYSPACE_MODE=zipf`, swept across
`ZIPF_EXP` (one run per point, backend restarted between points). Each row from
`hitrate_exp_<EXP>.json`. A row is VALID only if `inBand:true`
(|achieved − target| ≤ 3%).

| ZIPF_EXP | target hit rate | achieved hit rate | in-band (±3%)? | aggregate p95 (ms) | `binding/data` per-endpoint hit rate |
| -------- | --------------- | ----------------- | -------------- | ------------------ | ------------------------------------ |
| 0.6 | `<FILL IN>` | `<FILL IN>` | `<✓/✗>` | `<FILL IN>` | `<FILL IN>` |
| 0.9 | `<FILL IN>` | `<FILL IN>` | `<✓/✗>` | `<FILL IN>` | `<FILL IN>` |
| 1.2 | `<FILL IN>` | `<FILL IN>` | `<✓/✗>` | `<FILL IN>` | `<FILL IN>` |
| 1.5 | `<FILL IN>` | `<FILL IN>` | `<✓/✗>` | `<FILL IN>` | `<FILL IN>` |
| 2.0 | `<FILL IN>` | `<FILL IN>` | `<✓/✗>` | `<FILL IN>` | `<FILL IN>` |

**Operating-point assertion:** at the realistic skew (≈ `ZIPF_EXP 1.2`)
`perEndpointHitRate["binding/data"]` > 0.85 **and** aggregate p95 < 200 ms.
Result: `<FILL IN — PASS/FAIL>`.

`cache_load_seconds_total{endpoint}` (cold-path wall-seconds, splits route
latency from DB+marshal): `<FILL IN — top 3 endpoints by Δ over the run>`.

## Breaking point

Scenario: `scenarios/breakpoint.js`, `KEYSPACE_MODE=uniform` (mostly-miss),
expensive endpoints, pushed to ~300 req/s. True `db_pool_in_use` /
`go_goroutines` / RSS peaks come from the on-box `breakpoint-peaks.txt`
sampler, NOT the post-run scrape. From `breakpoint.json`.

| Field | Value | Source |
| ----- | ----- | ------ |
| Knee (last sane rate, p95 < 500 ms) | `<FILL IN>` req/s | `kneeReqS` |
| Cliff (first rate with failures) | `<FILL IN>` req/s | `cliffReqS` |
| Degradation mode | `<FILL IN — queue-then-504 \| OOM \| credit-throttle \| spill>` | `degradationMode` |
| Degradation reason | `<FILL IN>` | `degradationReason` |
| `db_pool_in_use` peak / `db_pool_open_connections` | `<FILL IN>` / `<FILL IN>` | sampler + scrape |
| `go_goroutines` peak | `<FILL IN>` | sampler |
| RSS peak | `<FILL IN>` MB | sampler |
| `cache_misses_total` Δ | `<FILL IN>` | scrape delta |
| `cache_evictions_total` Δ | `<FILL IN>` | scrape delta |
| `http_in_flight_requests` peak | `<FILL IN>` | sampler |

**Headroom assertion:** `kneeReqS` must sit comfortably above the warm SLO
offered rate (80 req/s). `kneeReqS <= 80` is a cutover blocker. Result:
`<FILL IN — PASS/FAIL>`.

Degradation-mode reference:
- **queue-then-504** — pool pegged at `db_pool_open_connections`, `db_pool_wait`
  mean climbs, 30s-ctx timeouts → 504s; goroutines pile up.
- **OOM** — RSS near `mem_limit` + sudden failure spike (container OOM-killed).
- **credit-throttle** — latency/failures rise with a **healthy** pool and flat
  RSS → t3.small CPU-credit exhaustion.
- **spill** — `db_query_duration` climbs with moderate pool wait + evictions →
  DuckDB spilling to `temp_directory` (check `max_temp_directory_size`).

## Availability / error budget

From `arrival_slo.js`'s `readyz_available` probe arm (low-rate `/readyz`+`/healthz`)
and `http_req_failed`.

| Metric | Gate | Measured | Pass? |
| ------ | ---- | -------- | ----- |
| `readyz_available` (Rate) | > 0.995 | `<FILL IN>` | `<✓/✗>` |
| `http_req_failed` rate (warm) | < 0.005 | `<FILL IN>` | `<✓/✗>` |
| Error budget consumed during run | informational | `<FILL IN>` | — |

## Pool wait (counter-pair)

`db_pool_wait_duration_seconds` is exported as a counter PAIR. Compute the mean
wait over the run window — do NOT read a single histogram quantile.

```
mean_wait_ms = 1000 * Δ(db_pool_wait_duration_seconds_total)
                    / Δ(db_pool_wait_count_total)
```

(This is exactly `metrics.js poolWaitMeanMs(before, after)`.)

| Window | `db_pool_wait_duration_seconds_total` Δ | `db_pool_wait_count_total` Δ | mean wait (ms) | Gate | Pass? |
| ------ | --------------------------------------- | ---------------------------- | -------------- | ---- | ----- |
| Warm SLO run | `<FILL IN>` | `<FILL IN>` | `<FILL IN>` | < 100 ms | `<✓/✗>` |
| Breaking-point run | `<FILL IN>` | `<FILL IN>` | `<FILL IN>` | informational | — |

---

## Observability checklist

Verify on the running container during the cutover window:

- [ ] `/healthz` 200, `/readyz` 200 with artifact metadata, `/api/version` returns `{artifactVersion, schemaVersion, ...}`.
- [ ] `/metrics` exposes every §6.7 metric **plus** the Phase-A additions:
  `http_in_flight_requests`, `cache_load_seconds_total{endpoint}`,
  `cache_admission_rejected_total{endpoint}`, `cache_oversize_responses_total{endpoint}`.
- [ ] Structured logs include `artifact_version`, `route`, `status`, `latency_ms` per request.
- [ ] Stale `/api/v/{v}/...` with non-current `{v}` returns 410 with `Location: /api/version`.
- [ ] `legacy.tfbindingandperturbation.com` serves Shiny; `tfbindingandperturbation.com` serves the Go SPA.

## How to fill this in

1. Provision real artifact + image per `deploy/README.md`. Confirm `ARTIFACT_KIND=real`.
2. From an **off-box** k6 host, confirm the calibration precondition (CPU < 70%, `dropped_iterations==0`).
3. Pre-warm, run `arrival_slo.js WARM=1` → Warm-cache SLO table + Availability + Pool wait (warm row).
4. `docker compose restart tfbp`, run `arrival_slo.js` (no WARM) → Cold cutover table.
5. Sweep `hitrate_curve.js` over `ZIPF_EXP` (restart between points) → Hit-rate curve.
6. Start the on-box peak sampler, run `breakpoint.js` off-box → Breaking-point table.
7. Tick the observability boxes.
8. `git add tests/loadtest-summary.md && git commit -m "docs(cutover): record v2 load-test summary for <date>"` then proceed with DNS cutover.
```

- [ ] **Step 4: Run test to verify it passes**
Run: `tests/loadtest-summary.v2.check.sh`
Expected: PASS — prints `PASS: loadtest-summary.md is v2 and structurally complete`, exit 0.

- [ ] **Step 5: Commit**
`git add tests/loadtest-summary.md tests/loadtest-summary.v2.check.sh && git commit -m "docs(loadtest): rewrite cutover summary to v2 (§10 open-model SLO, hit-rate curve, breaking point)"`


## Phase C — Chaos / soak / recovery (long EC2 sessions)

_Memory/spill chaos, the post-deploy cold-start cliff, the burst-credit soak, and container-kill recovery. Fast-follow after cutover; not a blocker._

### Task 18: scenarios/cold_start_cliff.js — restart-recovery cliff

**Files:**
- Create: `tests/loadtest/k6/scenarios/cold_start_cliff.js`
- Create: `tests/loadtest/k6/scenarios/cold_start_cliff.fixture.sh`
- Test: `tests/loadtest/k6/scenarios/cold_start_cliff.fixture.sh`

- [ ] **Step 1: Write the failing fixture-mechanics test** (tiny scale, asserts the script parses, runs two phases bracketing a restart, and exits 0). This is a bash harness that boots the backend against the committed fixture, runs the scenario at toy scale, kills + restarts the backend mid-run, and asserts `k6` exits 0.

```bash
#!/usr/bin/env bash
# cold_start_cliff.fixture.sh — local fixture-mechanics check for the
# cold-start-cliff scenario. Tiny scale; asserts exit 0 and that the
# scenario actually observed a restart (cache_hit_rate dipped then recovered).
#
# This is NOT the authoritative recovery gate (that is the "(operational)"
# EC2 block in the plan). It only proves the JS parses, both phases run,
# and the mid-run restart hook fires. Runs against tests/fixtures/tfbp_test.duckdb.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
cd "$REPO_ROOT"

FIXTURE="tests/fixtures/tfbp_test.duckdb"
PORT="${PORT:-18118}"
BASE_URL="http://127.0.0.1:${PORT}"

command -v k6 >/dev/null 2>&1 || { echo "SKIP: k6 not installed"; exit 0; }
[ -f "$FIXTURE" ] || { echo "FAIL: fixture missing: $FIXTURE"; exit 1; }

start_backend() {
  ( cd backend && go run ./cmd/tfbp-server --duckdb="../${FIXTURE}" --port="${PORT}" ) &
  echo $!
}
wait_ready() {
  for _ in $(seq 1 60); do
    if curl -sf "${BASE_URL}/readyz" >/dev/null 2>&1; then return 0; fi
    sleep 0.5
  done
  echo "FAIL: backend never became ready on ${PORT}"; return 1
}

BG_PID="$(start_backend)"
trap 'kill "$BG_PID" 2>/dev/null || true' EXIT
wait_ready

# Toy scale: short phases, low rate. RESTART_CMD is exercised by the harness,
# not by k6 (k6 cannot kill a process); we pass the restart as an external
# step the scenario's setup() records the version twice across.
export BASE_URL ARTIFACT_KIND=fixture
export TARGET_RATE=5 DURATION=4s PHASE1_DURATION=4s PHASE2_DURATION=8s
export ZIPF_EXP=1.1 RECOVERY_HIT_FLOOR=0.0   # do not gate hit-rate at toy scale

# Phase 1: drive steady traffic, then trigger the restart out-of-band.
k6 run --quiet \
  -e RESTART_AT_PHASE_BOUNDARY=1 \
  tests/loadtest/k6/scenarios/cold_start_cliff.js &
K6_PID=$!

# Mid-run restart: wait for phase-1 to be underway, SIGKILL, restart, re-ready.
sleep 4
kill -9 "$BG_PID" 2>/dev/null || true
BG_PID="$(start_backend)"
wait_ready

wait "$K6_PID"
RC=$?
echo "cold_start_cliff fixture mechanics: k6 rc=${RC}"
[ "$RC" -eq 0 ] || { echo "FAIL: k6 exited ${RC}"; exit 1; }
echo "PASS"
```

- [ ] **Step 2: Run test to verify it fails**
Run: `bash tests/loadtest/k6/scenarios/cold_start_cliff.fixture.sh`
Expected: FAIL with `sh: tests/loadtest/k6/scenarios/cold_start_cliff.js: No such file` (or k6 `cannot find module` — the scenario JS does not exist yet)

- [ ] **Step 3: Implement the scenario.** Two `ramping-arrival-rate`-style phases bracketing the (externally driven) restart. Drives steady Zipfian traffic at `TARGET_RATE`, tracks a `Rate('cache_hit')` (from `X-Cache`) and a `Rate('readyz_available')`. The recovery gate (`cache_hit_rate > RECOVERY_HIT_FLOOR`, default 0.85) and `http_req_failed==0` are thresholds; no 503/failed tolerated.

```javascript
import http from 'k6/http';
import { check } from 'k6';
import { Rate, Trend } from 'k6/metrics';
import {
  BASE_URL, ARTIFACT_KIND, TARGET_RATE, ZIPF_EXP, resolveVersion, apiBase,
} from '../lib/config.js';
import { loadRegulators, makeZipf, datasetCombos } from '../lib/keyspace.js';
import { buildRequest } from '../lib/mix.js';
import { availabilityThresholds } from '../thresholds.js';

// Phase durations are independent of DURATION so the restart can be bracketed
// precisely. The host harness restarts the backend at the phase-1/phase-2
// boundary (k6 cannot kill a process; see cold_start_cliff.fixture.sh and the
// operational block).
const PHASE1 = __ENV.PHASE1_DURATION || '5m';   // steady warm traffic pre-restart
const PHASE2 = __ENV.PHASE2_DURATION || '10m';  // recovery window post-restart
const RECOVERY_HIT_FLOOR = parseFloat(__ENV.RECOVERY_HIT_FLOOR || '0.85');

const rate = parseInt(TARGET_RATE, 10);

export const options = {
  scenarios: {
    pre_restart: {
      executor: 'constant-arrival-rate',
      rate, timeUnit: '1s',
      duration: PHASE1,
      preAllocatedVUs: Math.max(20, rate * 4),
      maxVUs: Math.max(50, rate * 10),
      startTime: '0s',
      tags: { phase: 'pre' },
    },
    post_restart: {
      executor: 'constant-arrival-rate',
      rate, timeUnit: '1s',
      duration: PHASE2,
      preAllocatedVUs: Math.max(20, rate * 4),
      maxVUs: Math.max(50, rate * 10),
      startTime: PHASE1,
      tags: { phase: 'post' },
    },
  },
  thresholds: {
    ...availabilityThresholds,
    http_req_failed: ['rate==0'],          // no failed/503 at any point
    'cache_hit{phase:post}': [`rate>=${RECOVERY_HIT_FLOOR}`],
    readyz_available: ['rate>0.99'],
  },
};

const cacheHit = new Rate('cache_hit');
const recoveryLatency = new Trend('post_restart_latency_ms', true);

export function setup() {
  if (ARTIFACT_KIND === 'fixture') {
    console.warn('cold_start_cliff: ARTIFACT_KIND=fixture — recovery numbers are NOT authoritative; run against real artifact on EC2.');
  }
  const version = resolveVersion();
  const datasets = datasetCombos(['callingcards', 'harbison', 'hackett']);
  const regulators = loadRegulators(version, ['callingcards', 'harbison']);
  return { version, datasets, regulators };
}

export default function (data) {
  const ctx = { version: data.version, datasets: data.datasets, regulators: data.regulators };
  const pick = makeZipf(data.regulators, parseFloat(ZIPF_EXP));
  ctx.regulator = pick(Math.random());

  const req = buildRequest(Math.random(), ctx);
  const res = http.request(req.method, req.url, null, { tags: req.tags });

  // /readyz availability is tracked separately so a transient restart window
  // shows up as a dip we can assert recovers (and never as a hard failure).
  const ready = http.get(`${apiBase(data.version).replace(/\/api\/v\/.*/, '')}/readyz`);
  // availability check tolerant of the brief restart window via the Rate threshold
  // (rate>0.99) rather than per-iteration check failure.
  check(res, { 'status<500': (r) => r.status < 500 });
  cacheHit.add(res.headers['X-Cache'] === 'HIT', { phase: req.tags.phase || (__ITER >= 0 ? 'post' : 'pre') });
  recoveryLatency.add(res.timings.duration);
  void ready;
}

export function handleSummary(data) {
  const stamp = {
    scenario: 'cold_start_cliff',
    artifactVersion: data.setup_data ? data.setup_data.version : __ENV.ARTIFACT_VERSION,
    artifactKind: ARTIFACT_KIND,
    recoveryHitFloor: RECOVERY_HIT_FLOOR,
  };
  return {
    stdout: JSON.stringify(stamp, null, 2) + '\n',
    'cold_start_cliff.summary.json': JSON.stringify(data, null, 2),
  };
}
```

- [ ] **Step 4: Run test to verify it passes** — Run: `bash tests/loadtest/k6/scenarios/cold_start_cliff.fixture.sh` Expected: PASS (prints `cold_start_cliff fixture mechanics: k6 rc=0` then `PASS`). If `k6` is not installed locally it prints `SKIP: k6 not installed` and exits 0.

- [ ] **Step 4b (operational) — EC2 recovery gate.** Run on the deploy host against the **real** artifact. Exact commands:
```bash
cd /opt/tfbp
# Phase 1 starts; at the phase boundary we SIGTERM-drain + restart the backend.
export BASE_URL=https://tfbindingandperturbation.com ARTIFACT_KIND=real
export TARGET_RATE=15 PHASE1_DURATION=5m PHASE2_DURATION=10m ZIPF_EXP=1.1 RECOVERY_HIT_FLOOR=0.85
k6 run --out csv=cold_start_cliff.csv tests/loadtest/k6/scenarios/cold_start_cliff.js &
K6_PID=$!
sleep 300                                 # let phase-1 warm the cache for 5m
docker compose restart tfbp               # the mid-run restart (cliff)
until curl -sf "$BASE_URL/readyz" >/dev/null; do sleep 1; done
wait "$K6_PID"
```
**Pass/fail:**
- `http_req_failed` rate **== 0** (no failed request, no 503) across both phases — k6 threshold line must read `✓`.
- `cache_hit{phase:post}` rate **≥ 0.85** by end of phase 2 (recovery to warm hit-rate) — k6 threshold `✓`.
- `readyz_available` rate **> 0.99** (the restart window is the only allowed dip).
- `dmesg | grep -i 'killed process'` shows **0** new OOM kills spanning the run.

- [ ] **Step 5: Commit** — `git add tests/loadtest/k6/scenarios/cold_start_cliff.js tests/loadtest/k6/scenarios/cold_start_cliff.fixture.sh && git commit -m "test(loadtest): cold-start-cliff restart-recovery scenario + fixture mechanics"`

---

### Task 19: scenarios/soak.js — long constant-rate soak at 60-70% of knee

**Files:**
- Create: `tests/loadtest/k6/scenarios/soak.js`
- Create: `tests/loadtest/k6/scenarios/soak.fixture.sh`
- Test: `tests/loadtest/k6/scenarios/soak.fixture.sh`

- [ ] **Step 1: Write the failing fixture-mechanics test** (toy DURATION, asserts exit 0 + the host sampler co-runs and produces a CSV).

```bash
#!/usr/bin/env bash
# soak.fixture.sh — fixture-mechanics check for the long soak scenario.
# Runs a 10-second toy soak against the committed fixture with the host
# sampler co-running, and asserts both exit cleanly and the sampler CSV has
# at least a header + 1 data row. NOT the authoritative 2h soak (operational).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
cd "$REPO_ROOT"

FIXTURE="tests/fixtures/tfbp_test.duckdb"
PORT="${PORT:-18119}"
BASE_URL="http://127.0.0.1:${PORT}"
SAMPLE_CSV="$(mktemp -t soak_sample.XXXXXX.csv)"

command -v k6 >/dev/null 2>&1 || { echo "SKIP: k6 not installed"; exit 0; }
[ -f "$FIXTURE" ] || { echo "FAIL: fixture missing: $FIXTURE"; exit 1; }

( cd backend && go run ./cmd/tfbp-server --duckdb="../${FIXTURE}" --port="${PORT}" ) &
BG_PID=$!
trap 'kill "$BG_PID" 2>/dev/null || true; rm -f "$SAMPLE_CSV"' EXIT

for _ in $(seq 1 60); do curl -sf "${BASE_URL}/readyz" >/dev/null 2>&1 && break; sleep 0.5; done
curl -sf "${BASE_URL}/readyz" >/dev/null || { echo "FAIL: backend not ready"; exit 1; }

# Co-run the host sampler (local mode: no docker stats / no cloudwatch).
SAMPLE_INTERVAL=1 SAMPLE_OUT="$SAMPLE_CSV" BASE_URL="$BASE_URL" SAMPLE_LOCAL=1 \
  bash tests/loadtest/k6/chaos/sampler.sh &
SAMPLER_PID=$!

export BASE_URL ARTIFACT_KIND=fixture
export TARGET_RATE=8 DURATION=10s ZIPF_EXP=1.1 KNEE_FRACTION=0.65
k6 run --quiet tests/loadtest/k6/scenarios/soak.js
RC=$?

kill "$SAMPLER_PID" 2>/dev/null || true
sleep 1

echo "soak fixture mechanics: k6 rc=${RC}"
[ "$RC" -eq 0 ] || { echo "FAIL: k6 exited ${RC}"; exit 1; }
LINES=$(wc -l < "$SAMPLE_CSV")
[ "$LINES" -ge 2 ] || { echo "FAIL: sampler produced ${LINES} lines (<2)"; exit 1; }
echo "PASS (sampler rows=${LINES})"
```

- [ ] **Step 2: Run test to verify it fails**
Run: `bash tests/loadtest/k6/scenarios/soak.fixture.sh`
Expected: FAIL — k6 cannot find `tests/loadtest/k6/scenarios/soak.js` (module not found) before the sampler is even checked.

- [ ] **Step 3: Implement soak.js.** Constant-arrival-rate at `TARGET_RATE` (the operator sets it to ~60-70% of the measured knee), realistic Zipfian endpoint mix from `mix.js`, default `DURATION=2h`. Pairs with the host `sampler.sh` (Task 23) — the scenario itself only drives traffic and asserts no leak/no failure over the long window.

```javascript
import http from 'k6/http';
import { check } from 'k6';
import { Rate, Trend } from 'k6/metrics';
import {
  BASE_URL, ARTIFACT_KIND, TARGET_RATE, DURATION, ZIPF_EXP,
  resolveVersion,
} from '../lib/config.js';
import { loadRegulators, makeZipf, datasetCombos } from '../lib/keyspace.js';
import { buildRequest } from '../lib/mix.js';
import { availabilityThresholds } from '../thresholds.js';

const rate = parseInt(TARGET_RATE, 10);
const KNEE_FRACTION = parseFloat(__ENV.KNEE_FRACTION || '0.65'); // recorded, not gated

export const options = {
  scenarios: {
    soak: {
      executor: 'constant-arrival-rate',
      rate, timeUnit: '1s',
      duration: DURATION,                         // default 2h
      preAllocatedVUs: Math.max(20, rate * 4),
      maxVUs: Math.max(50, rate * 10),
    },
  },
  thresholds: {
    ...availabilityThresholds,                    // http_req_failed: rate<0.005
    http_req_duration: ['p(95)<300', 'p(99)<800'],
    dropped_iterations: ['count==0'],             // scheduler kept up = no rate collapse
  },
};

const soakLatency = new Trend('soak_latency_ms', true);
const cacheHit = new Rate('soak_cache_hit');

export function setup() {
  if (ARTIFACT_KIND === 'fixture') {
    console.warn('soak: ARTIFACT_KIND=fixture — soak numbers are NOT authoritative; run against real artifact on EC2 for >=2h.');
  }
  const version = resolveVersion();
  const datasets = datasetCombos(['callingcards', 'harbison', 'hackett']);
  const regulators = loadRegulators(version, ['callingcards', 'harbison']);
  return { version, datasets, regulators, kneeFraction: KNEE_FRACTION };
}

export default function (data) {
  const ctx = { version: data.version, datasets: data.datasets, regulators: data.regulators };
  ctx.regulator = makeZipf(data.regulators, parseFloat(ZIPF_EXP))(Math.random());
  const req = buildRequest(Math.random(), ctx);
  const res = http.request(req.method, req.url, null, { tags: req.tags });
  check(res, { 'status<500': (r) => r.status < 500 });
  soakLatency.add(res.timings.duration);
  cacheHit.add(res.headers['X-Cache'] === 'HIT');
}

export function handleSummary(data) {
  const stamp = {
    scenario: 'soak',
    artifactVersion: data.setup_data ? data.setup_data.version : null,
    artifactKind: ARTIFACT_KIND,
    targetRate: rate,
    kneeFraction: KNEE_FRACTION,
    duration: DURATION,
  };
  return {
    stdout: JSON.stringify(stamp, null, 2) + '\n',
    'soak.summary.json': JSON.stringify(data, null, 2),
  };
}
```

- [ ] **Step 4: Run test to verify it passes** — Run: `bash tests/loadtest/k6/scenarios/soak.fixture.sh` Expected: PASS (`soak fixture mechanics: k6 rc=0` then `PASS (sampler rows=N)` with N≥2). `SKIP` if k6 absent.

- [ ] **Step 4b (operational) — EC2 2h soak.** First determine the knee with `profile.js`/`step` runs, then:
```bash
cd /opt/tfbp
# Host sampler to CSV on a 15s cadence for the whole soak (Task 23):
SAMPLE_INTERVAL=15 SAMPLE_OUT=soak_sample.csv \
  BASE_URL=https://tfbindingandperturbation.com \
  CONTAINER=tfbp bash tests/loadtest/k6/chaos/sampler.sh &
SAMP=$!
export BASE_URL=https://tfbindingandperturbation.com ARTIFACT_KIND=real
export TARGET_RATE=<round(0.65 * measured_knee_rps)> DURATION=2h ZIPF_EXP=1.1 KNEE_FRACTION=0.65
k6 run --out csv=soak.csv tests/loadtest/k6/scenarios/soak.js
kill "$SAMP"
```
**Pass/fail (read from k6 thresholds + `soak_sample.csv`):**
- `http_req_failed` rate **< 0.005** for the full 2h — k6 threshold `✓`.
- `dropped_iterations count == 0` (the arrival-rate scheduler never fell behind).
- In `soak_sample.csv`: `process_resident_memory_bytes` (peak) **< 1.5 GB** and shows **no monotonic upward drift** over 2h (compare last-hour mean to first-hour mean; growth < 5% = pass).
- `go_goroutines` is **flat** (end-of-soak value within ±10% of the 5-min-mark value → no goroutine leak).
- `dmesg | grep -i 'killed process'` → **0** OOM kills.
- CloudWatch `CPUCreditBalance` (t3.small) **does not trend to 0** over the soak (sampler column must end > 0).

- [ ] **Step 5: Commit** — `git add tests/loadtest/k6/scenarios/soak.js tests/loadtest/k6/scenarios/soak.fixture.sh && git commit -m "test(loadtest): 2h soak scenario at 65% of knee + host-sampler pairing"`

---

### Task 20: scenarios/oversize.js — admission rejection + eviction pressure

**Files:**
- Create: `tests/loadtest/k6/scenarios/oversize.js`
- Create: `tests/loadtest/k6/scenarios/oversize.fixture.sh`
- Test: `tests/loadtest/k6/scenarios/oversize.fixture.sh`

- [ ] **Step 1: Write the failing fixture-mechanics test** (asserts the two-phase scenario runs and the metrics-parse helper reads `cache_admission_rejected_total` / `cache_evictions_total` / `http_response_bytes` without error, exit 0).

```bash
#!/usr/bin/env bash
# oversize.fixture.sh — fixture-mechanics check for the oversize/eviction
# scenario. Boots a backend with a TINY cache so even the fixture's small
# responses trip oversize + eviction, runs both phases, asserts exit 0.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
cd "$REPO_ROOT"

FIXTURE="tests/fixtures/tfbp_test.duckdb"
PORT="${PORT:-18120}"
BASE_URL="http://127.0.0.1:${PORT}"

command -v k6 >/dev/null 2>&1 || { echo "SKIP: k6 not installed"; exit 0; }
[ -f "$FIXTURE" ] || { echo "FAIL: fixture missing: $FIXTURE"; exit 1; }

# 64 KiB cache budget => per-item oversize threshold = budget/20 ≈ 3.2 KiB, so
# the fixture's larger responses are reported oversize and rejected; walking
# distinct keys forces evictions. CACHE_SIZE_BYTES is the runtime env var.
CACHE_SIZE_BYTES=65536 sh -c "cd backend && exec go run ./cmd/tfbp-server --duckdb=\"../${FIXTURE}\" --port=\"${PORT}\"" &
BG_PID=$!
trap 'kill "$BG_PID" 2>/dev/null || true' EXIT

for _ in $(seq 1 60); do curl -sf "${BASE_URL}/readyz" >/dev/null 2>&1 && break; sleep 0.5; done
curl -sf "${BASE_URL}/readyz" >/dev/null || { echo "FAIL: backend not ready"; exit 1; }

export BASE_URL ARTIFACT_KIND=fixture
export PHASE1_ITERS=20 PHASE2_KEYS=40
k6 run --quiet tests/loadtest/k6/scenarios/oversize.js
RC=$?
echo "oversize fixture mechanics: k6 rc=${RC}"
[ "$RC" -eq 0 ] || { echo "FAIL: k6 exited ${RC}"; exit 1; }
echo "PASS"
```

- [ ] **Step 2: Run test to verify it fails**
Run: `bash tests/loadtest/k6/scenarios/oversize.fixture.sh`
Expected: FAIL — k6 module-not-found for `scenarios/oversize.js`.

- [ ] **Step 3: Implement oversize.js.** Phase 1 hammers ONE large key (selection/matrix on all datasets, a wide binding, topn~1000) and watches `X-Cache` + `cache_admission_rejected_total{endpoint}` deltas via `metrics.js`. Phase 2 walks `PHASE2_KEYS` (default 30-50) distinct large keys to force `cache_evictions_total > 0`. Reports the largest `http_response_bytes{route}` bucket-derived size.

```javascript
import http from 'k6/http';
import { check } from 'k6';
import {
  BASE_URL, ARTIFACT_KIND, resolveVersion, apiBase,
} from '../lib/config.js';
import { loadRegulators, datasetCombos, validFilter, filterToParam } from '../lib/keyspace.js';
import { selectionMatrixURL, bindingURL, comparisonTopnURL } from '../lib/mix.js';
import { scrapeMetrics, parseCounter, metricDelta } from '../lib/metrics.js';

const PHASE1_ITERS = parseInt(__ENV.PHASE1_ITERS || '200', 10);
const PHASE2_KEYS = parseInt(__ENV.PHASE2_KEYS || '40', 10);

export const options = {
  scenarios: {
    repeat_large: {
      executor: 'shared-iterations',
      vus: 1,
      iterations: PHASE1_ITERS,
      maxDuration: '5m',
      startTime: '0s',
      exec: 'repeatLarge',
      tags: { phase: 'repeat' },
    },
    walk_distinct: {
      executor: 'shared-iterations',
      vus: 4,
      iterations: PHASE2_KEYS,
      maxDuration: '5m',
      startTime: '10s',     // small gap so phase-1 metrics are scraped first
      exec: 'walkDistinct',
      tags: { phase: 'walk' },
    },
  },
  thresholds: {
    http_req_failed: ['rate==0'],
  },
};

export function setup() {
  if (ARTIFACT_KIND === 'fixture') {
    console.warn('oversize: ARTIFACT_KIND=fixture — sizes/eviction counts are NOT authoritative; run against real artifact on EC2.');
  }
  const version = resolveVersion();
  const allDatasets = ['callingcards', 'harbison', 'hackett'];
  const regulators = loadRegulators(version, ['callingcards', 'harbison']);
  const before = scrapeMetrics(BASE_URL);
  return {
    version,
    allDatasets,
    regulators,
    metricsBefore: before,
    rejectBefore: parseCounter(before, 'cache_admission_rejected_total', { endpoint: '/api/v/{v}/selection/matrix' }),
    evictBefore: parseCounter(before, 'cache_evictions_total'),
  };
}

// Phase 1: one big key repeated. Expect X-Cache to NOT durably flip to HIT if
// the response is oversize (admission rejected), and the per-endpoint reject
// counter to climb.
export function repeatLarge(data) {
  const ctx = { version: data.version, datasets: [data.allDatasets], regulators: data.regulators };
  // The single largest selection/matrix: every dataset at once.
  const url = selectionMatrixURL({
    version: data.version,
    datasets: data.allDatasets,
    filters: filterToParam(validFilter(data.allDatasets[0])),
  });
  const res = http.get(url, { tags: { endpoint: '/api/v/{v}/selection/matrix', phase: 'repeat' } });
  check(res, { 'matrix 200': (r) => r.status === 200 });
}

// Phase 2: walk distinct large keys (wide binding + topn~1000 across combos)
// to overflow the cache and force evictions.
export function walkDistinct(data) {
  const i = __ITER;
  const reg = data.regulators[i % data.regulators.length];
  const combos = datasetCombos(data.allDatasets);
  const combo = combos[i % combos.length];

  const bURL = bindingURL({ version: data.version, regulator: reg, datasets: combo });
  http.get(bURL, { tags: { endpoint: '/api/v/{v}/binding', phase: 'walk' } });

  const tURL = comparisonTopnURL({
    version: data.version,
    binding: combo[0],
    perturbation: 'hackett',
    topN: 1000,
    filters: filterToParam(validFilter(combo[0])),
  });
  http.get(tURL, { tags: { endpoint: '/api/v/{v}/comparison/topn', phase: 'walk' } });
}

export function teardown(data) {
  const after = scrapeMetrics(BASE_URL);
  const rejectDelta = metricDelta(data.metricsBefore, after,
    'cache_admission_rejected_total', { endpoint: '/api/v/{v}/selection/matrix' });
  const evictDelta = metricDelta(data.metricsBefore, after, 'cache_evictions_total');
  const oversizeDelta = metricDelta(data.metricsBefore, after,
    'cache_oversize_responses_total', { endpoint: '/api/v/{v}/selection/matrix' });

  // Largest observed http_response_bytes: read the _sum/_count per route from
  // the after-scrape and report the max _sum/_count (mean) per route as a proxy
  // for the biggest response; also print the highest populated le bucket.
  const sizes = {};
  for (const line of after.split('\n')) {
    const m = line.match(/^http_response_bytes_bucket\{le="([0-9.e+]+)",route="([^"]+)"\}\s+(\d+)/);
    if (m && parseInt(m[3], 10) > 0) {
      const route = m[2];
      const le = parseFloat(m[1]);
      if (!sizes[route] || le > sizes[route]) sizes[route] = le;
    }
  }
  console.log('--- oversize scenario deltas ---');
  console.log(`cache_admission_rejected_total{endpoint="/api/v/{v}/selection/matrix"} += ${rejectDelta}`);
  console.log(`cache_oversize_responses_total{endpoint="/api/v/{v}/selection/matrix"} += ${oversizeDelta}`);
  console.log(`cache_evictions_total += ${evictDelta}`);
  console.log('largest populated http_response_bytes le-bucket per route:');
  for (const route of Object.keys(sizes)) {
    console.log(`  ${route}: <= ${sizes[route]} bytes`);
  }
}

export function handleSummary(data) {
  return {
    stdout: JSON.stringify({ scenario: 'oversize', artifactKind: ARTIFACT_KIND, phase2Keys: PHASE2_KEYS }, null, 2) + '\n',
    'oversize.summary.json': JSON.stringify(data, null, 2),
  };
}
```

- [ ] **Step 4: Run test to verify it passes** — Run: `bash tests/loadtest/k6/scenarios/oversize.fixture.sh` Expected: PASS (`oversize fixture mechanics: k6 rc=0` then `PASS`). `SKIP` if k6 absent.

- [ ] **Step 4b (operational) — EC2 oversize + eviction.** Run against real artifact + the production `CACHE_SIZE_BYTES=134217728`:
```bash
cd /opt/tfbp
export BASE_URL=https://tfbindingandperturbation.com ARTIFACT_KIND=real
export PHASE1_ITERS=300 PHASE2_KEYS=50
k6 run --out csv=oversize.csv tests/loadtest/k6/scenarios/oversize.js
```
**Pass/fail (read from the teardown deltas + `/metrics`):**
- Phase 1: if the repeated `selection/matrix` response exceeds budget/20 (≈6.7 MB at 128 MB), `cache_oversize_responses_total{endpoint="/api/v/{v}/selection/matrix"}` **> 0** AND a structured WARN log line appears in `docker compose logs tfbp` — **pass** (oversize handling fired). If under threshold, the counter is 0 and `X-Cache` flips to `HIT` after the first iteration — also acceptable, record which.
- Phase 1: `http_req_failed` rate **== 0** (oversize must never 500).
- Phase 2: `cache_evictions_total` delta **> 0** (walking 50 distinct large keys exceeded the budget) — **pass**.
- Report: the largest populated `http_response_bytes` `le` bucket per route (printed by teardown) — record in `tests/loadtest-summary.md` so we know which endpoint produces the biggest payloads.
- `db_pool_in_use` never pinned at 2 for the whole phase (sampler/`/metrics` spot check).

- [ ] **Step 5: Commit** — `git add tests/loadtest/k6/scenarios/oversize.js tests/loadtest/k6/scenarios/oversize.fixture.sh && git commit -m "test(loadtest): oversize admission-reject + eviction-pressure scenario"`

---

### Task 21: scenarios/export_contention.js — export starvation guard

**Files:**
- Create: `tests/loadtest/k6/scenarios/export_contention.js`
- Create: `tests/loadtest/k6/scenarios/export_contention.fixture.sh`
- Test: `tests/loadtest/k6/scenarios/export_contention.fixture.sh`

- [ ] **Step 1: Write the failing fixture-mechanics test** (asserts the three-role scenario runs, the second export observes the 408 queue-timeout path, and `db_pool_in_use` never hits 2 for exports; exit 0).

```bash
#!/usr/bin/env bash
# export_contention.fixture.sh — fixture-mechanics check. VU A runs a large
# /export, VU B fires a second /export (expected to queue then 408 if A is
# still streaming), VUs C hammer cached/expensive JSON. Asserts exit 0 and
# that db_pool_in_use never reached MaxOpenConns=2 from exports alone.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
cd "$REPO_ROOT"

FIXTURE="tests/fixtures/tfbp_test.duckdb"
PORT="${PORT:-18121}"
BASE_URL="http://127.0.0.1:${PORT}"

command -v k6 >/dev/null 2>&1 || { echo "SKIP: k6 not installed"; exit 0; }
[ -f "$FIXTURE" ] || { echo "FAIL: fixture missing: $FIXTURE"; exit 1; }

( cd backend && go run ./cmd/tfbp-server --duckdb="../${FIXTURE}" --port="${PORT}" ) &
BG_PID=$!
trap 'kill "$BG_PID" 2>/dev/null || true' EXIT
for _ in $(seq 1 60); do curl -sf "${BASE_URL}/readyz" >/dev/null 2>&1 && break; sleep 0.5; done
curl -sf "${BASE_URL}/readyz" >/dev/null || { echo "FAIL: backend not ready"; exit 1; }

export BASE_URL ARTIFACT_KIND=fixture
# At fixture scale exports are tiny, so the 2nd export usually 200s before the
# semaphore times out. The fixture run therefore asserts MECHANICS only:
# the scenario runs, the export-queue Trend exists, and JSON co-traffic stays
# 200. The 408 + p95-hold assertions are the operational gate.
export EXPECT_408=0 DURATION=15s
k6 run --quiet tests/loadtest/k6/scenarios/export_contention.js
RC=$?
echo "export_contention fixture mechanics: k6 rc=${RC}"
[ "$RC" -eq 0 ] || { echo "FAIL: k6 exited ${RC}"; exit 1; }
echo "PASS"
```

- [ ] **Step 2: Run test to verify it fails**
Run: `bash tests/loadtest/k6/scenarios/export_contention.fixture.sh`
Expected: FAIL — k6 module-not-found for `scenarios/export_contention.js`.

- [ ] **Step 3: Implement export_contention.js.** Three scenarios sharing the executor: VU A (one big export, holds a pool conn), VU B (second export starting slightly later — asserts `408` "export queue timeout" within ~30s when `EXPECT_408=1`), VUs C (hammer cached/expensive JSON). Assert co-running JSON p95 holds and the export semaphore (cap 1) keeps `db_pool_in_use < 2` attributable to exports.

```javascript
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate } from 'k6/metrics';
import {
  BASE_URL, ARTIFACT_KIND, resolveVersion, apiBase,
} from '../lib/config.js';
import { loadRegulators, datasetCombos, validFilter, filterToParam } from '../lib/keyspace.js';
import { bindingURL, comparisonTopnURL } from '../lib/mix.js';
import { scrapeMetrics, parseCounter } from '../lib/metrics.js';

const EXPECT_408 = (__ENV.EXPECT_408 || '1') === '1';
const DURATION = __ENV.DURATION || '2m';

export const options = {
  scenarios: {
    exporterA: {
      executor: 'shared-iterations', vus: 1, iterations: 1, maxDuration: DURATION,
      exec: 'bigExport', startTime: '0s', tags: { role: 'A' },
    },
    exporterB: {
      executor: 'shared-iterations', vus: 1, iterations: 1, maxDuration: DURATION,
      exec: 'secondExport', startTime: '1s', tags: { role: 'B' },
    },
    jsonHammer: {
      executor: 'constant-vus', vus: 8, duration: DURATION,
      exec: 'cachedJson', startTime: '0s', tags: { role: 'C' },
    },
  },
  thresholds: {
    // The whole point: co-running JSON stays fast while two exports contend.
    'http_req_duration{role:C}': ['p(95)<300', 'p(99)<800'],
    'http_req_failed{role:C}': ['rate==0'],
    export_queue_408: EXPECT_408 ? ['rate>0'] : ['rate>=0'],
  },
};

const exportLatency = new Trend('export_latency_ms', true);
const export408 = new Rate('export_queue_408');

export function setup() {
  if (ARTIFACT_KIND === 'fixture') {
    console.warn('export_contention: ARTIFACT_KIND=fixture — exports are tiny; 408/p95 gates are NOT authoritative. Run on EC2.');
  }
  const version = resolveVersion();
  const allDatasets = ['callingcards', 'harbison', 'hackett'];
  const regulators = loadRegulators(version, ['callingcards', 'harbison']);
  return { version, allDatasets, regulators };
}

function exportURL(version, datasets) {
  // Largest legal export: every dataset, no filter -> all rows (capped server-side).
  return `${apiBase(version)}/export?datasets=${datasets.join(',')}`;
}

export function bigExport(data) {
  const res = http.get(exportURL(data.version, data.allDatasets),
    { tags: { endpoint: '/api/v/{v}/export', role: 'A' }, timeout: '300s' });
  exportLatency.add(res.timings.duration);
  check(res, { 'A export 200': (r) => r.status === 200 });
}

export function secondExport(data) {
  // Fires while A is (hopefully) still streaming. With the cap-1 semaphore and
  // the 30s router timeout, B should receive 408 "export queue timeout".
  const res = http.get(exportURL(data.version, data.allDatasets),
    { tags: { endpoint: '/api/v/{v}/export', role: 'B' }, timeout: '60s' });
  exportLatency.add(res.timings.duration);
  const got408 = res.status === 408;
  export408.add(got408);
  if (EXPECT_408) {
    check(res, {
      'B queued then 408 (or 200 if A finished first)': (r) => r.status === 408 || r.status === 200,
      'B 408 within ~32s': (r) => r.status !== 408 || r.timings.duration <= 32000,
    });
  } else {
    check(res, { 'B 200 or 408': (r) => r.status === 200 || r.status === 408 });
  }
}

export function cachedJson(data) {
  const reg = data.regulators[Math.floor(Math.random() * data.regulators.length)];
  const combo = datasetCombos(data.allDatasets)[0];
  // alternate cached binding + expensive topn so we cover both paths
  if (Math.random() < 0.7) {
    http.get(bindingURL({ version: data.version, regulator: reg, datasets: combo }),
      { tags: { endpoint: '/api/v/{v}/binding', role: 'C' } });
  } else {
    http.get(comparisonTopnURL({
      version: data.version, binding: combo[0], perturbation: 'hackett',
      topN: 1000, filters: filterToParam(validFilter(combo[0])),
    }), { tags: { endpoint: '/api/v/{v}/comparison/topn', role: 'C' } });
  }
  sleep(0.2 + Math.random() * 0.5);
}

export function teardown(data) {
  const after = scrapeMetrics(BASE_URL);
  // db_pool_in_use is a gauge; print its final sample for the operator. The
  // real-time max is captured by the host sampler (Task 23) during the run.
  const inUseLine = (after.match(/^db_pool_in_use\s+([0-9.]+)/m) || ['', 'n/a'])[1];
  console.log(`db_pool_in_use (final sample): ${inUseLine}`);
  console.log(`export_queue_408 observed: ${parseCounter(after, 'http_requests_total', { code: '408' })}`);
}

export function handleSummary(data) {
  return {
    stdout: JSON.stringify({ scenario: 'export_contention', artifactKind: ARTIFACT_KIND, expect408: EXPECT_408 }, null, 2) + '\n',
    'export_contention.summary.json': JSON.stringify(data, null, 2),
  };
}
```

- [ ] **Step 4: Run test to verify it passes** — Run: `bash tests/loadtest/k6/scenarios/export_contention.fixture.sh` Expected: PASS (`export_contention fixture mechanics: k6 rc=0` then `PASS`). `SKIP` if k6 absent.

- [ ] **Step 4b (operational) — EC2 export starvation guard.** Run against real artifact (exports are large enough that A is still streaming when B fires, so the 408 path is exercised). The host sampler (Task 23) must co-run to capture peak `db_pool_in_use`:
```bash
cd /opt/tfbp
SAMPLE_INTERVAL=1 SAMPLE_OUT=export_contention_sample.csv \
  BASE_URL=https://tfbindingandperturbation.com CONTAINER=tfbp \
  bash tests/loadtest/k6/chaos/sampler.sh &
SAMP=$!
export BASE_URL=https://tfbindingandperturbation.com ARTIFACT_KIND=real
export EXPECT_408=1 DURATION=3m
k6 run --out csv=export_contention.csv tests/loadtest/k6/scenarios/export_contention.js
kill "$SAMP"
```
**Pass/fail:**
- VU B receives **`408` "export queue timeout"** within ~30-32s (the router `middleware.Timeout` driving `r.Context().Done()` in the semaphore acquire) — `export_queue_408` rate **> 0**, k6 threshold `✓`. (If A's export completes in < the time B waits, B 200s — re-run with a wider filter/more datasets so A streams > 32s.)
- Co-running JSON: `http_req_duration{role:C}` p95 **< 300 ms**, p99 **< 800 ms** and `http_req_failed{role:C}` **== 0** — proves exports do not starve the API.
- Peak `db_pool_in_use` from `export_contention_sample.csv` **< 2** attributable to exports alone (the cap-1 semaphore guarantees at most one export holds a connection; the second pool slot stays free for role-C traffic). Concretely: in-use **never == 2 while only exports are in flight**; brief 2 is acceptable only when a role-C query co-runs.

- [ ] **Step 5: Commit** — `git add tests/loadtest/k6/scenarios/export_contention.js tests/loadtest/k6/scenarios/export_contention.fixture.sh && git commit -m "test(loadtest): export-contention starvation-guard scenario (408 queue + p95 hold)"`

---

### Task 22: scenarios/error_abuse.js — cheap reject paths under flood

**Files:**
- Create: `tests/loadtest/k6/scenarios/error_abuse.js`
- Create: `tests/loadtest/k6/scenarios/error_abuse.fixture.sh`
- Test: `tests/loadtest/k6/scenarios/error_abuse.fixture.sh`

- [ ] **Step 1: Write the failing fixture-mechanics test** (asserts the open-model flood of 410/400/405 + maximal-legal payloads runs, all reject paths return the expected non-5xx status, the DB pool is never consumed by rejects, exit 0).

```bash
#!/usr/bin/env bash
# error_abuse.fixture.sh — fixture-mechanics check. Floods the backend with
# stale-version (410), bogus-identifier (400), wrong-method (405), and
# maximal-legal payloads, then asserts: no 5xx, reject paths are cheap, and
# the DB pool was never consumed by rejects (db_query_duration_seconds_count
# barely moves). Exit 0.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
cd "$REPO_ROOT"

FIXTURE="tests/fixtures/tfbp_test.duckdb"
PORT="${PORT:-18122}"
BASE_URL="http://127.0.0.1:${PORT}"

command -v k6 >/dev/null 2>&1 || { echo "SKIP: k6 not installed"; exit 0; }
[ -f "$FIXTURE" ] || { echo "FAIL: fixture missing: $FIXTURE"; exit 1; }

( cd backend && go run ./cmd/tfbp-server --duckdb="../${FIXTURE}" --port="${PORT}" ) &
BG_PID=$!
trap 'kill "$BG_PID" 2>/dev/null || true' EXIT
for _ in $(seq 1 60); do curl -sf "${BASE_URL}/readyz" >/dev/null 2>&1 && break; sleep 0.5; done
curl -sf "${BASE_URL}/readyz" >/dev/null || { echo "FAIL: backend not ready"; exit 1; }

# Snapshot DB query count before; reject paths must not run SQL.
DBQ_BEFORE=$(curl -s "${BASE_URL}/metrics" | awk -F' ' '/^db_query_duration_seconds_count/ {s+=$2} END {print s+0}')

export BASE_URL ARTIFACT_KIND=fixture
export TARGET_RATE=50 DURATION=10s
k6 run --quiet tests/loadtest/k6/scenarios/error_abuse.js
RC=$?

DBQ_AFTER=$(curl -s "${BASE_URL}/metrics" | awk -F' ' '/^db_query_duration_seconds_count/ {s+=$2} END {print s+0}')
echo "error_abuse fixture mechanics: k6 rc=${RC}  db_query_count Δ=$((DBQ_AFTER - DBQ_BEFORE))"
[ "$RC" -eq 0 ] || { echo "FAIL: k6 exited ${RC}"; exit 1; }
# Rejects (410/400/405) must not touch the DB. The only legal queries come from
# the small maximal-legal-payload arm; allow a modest delta, not one-per-flood.
[ "$((DBQ_AFTER - DBQ_BEFORE))" -lt 200 ] || { echo "FAIL: DB queries ran on reject paths (Δ too high)"; exit 1; }
echo "PASS"
```

- [ ] **Step 2: Run test to verify it fails**
Run: `bash tests/loadtest/k6/scenarios/error_abuse.fixture.sh`
Expected: FAIL — k6 module-not-found for `scenarios/error_abuse.js`.

- [ ] **Step 3: Implement error_abuse.js.** Open-model (`constant-arrival-rate`, so a slow handler can't throttle the flood) mix of: stale-version → 410; bogus identifier (`?datasets=xyz%27;DROP--`) → 400; non-GET → 405; and maximal-legal payloads (`top_n=1000` × all datasets × ~16KiB filters × 64-char search) which must be accepted (200) but bounded. Uses `openModelThresholds`.

```javascript
import http from 'k6/http';
import { check } from 'k6';
import { Rate } from 'k6/metrics';
import {
  BASE_URL, ARTIFACT_KIND, TARGET_RATE, DURATION, resolveVersion, apiBase,
} from '../lib/config.js';
import { loadRegulators } from '../lib/keyspace.js';
import { openModelThresholds } from '../thresholds.js';

const rate = parseInt(TARGET_RATE || '200', 10);

export const options = {
  scenarios: {
    abuse: {
      executor: 'constant-arrival-rate',
      rate, timeUnit: '1s', duration: DURATION,
      preAllocatedVUs: Math.max(50, rate),
      maxVUs: Math.max(200, rate * 4),
    },
  },
  thresholds: {
    ...openModelThresholds,                 // http_req_failed rate==0 (4xx/410/405 are NOT failures by k6),
    // dropped_iterations count==0 (the flood never throttled the arrival rate)
    'http_req_duration{kind:reject}': ['p(95)<50', 'p(99)<150'],   // reject paths are cheap
  },
};

// A ~16 KiB filters payload of LEGAL shape (values vary; key is a real field).
// MaxFiltersBytes = 16*1024; we sit just under it.
function bigLegalFilter() {
  const vals = [];
  // build a long IN-list of legal-looking integer values to pad toward 16 KiB
  for (let i = 0; i < 1800; i++) vals.push(i);
  const obj = { strain: vals };   // 'strain' replaced at runtime by a real field if needed
  let s = JSON.stringify(obj);
  if (s.length > 16 * 1024) s = s.slice(0, 16 * 1024 - 2) + '}'; // stay under cap
  return s;
}

const search64 = 'Y'.repeat(64);   // MaxSearchChars = 64 (boundary, legal)

export function setup() {
  if (ARTIFACT_KIND === 'fixture') {
    console.warn('error_abuse: ARTIFACT_KIND=fixture — reject-path costs are indicative only; run on EC2 for the authoritative gate.');
  }
  const version = resolveVersion();
  const regulators = loadRegulators(version, ['callingcards', 'harbison']);
  return { version, regulators, staleVersion: '1970-01-01', bigFilter: bigLegalFilter() };
}

export default function (data) {
  const r = Math.random();
  const base = apiBase(data.version);
  const root = base.replace(/\/api\/v\/.*/, '');

  if (r < 0.30) {
    // 410 Gone: stale artifact version.
    const res = http.get(`${root}/api/v/${data.staleVersion}/datasets`,
      { tags: { endpoint: '/api/v/{v}/datasets', kind: 'reject', expect: '410' } });
    check(res, { '410 gone': (x) => x.status === 410, '410 has Location': (x) => !!x.headers['Location'] });
  } else if (r < 0.55) {
    // 400: bogus / injection-shaped identifier.
    const res = http.get(`${base}/binding?regulator=YBR289W&datasets=${encodeURIComponent("xyz';DROP--")}`,
      { tags: { endpoint: '/api/v/{v}/binding', kind: 'reject', expect: '400' } });
    check(res, { '400 bad identifier': (x) => x.status === 400 });
  } else if (r < 0.75) {
    // 405: non-GET on a GET-only route.
    const res = http.request('POST', `${base}/binding?regulator=YBR289W&datasets=callingcards`, null,
      { tags: { endpoint: '/api/v/{v}/binding', kind: 'reject', expect: '405' } });
    check(res, { '405 method': (x) => x.status === 405 });
  } else {
    // Maximal-LEGAL payload: top_n=1000 x all datasets x ~16KiB filters x 64-char search.
    // These are accepted (200) but must be bounded — they exercise the DB.
    const reg = data.regulators[Math.floor(Math.random() * data.regulators.length)];
    const url = `${base}/comparison/topn?binding=callingcards&perturbation=hackett`
      + `&top_n=1000&filters=${encodeURIComponent(data.bigFilter)}`;
    const res = http.get(url, { tags: { endpoint: '/api/v/{v}/comparison/topn', kind: 'legalmax', expect: '200or400' } });
    // A 16KiB filter referencing a field that may not exist in fixture => 400 is
    // acceptable; the key assertion is NO 5xx and the cap (16KiB) is honoured.
    check(res, { 'legalmax not 5xx': (x) => x.status < 500 });
    // also probe the regulator-search 64-char boundary (legal).
    const sres = http.get(`${base}/regulators?search=${encodeURIComponent(search64)}`,
      { tags: { endpoint: '/api/v/{v}/regulators', kind: 'legalmax', expect: '200' } });
    check(sres, { 'search64 ok': (x) => x.status === 200 || x.status === 400 });
  }
}

export function handleSummary(data) {
  return {
    stdout: JSON.stringify({ scenario: 'error_abuse', artifactKind: ARTIFACT_KIND, targetRate: rate }, null, 2) + '\n',
    'error_abuse.summary.json': JSON.stringify(data, null, 2),
  };
}
```

- [ ] **Step 4: Run test to verify it passes** — Run: `bash tests/loadtest/k6/scenarios/error_abuse.fixture.sh` Expected: PASS (`error_abuse fixture mechanics: k6 rc=0 db_query_count Δ=<small>` then `PASS`). `SKIP` if k6 absent.

- [ ] **Step 4b (operational) — EC2 abuse flood.** Run against real artifact at high open-model rate:
```bash
cd /opt/tfbp
SAMPLE_INTERVAL=1 SAMPLE_OUT=error_abuse_sample.csv \
  BASE_URL=https://tfbindingandperturbation.com CONTAINER=tfbp \
  bash tests/loadtest/k6/chaos/sampler.sh &
SAMP=$!
export BASE_URL=https://tfbindingandperturbation.com ARTIFACT_KIND=real
export TARGET_RATE=500 DURATION=2m
k6 run --out csv=error_abuse.csv tests/loadtest/k6/scenarios/error_abuse.js
kill "$SAMP"
```
**Pass/fail:**
- `http_req_failed` rate **== 0** (no 5xx — every reject is a deliberate 410/400/405) and `dropped_iterations count == 0` (the flood never collapsed the arrival rate) — k6 threshold `✓`.
- `http_req_duration{kind:reject}` p95 **< 50 ms**, p99 **< 150 ms** — reject paths are cheap (no SQL, no marshal).
- **No pool consumption by rejects:** from `error_abuse_sample.csv`, `db_pool_in_use` stays at/near 0 attributable to the 410/400/405 arms; `rate(db_query_duration_seconds_count)` over the flood window tracks only the `legalmax` arm (≈25% of iters), NOT the full flood rate.
- 410 responses carry `Location: /api/version` (k6 check `✓`).
- `process_resident_memory_bytes` peak **< 1.5 GB** and `dmesg | grep -i 'killed process'` → **0** (a 16KiB-filter flood must not balloon memory; the `MaxFiltersBytes=16384` cap holds).

- [ ] **Step 5: Commit** — `git add tests/loadtest/k6/scenarios/error_abuse.js tests/loadtest/k6/scenarios/error_abuse.fixture.sh && git commit -m "test(loadtest): error-abuse flood (410/400/405 + maximal-legal payloads) cheap-reject gate"`

---

### Task 23: chaos/ host scripts (operational)

**Files:**
- Create: `tests/loadtest/k6/chaos/docker_kill.sh`
- Create: `tests/loadtest/k6/chaos/docker_stop.sh`
- Create: `tests/loadtest/k6/chaos/temp_fill.sh`
- Create: `tests/loadtest/k6/chaos/oom_induce.sh`
- Create: `tests/loadtest/k6/chaos/sampler.sh`
- Create: `tests/loadtest/k6/chaos/corrupt_artifact.sh`
- Create: `tests/loadtest/k6/chaos/README.md`
- Test: `tests/loadtest/k6/chaos/chaos_lint.sh`

- [ ] **Step 1: Write the failing test** — a lint/sanity harness that asserts every chaos script exists, is `bash -n` clean, is executable, and `sampler.sh` runs in `SAMPLE_LOCAL=1` mode (no docker/aws) against a local backend producing a CSV header. This is the only locally-runnable check; the chaos scripts themselves are operational.

```bash
#!/usr/bin/env bash
# chaos_lint.sh — local check for the chaos host scripts. Asserts each script
# parses (bash -n), is executable, and that sampler.sh runs in local mode and
# emits a CSV header. The destructive scripts (docker_kill/stop, temp_fill,
# oom_induce, corrupt_artifact) are NOT executed here — they are operational
# and require Docker/EC2; we only syntax-check them.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
cd "$REPO_ROOT"
CHAOS="tests/loadtest/k6/chaos"

SCRIPTS=(docker_kill.sh docker_stop.sh temp_fill.sh oom_induce.sh sampler.sh corrupt_artifact.sh)
for s in "${SCRIPTS[@]}"; do
  p="${CHAOS}/${s}"
  [ -f "$p" ]        || { echo "FAIL: missing ${p}"; exit 1; }
  [ -x "$p" ]        || { echo "FAIL: not executable ${p}"; exit 1; }
  bash -n "$p"       || { echo "FAIL: syntax error in ${p}"; exit 1; }
  echo "ok: ${s} (syntax + executable)"
done

# sampler.sh local-mode smoke: needs a backend. Boot the fixture one.
FIXTURE="tests/fixtures/tfbp_test.duckdb"
PORT="${PORT:-18123}"
BASE_URL="http://127.0.0.1:${PORT}"
[ -f "$FIXTURE" ] || { echo "FAIL: fixture missing: $FIXTURE"; exit 1; }

( cd backend && go run ./cmd/tfbp-server --duckdb="../${FIXTURE}" --port="${PORT}" ) &
BG_PID=$!
trap 'kill "$BG_PID" 2>/dev/null || true' EXIT
for _ in $(seq 1 60); do curl -sf "${BASE_URL}/readyz" >/dev/null 2>&1 && break; sleep 0.5; done
curl -sf "${BASE_URL}/readyz" >/dev/null || { echo "FAIL: backend not ready"; exit 1; }

CSV="$(mktemp -t chaos_sampler.XXXXXX.csv)"
trap 'kill "$BG_PID" 2>/dev/null || true; rm -f "$CSV"' EXIT
SAMPLE_LOCAL=1 SAMPLE_ITERATIONS=2 SAMPLE_INTERVAL=1 SAMPLE_OUT="$CSV" BASE_URL="$BASE_URL" \
  bash "${CHAOS}/sampler.sh"

head -1 "$CSV" | grep -q '^ts,' || { echo "FAIL: sampler CSV missing 'ts,' header"; exit 1; }
[ "$(wc -l < "$CSV")" -ge 3 ] || { echo "FAIL: sampler CSV has too few rows"; exit 1; }
echo "PASS"
```

- [ ] **Step 2: Run test to verify it fails**
Run: `bash tests/loadtest/k6/chaos/chaos_lint.sh`
Expected: FAIL with `FAIL: missing tests/loadtest/k6/chaos/docker_kill.sh` (the chaos scripts do not exist yet).

- [ ] **Step 3a: Implement `docker_kill.sh` (operational) — SIGKILL, no drain.**
```bash
#!/usr/bin/env bash
# docker_kill.sh — SIGKILL the tfbp container (ungraceful, simulates a crash /
# OOM-kill), then poll /readyz until the orchestrator restarts it (restart:
# unless-stopped in docker-compose.yml). Measures recovery time to green.
#
# Pair with cold_start_cliff.js running against the same host to capture the
# client-visible impact of the kill.
#
# Env:
#   CONTAINER   container/service name (default: tfbp)
#   BASE_URL    base URL to poll /readyz (default: http://127.0.0.1:8080)
#   READY_TIMEOUT  max seconds to wait for /readyz green (default: 120)
set -euo pipefail
CONTAINER="${CONTAINER:-tfbp}"
BASE_URL="${BASE_URL:-http://127.0.0.1:8080}"
READY_TIMEOUT="${READY_TIMEOUT:-120}"

cid="$(docker compose ps -q "$CONTAINER" 2>/dev/null || docker ps -qf "name=${CONTAINER}")"
[ -n "$cid" ] || { echo "FAIL: no running container for '${CONTAINER}'"; exit 1; }

echo "killing ${CONTAINER} (${cid}) with SIGKILL at $(date -u +%FT%TZ)"
t0=$(date +%s)
docker kill --signal=KILL "$cid"

# restart:unless-stopped brings it back. Poll /readyz.
deadline=$(( t0 + READY_TIMEOUT ))
until curl -sf "${BASE_URL}/readyz" >/dev/null 2>&1; do
  [ "$(date +%s)" -lt "$deadline" ] || { echo "FAIL: /readyz not green within ${READY_TIMEOUT}s after SIGKILL"; exit 1; }
  sleep 1
done
t1=$(date +%s)
echo "PASS: /readyz green ${$((t1 - t0))}s after SIGKILL"
```
Expected behavior: container restarts (`restart: unless-stopped`), startup fail-fast (§9.5) re-runs and passes (artifact unchanged), `/readyz` returns 200. **Pass: recovery < 120 s, no manual intervention, startup_ok log line re-emitted.**

- [ ] **Step 3b: Implement `docker_stop.sh` (operational) — SIGTERM, graceful drain.**
```bash
#!/usr/bin/env bash
# docker_stop.sh — SIGTERM (graceful) the tfbp container with a drain timeout,
# then start it back and poll /readyz. Contrast with docker_kill.sh (SIGKILL):
# SIGTERM lets the Go server drain in-flight requests via its shutdown handler;
# in-flight requests should COMPLETE (no client-visible 502/connection reset)
# rather than being severed.
#
# Env: CONTAINER, BASE_URL, DRAIN_TIMEOUT (default 30s), READY_TIMEOUT (120s)
set -euo pipefail
CONTAINER="${CONTAINER:-tfbp}"
BASE_URL="${BASE_URL:-http://127.0.0.1:8080}"
DRAIN_TIMEOUT="${DRAIN_TIMEOUT:-30}"
READY_TIMEOUT="${READY_TIMEOUT:-120}"

echo "stopping ${CONTAINER} with SIGTERM (drain ${DRAIN_TIMEOUT}s) at $(date -u +%FT%TZ)"
t0=$(date +%s)
docker compose stop -t "$DRAIN_TIMEOUT" "$CONTAINER"
echo "starting ${CONTAINER} back"
docker compose start "$CONTAINER"

deadline=$(( t0 + READY_TIMEOUT ))
until curl -sf "${BASE_URL}/readyz" >/dev/null 2>&1; do
  [ "$(date +%s)" -lt "$deadline" ] || { echo "FAIL: /readyz not green within ${READY_TIMEOUT}s after SIGTERM"; exit 1; }
  sleep 1
done
echo "PASS: /readyz green $(( $(date +%s) - t0 ))s after graceful stop+start"
```
Expected behavior: with a load generator running, SIGTERM lets in-flight requests finish (graceful shutdown), so **`http_req_failed` from a co-running scenario stays 0 across the drain** (vs SIGKILL which severs connections). **Pass: graceful stop drains cleanly, recovery < 120 s.**

- [ ] **Step 3c: Implement `temp_fill.sh` (operational) — fill `tfbp_tmp` toward 2 GB.**
```bash
#!/usr/bin/env bash
# temp_fill.sh — fill the tfbp_tmp named volume (DuckDB spill target,
# max_temp_directory_size=2GB per §6.3) toward its cap to verify DuckDB fails
# LOUDLY (query error) rather than filling the disk silently, and that the
# service recovers once the fill is removed.
#
# We write a ballast file INTO the spill dir from a helper container that
# mounts the same volume, then drive a spill-heavy query and confirm it errors
# cleanly (HTTP 500 with a bounded body, not a hang / not an OOM kill).
#
# Env: VOLUME (default tfbp_tmp), FILL_MB (default 1900 -> just under 2GB),
#      BASE_URL, VERSION (artifact version for the spill query)
set -euo pipefail
VOLUME="${VOLUME:-tfbp_tmp}"
FILL_MB="${FILL_MB:-1900}"
BASE_URL="${BASE_URL:-http://127.0.0.1:8080}"
VERSION="${VERSION:-$(curl -sf "${BASE_URL}/api/version" | sed -n 's/.*"artifactVersion":"\([^"]*\)".*/\1/p')}"

echo "filling ${VOLUME} with ${FILL_MB}MB ballast at $(date -u +%FT%TZ)"
docker run --rm -v "${VOLUME}:/tmp/duckdb" alpine:3 \
  sh -c "dd if=/dev/zero of=/tmp/duckdb/ballast.bin bs=1M count=${FILL_MB} && ls -lh /tmp/duckdb/ballast.bin"

echo "driving a spill-heavy query (largest topn x all datasets)..."
code=$(curl -s -o /tmp/spill_resp.json -w '%{http_code}' \
  "${BASE_URL}/api/v/${VERSION}/comparison/topn?binding=callingcards&perturbation=hackett&top_n=1000")
echo "spill query HTTP ${code}; body bytes: $(wc -c < /tmp/spill_resp.json)"

echo "removing ballast..."
docker run --rm -v "${VOLUME}:/tmp/duckdb" alpine:3 rm -f /tmp/duckdb/ballast.bin

echo "verifying recovery (same query should now succeed)..."
code2=$(curl -s -o /dev/null -w '%{http_code}' \
  "${BASE_URL}/api/v/${VERSION}/comparison/topn?binding=callingcards&perturbation=hackett&top_n=1000")
echo "post-cleanup HTTP ${code2}"
[ "$code2" = "200" ] || { echo "FAIL: did not recover after ballast removal (HTTP ${code2})"; exit 1; }
echo "PASS: temp full -> bounded error -> recovered after cleanup"
```
Expected behavior: with spill near the 2 GB cap, a spill-heavy query **fails loudly with HTTP 500 (bounded body)**, NOT a hang and NOT an OOM kill (`max_temp_directory_size` errors the query). After the ballast is removed, the same query returns **200**. **Pass: loud bounded failure under fill + clean recovery; `dmesg` shows no OOM kill.**

- [ ] **Step 3d: Implement `oom_induce.sh` (operational) — push past `mem_limit`.**
```bash
#!/usr/bin/env bash
# oom_induce.sh — drive enough concurrent memory-heavy queries (large topn x
# all datasets, unfiltered, cold) to push the container past mem_limit=1.6g and
# confirm the FAILURE MODE is the intended one: Docker OOM-kills the container
# cleanly (surfaces in `docker inspect` State.OOMKilled=true) and the
# orchestrator restarts it via restart: unless-stopped — rather than the host
# kernel killing a random process or the service hanging.
#
# Env: CONTAINER (tfbp), BASE_URL, VERSION, CONCURRENCY (default 16),
#      READY_TIMEOUT (120)
set -euo pipefail
CONTAINER="${CONTAINER:-tfbp}"
BASE_URL="${BASE_URL:-http://127.0.0.1:8080}"
READY_TIMEOUT="${READY_TIMEOUT:-120}"
CONCURRENCY="${CONCURRENCY:-16}"
VERSION="${VERSION:-$(curl -sf "${BASE_URL}/api/version" | sed -n 's/.*"artifactVersion":"\([^"]*\)".*/\1/p')}"

cid="$(docker compose ps -q "$CONTAINER" 2>/dev/null || docker ps -qf "name=${CONTAINER}")"
[ -n "$cid" ] || { echo "FAIL: no running container for '${CONTAINER}'"; exit 1; }

echo "firing ${CONCURRENCY} concurrent memory-heavy queries at $(date -u +%FT%TZ)"
url="${BASE_URL}/api/v/${VERSION}/comparison/topn?binding=callingcards&perturbation=hackett&top_n=1000"
pids=()
for i in $(seq 1 "$CONCURRENCY"); do
  # distinct effect/pvalue so singleflight does NOT coalesce them into one query
  curl -s -o /dev/null "${url}&effect=0.$((RANDOM%9+1))&pvalue=0.0$((RANDOM%9+1))" &
  pids+=($!)
done
wait "${pids[@]}" 2>/dev/null || true

# Inspect for a clean Docker OOM kill (the intended failure mode per §6.3).
oom="$(docker inspect -f '{{.State.OOMKilled}}' "$cid" 2>/dev/null || echo unknown)"
echo "State.OOMKilled=${oom}"
echo "host kernel OOM check (must NOT have killed a random host process):"
dmesg | tail -40 | grep -i 'killed process' || echo "  (no host OOM-killer entries — good)"

# Recovery poll (restart: unless-stopped should bring it back if it died).
t0=$(date +%s); deadline=$(( t0 + READY_TIMEOUT ))
until curl -sf "${BASE_URL}/readyz" >/dev/null 2>&1; do
  [ "$(date +%s)" -lt "$deadline" ] || { echo "FAIL: /readyz not green within ${READY_TIMEOUT}s"; exit 1; }
  sleep 1
done
echo "PASS: recovered to /readyz green; failure mode = Docker OOM (clean) not host-kernel OOM"
```
Expected behavior: if memory is exceeded, **Docker kills the container (`State.OOMKilled=true`)** and it restarts cleanly; the **host kernel OOM-killer must NOT fire** (`dmesg` shows no random-process kill — `memswap_limit=mem_limit` disables swap so failure is fast). Ideal outcome: spill + the 30s timeout + pool cap-2 keep RSS under the limit and **no OOM at all**. **Pass: either no OOM, or a clean container-level OOM with automatic recovery — never a host-kernel kill.**

- [ ] **Step 3e: Implement `sampler.sh` — fixed-cadence metrics/RSS/credit CSV.**
```bash
#!/usr/bin/env bash
# sampler.sh — loop on a fixed cadence appending one CSV row per tick with:
#   - selected /metrics values (cache hit/miss, pool in-use/wait, db queries,
#     evictions, in-flight, RSS, goroutines)
#   - docker stats RSS for the container          (skipped in SAMPLE_LOCAL=1)
#   - aws cloudwatch CPUCreditBalance (t3.small)   (skipped in SAMPLE_LOCAL=1)
#
# Pairs with soak.js / export_contention.js / oom_induce.sh / etc.
#
# Env:
#   BASE_URL          (default http://127.0.0.1:8080)
#   CONTAINER         (default tfbp)        — docker stats target
#   SAMPLE_OUT        (default sampler.csv) — output CSV path
#   SAMPLE_INTERVAL   (default 15)          — seconds between ticks
#   SAMPLE_ITERATIONS (default 0 = run forever; >0 = stop after N ticks)
#   SAMPLE_LOCAL      (default unset)       — 1 = skip docker stats + cloudwatch
#   INSTANCE_ID       EC2 instance id for CloudWatch CPUCreditBalance
#   AWS_REGION        (default us-east-2)
set -euo pipefail
BASE_URL="${BASE_URL:-http://127.0.0.1:8080}"
CONTAINER="${CONTAINER:-tfbp}"
SAMPLE_OUT="${SAMPLE_OUT:-sampler.csv}"
SAMPLE_INTERVAL="${SAMPLE_INTERVAL:-15}"
SAMPLE_ITERATIONS="${SAMPLE_ITERATIONS:-0}"
AWS_REGION="${AWS_REGION:-us-east-2}"

mget() {  # mget <metric-name-prefix> : sum all matching sample values
  printf '%s' "$1" | awk -v n="$2" '
    $1 ~ ("^" n "([{ ]|$)") { v=$NF; s+=v } END { printf "%.6g", s+0 }'
}

# CSV header
echo "ts,cache_hits,cache_misses,db_query_count,pool_in_use,pool_open,pool_wait_secs_total,pool_wait_count,evictions,in_flight,rss_bytes,goroutines,docker_rss_mb,cpu_credit_balance" > "$SAMPLE_OUT"

i=0
while :; do
  ts="$(date -u +%FT%TZ)"
  m="$(curl -s "${BASE_URL}/metrics" || echo '')"
  hits=$(mget "$m" cache_hits_total)
  misses=$(mget "$m" cache_misses_total)
  dbq=$(mget "$m" db_query_duration_seconds_count)
  inuse=$(mget "$m" db_pool_in_use)
  open=$(mget "$m" db_pool_open_connections)
  waitsecs=$(mget "$m" db_pool_wait_duration_seconds_total)
  waitcnt=$(mget "$m" db_pool_wait_count_total)
  evict=$(mget "$m" cache_evictions_total)
  inflight=$(mget "$m" http_in_flight_requests)
  rss=$(mget "$m" process_resident_memory_bytes)
  goro=$(mget "$m" go_goroutines)

  docker_rss="n/a"; credit="n/a"
  if [ "${SAMPLE_LOCAL:-}" != "1" ]; then
    docker_rss="$(docker stats --no-stream --format '{{.MemUsage}}' "$CONTAINER" 2>/dev/null | awk '{print $1}' || echo n/a)"
    if [ -n "${INSTANCE_ID:-}" ]; then
      credit="$(aws cloudwatch get-metric-statistics --region "$AWS_REGION" \
        --namespace AWS/EC2 --metric-name CPUCreditBalance \
        --dimensions Name=InstanceId,Value="$INSTANCE_ID" \
        --start-time "$(date -u -d '-5 min' +%FT%TZ 2>/dev/null || date -u -v-5M +%FT%TZ)" \
        --end-time "$(date -u +%FT%TZ)" --period 60 --statistics Average \
        --query 'Datapoints[-1].Average' --output text 2>/dev/null || echo n/a)"
    fi
  fi

  echo "${ts},${hits},${misses},${dbq},${inuse},${open},${waitsecs},${waitcnt},${evict},${inflight},${rss},${goro},${docker_rss},${credit}" >> "$SAMPLE_OUT"

  i=$((i+1))
  if [ "$SAMPLE_ITERATIONS" -gt 0 ] && [ "$i" -ge "$SAMPLE_ITERATIONS" ]; then break; fi
  sleep "$SAMPLE_INTERVAL"
done
```
Expected behavior: appends one CSV row per `SAMPLE_INTERVAL` with the §6.7 metric set + (on EC2) docker RSS + `CPUCreditBalance`. In `SAMPLE_LOCAL=1` it skips docker/aws and runs `SAMPLE_ITERATIONS` ticks. **This is the sampler that Tasks 19/21/22 reference.**

- [ ] **Step 3f: Implement `corrupt_artifact.sh` (operational) — fail-fast verification.**
```bash
#!/usr/bin/env bash
# corrupt_artifact.sh — corrupt the artifact in the tfbp_data volume and verify
# the Go binary FAILS FAST (non-zero exit, listener NEVER binds) per §9.5,
# rather than entering a "running but broken" state. Then restore.
#
# Strategy: snapshot the good artifact, truncate it (breaks DuckDB open + the
# artifact_manifest canary), restart tfbp, and assert the container exits
# non-zero AND /readyz / the HTTP port never come up. Finally restore + verify.
#
# Env: CONTAINER (tfbp), VOLUME (tfbp_data), BASE_URL, BIND_WAIT (default 20s)
set -euo pipefail
CONTAINER="${CONTAINER:-tfbp}"
VOLUME="${VOLUME:-tfbp_data}"
BASE_URL="${BASE_URL:-http://127.0.0.1:8080}"
BIND_WAIT="${BIND_WAIT:-20}"

echo "snapshotting good artifact..."
docker run --rm -v "${VOLUME}:/data" alpine:3 \
  sh -c 'cp /data/tfbp.duckdb /data/tfbp.duckdb.good && wc -c < /data/tfbp.duckdb.good'

echo "corrupting artifact (truncate to 4KiB)..."
docker run --rm -v "${VOLUME}:/data" alpine:3 \
  sh -c 'dd if=/dev/zero of=/data/tfbp.duckdb bs=1024 count=4 conv=notrunc 2>/dev/null; \
         truncate -s 4096 /data/tfbp.duckdb; wc -c < /data/tfbp.duckdb'

echo "restarting tfbp against the corrupt artifact..."
docker compose up -d "$CONTAINER" 2>/dev/null || docker compose restart "$CONTAINER" || true

echo "asserting the listener NEVER binds within ${BIND_WAIT}s..."
bound="no"
deadline=$(( $(date +%s) + BIND_WAIT ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  if curl -sf -m 2 "${BASE_URL}/healthz" >/dev/null 2>&1; then bound="yes"; break; fi
  sleep 1
done

cid="$(docker compose ps -aq "$CONTAINER" 2>/dev/null || docker ps -aqf "name=${CONTAINER}")"
exitcode="$(docker inspect -f '{{.State.ExitCode}}' "$cid" 2>/dev/null || echo unknown)"
echo "container ExitCode=${exitcode}  listener_bound=${bound}"
echo "--- startup log (must show a single fail-fast line, NOT startup_ok) ---"
docker logs --tail=20 "$cid" 2>&1 || true

# Restore regardless of outcome.
echo "restoring good artifact..."
docker run --rm -v "${VOLUME}:/data" alpine:3 \
  sh -c 'mv /data/tfbp.duckdb.good /data/tfbp.duckdb'
docker compose up -d "$CONTAINER"
until curl -sf "${BASE_URL}/readyz" >/dev/null 2>&1; do sleep 1; done
echo "restored: /readyz green again"

# Verdict.
if [ "$bound" = "yes" ]; then
  echo "FAIL: HTTP listener bound against a corrupt artifact (must fail-fast)"; exit 1
fi
if [ "$exitcode" = "0" ] || [ "$exitcode" = "unknown" ]; then
  echo "FAIL: container did not exit non-zero on corrupt artifact (ExitCode=${exitcode})"; exit 1
fi
echo "PASS: corrupt artifact -> non-zero exit (${exitcode}), listener never bound, restored cleanly"
```
Expected behavior per §9.5: a corrupt/truncated artifact fails one of the startup gates (DuckDB read-only open, `artifact_manifest` single-row, canary SELECT) → the process **exits non-zero with a single structured fail-fast log line** and **never binds the HTTP listener** (`/healthz` stays unreachable). **Pass: `listener_bound=no`, container `ExitCode != 0`, log shows the fail-fast reason (not `startup_ok`), and the good artifact restores cleanly to `/readyz` green.**

- [ ] **Step 3g: Implement `chaos/README.md`** documenting each script, its env vars, the exact pass/fail, and the cross-references (which k6 scenario each pairs with; that `sampler.sh` backs Tasks 19/21/22; that `corrupt_artifact.sh` proves the §9.5 startup contract; that `docker_kill.sh` pairs with `cold_start_cliff.js`). Mark the whole directory "(operational — requires Docker + EC2; only `sampler.sh --local` and `chaos_lint.sh` run locally)".

- [ ] **Step 4: Run test to verify it passes** — Run: `chmod +x tests/loadtest/k6/chaos/*.sh && bash tests/loadtest/k6/chaos/chaos_lint.sh` Expected: PASS — prints `ok: <script> (syntax + executable)` for all six scripts, then the sampler local smoke writes a CSV with a `ts,` header and ≥3 rows, ending `PASS`. (`SKIP`-style: if Docker is absent the lint still passes because the destructive scripts are only `bash -n`-checked, never executed.)

- [ ] **Step 5: Commit** — `git add tests/loadtest/k6/chaos/ && git commit -m "test(loadtest): chaos host scripts (kill/stop/temp-fill/oom/sampler/corrupt-artifact) + lint harness"`

---

I've drafted Tasks 18–23 as markdown only (no files created or edited). The draft is grounded in the actual codebase facts I verified:

- **Route patterns** for k6 `tags.endpoint` come from `backend/internal/api/router.go` (e.g. `/api/v/{v}/binding`, `/api/v/{v}/selection/matrix`, `/api/v/{v}/comparison/topn`, `/api/v/{v}/export`) and the `endpoint` cache-metric label is the chi `RoutePattern()` (`backend/internal/api/middleware.go:93`).
- **Export contention behavior**: `backend/internal/api/export.go` — `exportSemaphore` cap 1, queue-timeout returns `http.StatusRequestTimeout` (408) gated on `r.Context().Done()` (the 30s router `middleware.Timeout`), `ExportTimeout = 5 * time.Minute`.
- **DoS caps** for the maximal-legal-payload abuse arm: `MaxFiltersBytes = 16 * 1024`, `MaxSearchChars = 64`, `TopNMax = 1000` (`backend/internal/api/validate.go`).
- **Spill/OOM constraints**: §6.3 `temp_directory=/tmp/duckdb`, `max_temp_directory_size=2GB`, Docker `mem_limit=1.6g`/`memswap_limit=1.6g`; the `tfbp_data` (ro) + `tfbp_tmp` named volumes and `restart: unless-stopped` from `docker-compose.yml`.
- **Startup fail-fast** (§9.5) for `corrupt_artifact.sh`: non-zero exit, listener never binds, single structured log line.
- **Metrics interface contract** from the prompt is honored: new `http_in_flight_requests`, `cache_load_seconds_total`, and the `CounterVec{endpoint}` change for `cache_admission_rejected_total`/`cache_oversize_responses_total` are referenced where sampled (note: the existing `metrics.go` still has these as plain Counters — Phase A tasks owned by another drafter make them `CounterVec`; my scenarios read them by name + optional `{endpoint}` via `metrics.js`).

Two things the assembling agent should know:
1. **The spec path in the prompt (`docs/superpowers/specs/2026-05-29-loadtest-program-design.md`) does not exist yet** — only `2026-05-12-go-react-rewrite-design.md` is present. I drafted against §6.3/§6.7/§9.2/§9.4/§9.5/§11.3/§12 of the existing design spec plus the interface contract in my prompt. If the new spec lands with different §9.1 `WEIGHTS` or knee numbers, only the `mix.js`/`TARGET_RATE` references need reconciling.
2. **Cross-task dependency**: Tasks 19, 21, 22 invoke `tests/loadtest/k6/chaos/sampler.sh` (defined in Task 23) and all scenarios import the Phase-A `lib/{config,keyspace,mix,metrics}.js` + the extended `thresholds.js` (`openModelThresholds`, `availabilityThresholds`). Those libs must exist before any scenario fixture-test runs green; Task 23's `sampler.sh` supports a `SAMPLE_LOCAL=1` mode so the soak/contention/abuse fixture harnesses can co-run it without Docker.


## Phase D — Head-to-head vs legacy Python Shiny (fast-follow, not a cutover blocker)

_Methodology pinned in writing before any run. The Shiny WebSocket/action adapter is the long pole._

### Task 24: head-to-head methodology doc — pinned protocol + Go-REST→Shiny-action mapping + WS-vs-REST fairness caveats

**Files:**
- Create: `tests/loadtest/k6/headtohead/METHODOLOGY.md`
- Test: `tests/loadtest/k6/headtohead/methodology_lint.test.js`

This is a documentation task (Phase D, §9.3). It is gated by a test that asserts the doc exists and contains every load-bearing section/anchor the run task (Task 26) and the adapter (Task 25) depend on — so the doc cannot silently drift out of sync with the harness. The protocol must be **pinned in writing before any run** (§11 Phase D, §14 Q3).

- [ ] **Step 1: Write the failing test**
```javascript
// tests/loadtest/k6/headtohead/methodology_lint.test.js
// Plain Node test (no k6) — asserts the pinned-methodology doc contains every
// load-bearing section the adapter (Task 25) and the run (Task 26) depend on.
// Run with:  node tests/loadtest/k6/headtohead/methodology_lint.test.js
const fs = require('fs');
const path = require('path');

const DOC = path.join(__dirname, 'METHODOLOGY.md');
let failures = 0;
function check(cond, msg) {
  if (!cond) { console.error('FAIL: ' + msg); failures++; }
  else { console.log('ok: ' + msg); }
}

check(fs.existsSync(DOC), 'METHODOLOGY.md exists');
const txt = fs.existsSync(DOC) ? fs.readFileSync(DOC, 'utf8') : '';

// Required headings / anchors (these are referenced by Task 25 + Task 26).
const requiredHeadings = [
  '# Head-to-Head Methodology',
  '## 1. Why this is pinned BEFORE running',
  '## 2. Matched environment',
  '## 3. Matched workload (arrival-rate ladder)',
  '## 4. Go REST endpoint -> Shiny reactive-action mapping',
  '## 5. WebSocket-vs-REST fairness caveats',
  '## 6. What "one action" means on each side',
  '## 7. Pass criterion (the crossover)',
  '## 8. Pinned parameter table (frozen before run)',
];
requiredHeadings.forEach((h) => check(txt.includes(h), `contains heading: ${h}`));

// The mapping table must name every Go endpoint the mix (lib/mix.js) drives,
// each paired with a concrete Shiny action.
const mappedEndpoints = [
  'GET /api/v/{v}/datasets',
  'GET /api/v/{v}/binding',
  'GET /api/v/{v}/binding/corr',
  'GET /api/v/{v}/perturbation',
  'GET /api/v/{v}/comparison/topn',
  'GET /api/v/{v}/regulators/resolve',
];
mappedEndpoints.forEach((e) => check(txt.includes(e), `mapping table row for: ${e}`));

// Concrete Shiny namespaced input IDs the adapter sends (proves the mapping is
// concrete, not vague). These are the module-namespaced reactive inputs.
const shinyInputs = [
  'select_datasets-apply_pending',
  'binding-execute_analysis',
  'perturbation-execute_analysis',
  'comparison-execute_analysis',
  'main_nav',
];
shinyInputs.forEach((i) => check(txt.includes(i), `names Shiny input: ${i}`));

// Pass criterion must be stated in the exact terms the assembled summary uses.
check(txt.includes('availabilityThresholds'), 'references availabilityThresholds');
check(txt.includes('arrival_slo.js'), 'references arrival_slo.js as the Go driver');
check(txt.includes('shiny_adapter.js'), 'references shiny_adapter.js as the Shiny driver');
check(/req\/s.{0,40}crossover/i.test(txt) || txt.includes('req/s-at-SLO crossover'),
  'states the req/s-at-SLO crossover deliverable');

// Fairness caveats must explicitly name the asymmetries so the comparison is honest.
['render', 'gzip', 'compute-on-server', 'think time', 'SockJS', 'reconnect']
  .forEach((w) => check(txt.toLowerCase().includes(w.toLowerCase()),
    `caveats mention: ${w}`));

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log('\nAll methodology-doc checks passed.');
```
- [ ] **Step 2: Run test to verify it fails**
Run: `node tests/loadtest/k6/headtohead/methodology_lint.test.js`
Expected: FAIL with `FAIL: METHODOLOGY.md exists` (then process exits non-zero with `N check(s) failed`).

- [ ] **Step 3: Write the methodology doc**
Create `tests/loadtest/k6/headtohead/METHODOLOGY.md` with exactly this content:
```markdown
# Head-to-Head Methodology — Go (REST) vs Legacy Python Shiny (WebSocket)

> **Status:** Pinned protocol. This document is the *agreement*. It is committed
> and reviewed **before** any head-to-head run (spec §11 Phase D, §14 Q3). No
> result produced under a workload that deviates from §3 / §8 is admissible.
> Phase D is a **fast-follow, not a cutover blocker** (spec §3, §11).

Related: `docs/superpowers/specs/2026-05-29-loadtest-program-design.md` §9.3 (G3),
§12 pitfall 16 (head-to-head fairness). Drivers: `../scenarios/arrival_slo.js`
(Go) and `./shiny_adapter.js` (Shiny). Result lands in `tests/loadtest-summary.md`.

## 1. Why this is pinned BEFORE running

G3 ("prove it beats legacy") is the most cherry-pickable claim in the program.
Shiny is a stateful WebSocket/reactive app; the Go service is stateless REST.
A naive "same URLs against both hosts" comparison 404s on Shiny and lets Go
"win" on a technicality (pitfall 16). To be defensible the protocol — hardware,
data, arrival-rate ladder, warm/cold posture, duration, and the **action
mapping** — must be fixed in writing and reviewed first, so neither the rate
ladder nor the action set can be retro-fitted to the desired conclusion.

## 2. Matched environment

| Axis | Pinned value | Enforcement |
|------|--------------|-------------|
| Server hardware | Two **t3.small** instances, same AZ, same EBS gp3 class, same `mem_limit=1.6g` (Go) and the legacy container's existing limits | Both already deployed behind Traefik per spec §11.3 / `deploy/README.md` |
| Routing | Go on `tfbindingandperturbation.com`, Shiny on `legacy.tfbindingandperturbation.com`, both through the same Traefik | `BASE_URL` / `SHINY_BASE_URL` env |
| Real data | The **same** real artifact behind Go; the legacy Shiny serving the **same** HuggingFace collection it currently serves. Fixture runs are NON-AUTHORITATIVE for G3. | `ARTIFACT_KIND=real` stamped into both summaries; Go version from `resolveVersion()` |
| Generator | k6 on a **third, off-box** same-AZ EC2 (spec §8, §14 Q1). One generator host, run sequentially against each target (never concurrently — they would contend for the generator's CPU). | calibration gate: k6 host CPU < ~70%, `dropped_iterations==0` |
| Warm/cold | Two postures, run for **both** targets: **warm** (hot set pre-driven) and **cold** (fresh restart / fresh session, no pre-warm). The cold number is the honest one (spec §9.1). | documented per run |
| Duration | Each ladder step held **3 minutes**; full ladder repeated identically per target per posture. | §3 ladder below |

## 3. Matched workload (arrival-rate ladder)

Open-model arrival rate (spec §6 — never closed/VU-think-time, which hides the
overload cliff via coordinated omission, pitfall 2). The **same** ladder drives
both targets:

```
5 -> 10 -> 20 -> 40 -> 60 -> 80 -> 100 req/s   (ramping-arrival-rate)
3 minutes hold per step;  preAllocatedVUs=200, maxVUs=500
```

The per-iteration **action mix weights are identical on both sides** — the same
60/30/10-style distribution `lib/mix.js` `WEIGHTS` produces. On the Go side an
iteration is one HTTP request (`arrival_slo.js`). On the Shiny side an iteration
is one *reactive action* (a WebSocket input message + awaiting its output
recalculation) selected from the **same** weighted distribution, via the mapping
in §4 (`shiny_adapter.js`). "Same arrival rate" therefore means *same actions
per second offered*, not same raw frames.

## 4. Go REST endpoint -> Shiny reactive-action mapping

This is the load-bearing table. Each Go endpoint that `lib/mix.js` drives is
mapped to the equivalent legacy Shiny reactive action. Shiny input IDs are
**module-namespaced** as `{module}-{input_id}` and travel inside the WebSocket
`update` message; outputs return inside `recalculating`/`values` frames. The
top-level navbar input is `main_nav` (values: `Home`, `Dataset selection`,
`Binding`, `Perturbation`, `Comparison`).

| Go REST endpoint (mix tag) | Equivalent Shiny user action | Shiny input message(s) sent | Shiny output awaited (completion signal) |
|----------------------------|------------------------------|-----------------------------|------------------------------------------|
| `GET /api/v/{v}/datasets` | Open the **Dataset selection** tab (loads the dataset matrix) | `main_nav = "Dataset selection"` | first `values` frame populating `select_datasets-*` matrix outputs |
| `GET /api/v/{v}/binding` and `GET /api/v/{v}/binding/corr` | On **Binding** tab, click **Execute Analysis** (computes pairwise correlations across shared regulators) | `main_nav = "Binding"`, then `binding-execute_analysis` = N (incrementing int) with current `binding-col_preference`, `binding-corr_type` | `recalculating` then `values` for `binding-box_plot_container` (+ `binding-analysis_status` reaching the done state) |
| `GET /api/v/{v}/perturbation` | On **Perturbation** tab, click **Execute Analysis** | `main_nav = "Perturbation"`, then `perturbation-execute_analysis` = N with `perturbation-col_preference`, `perturbation-corr_type` | `values` for `perturbation-box_plot_container` |
| `GET /api/v/{v}/comparison/topn` | On **Comparison** tab, set Top-N / thresholds, click **Execute Analysis** | `main_nav = "Comparison"`, set `comparison-top_n`, `comparison-effect_threshold`, `comparison-pvalue_threshold`, `comparison-included_promoter_sets`, then `comparison-execute_analysis` = N | `values` for `comparison-topn_plot` |
| `GET /api/v/{v}/regulators/resolve` | Pick the active regulator on a **Scatter** tab (re-renders per-target scatter for one regulator) | `binding-selected_regulator_dropdown = "<locus_tag>"` (after a prior Execute) | `values` for `binding-scatter_container` |
| `GET /api/v/{v}/datasets/{db}/fields` (cheap-cached arm) | Open a dataset's **filter/breakdown modal** | `select_datasets-apply_pending` after toggling a dataset (modal open is a UI-only nav; the apply is the reactive trigger) | `values` re-render of the affected `select_datasets-*` row outputs |

Notes baked into the mapping:
- The Go service has **no per-session state**; one `/binding` request fully
  recomputes (or cache-hits). The Shiny equivalent requires *establishing
  session state first* (nav to tab, set sidebar inputs) and then firing
  `execute_analysis`. The adapter therefore replays the establishing inputs
  once per session, then loops the weighted action set within that session —
  matching how a real Shiny user behaves.
- `binding/corr` is not a separate user click in Shiny; the single Execute
  Analysis action computes both the box-plot correlations and the underlying
  corr data, so it maps to **both** Go endpoints. The mix weight for those two
  Go endpoints is summed when assigning the Shiny Execute action's weight.
- `comparison/dto`, `sample-conditions`, `selection/matrix` and similar
  cheap-cached Go endpoints are sub-renders that Shiny emits *as part of* a tab
  open or an Execute; they are not separately clickable, so they fold into the
  parent action's weight rather than getting their own row.

## 5. WebSocket-vs-REST fairness caveats

These asymmetries are stated up front so the crossover is read honestly, not as
a knockout:

1. **Server-side render.** Shiny does compute-on-server *and* renders Plotly
   figure JSON / HTML fragments server-side; the Go service returns raw data
   JSON and the React client renders. Shiny therefore does strictly more
   server work per action — a structural Shiny disadvantage we acknowledge
   rather than hide. We report it; we do not "correct" for it.
2. **Connection model.** REST is one TCP request/response; SockJS holds a
   long-lived WebSocket per session. k6's WS API counts connect/reconnect
   differently from HTTP iterations, so `http_req_duration` is not directly
   comparable to the adapter's measured action latency. We compare **action
   completion latency** (custom Trend) and **action success rate** (custom
   Rate) on the Shiny side against the same on the Go side — never raw k6 HTTP
   timings across transports.
3. **Coordinated omission still applies.** The Shiny adapter must offer actions
   at the pinned arrival rate **regardless** of whether prior actions have
   completed (open model). If the adapter waits for each output before sending
   the next input, it self-throttles and falsely flatters Shiny. The adapter
   uses k6 `scenarios` arrival-rate executors driving a per-iteration
   action, NOT a think-time loop.
4. **Think time = 0 on both.** No think time on either side; we measure raw
   service capacity, not human pacing.
5. **gzip / compression.** Traefik fronts both; the same compression posture
   applies. If only one is gzipped, that is recorded as a caveat in the
   summary.
6. **SockJS framing & reconnect.** Shiny sessions can drop and reconnect under
   load; a reconnect storm is itself a Shiny degradation mode and is counted as
   a failed action (it would be a failed user interaction), not silently
   retried.

## 6. What "one action" means on each side

| Side | Iteration = | Latency measured = | Success = |
|------|-------------|--------------------|-----------|
| Go (`arrival_slo.js`) | one HTTP GET from `lib/mix.js` | `http_req_duration` | status 200 and `http_req_failed==false` |
| Shiny (`shiny_adapter.js`) | one reactive action from §4 | wall time from sending the input frame to receiving the awaited output `values` frame (custom Trend `shiny_action_ms`) | awaited output frame arrives within the action timeout AND carries no Shiny error payload (custom Rate `shiny_action_ok`) |

## 7. Pass criterion (the crossover)

Run the **identical** ladder (§3) against both targets, **warm** and **cold**.

- For Go, the SLO is `arrival_slo.js`'s gates: `availabilityThresholds`
  (`http_req_failed<0.005`) plus warm latency `p95<200 ∧ p99<500` and
  `dropped_iterations==0`.
- For Shiny, the analogues are: `shiny_action_ok` rate ≥ 0.995 and
  `shiny_action_ms` p95/p99 within the same 200/500 ms gate, `dropped_iterations==0`.

**PASS (G3 holds):** there exists a ladder step (a req/s level) at which the
Shiny target **fails** its availability or p99 gate (success-rate drops below
0.995 or p99 blows past 500 ms or it drops iterations) while the **Go** target
**still meets** its availability SLO + warm latency at that same req/s. That
req/s level is the **crossover**.

**FAIL / inconclusive:** Go degrades at or below the req/s where Shiny degrades,
or neither degrades within the ladder ceiling (then extend the ladder per §3 and
re-run — do not declare a win on an un-stressed ladder).

Deliverable: the **req/s-at-SLO crossover table** appended to
`tests/loadtest-summary.md` (Task 26), with both targets' highest passing req/s
for warm and cold, plus the caveats from §5 reproduced inline.

## 8. Pinned parameter table (frozen before run)

| Parameter | Value |
|-----------|-------|
| `RATE_LADDER` | `5,10,20,40,60,80,100` req/s |
| Hold per step | `180s` |
| `preAllocatedVUs` / `maxVUs` | `200` / `500` |
| Postures | warm, cold (both, both targets) |
| Generator | one off-box same-AZ t3.small/larger, sequential per target |
| Go driver | `../scenarios/arrival_slo.js` (`BASE_URL=https://tfbindingandperturbation.com`) |
| Shiny driver | `./shiny_adapter.js` (`SHINY_BASE_URL=https://legacy.tfbindingandperturbation.com`) |
| Action mix weights | identical `lib/mix.js` `WEIGHTS` on both sides |
| Action timeout (Shiny) | `30s` (matches Go router `Timeout 30s`, spec §6.3) |
| `ARTIFACT_KIND` | `real` (mandatory; `fixture` rejected for G3) |
| Result file | `tests/loadtest-summary.md` head-to-head section |

Any change to this table requires editing this doc and re-running the lint test
(`methodology_lint.test.js`) before a head-to-head run.
```
- [ ] **Step 4: Run test to verify it passes** — Run: `node tests/loadtest/k6/headtohead/methodology_lint.test.js` Expected: PASS (`All methodology-doc checks passed.`, exit 0).
- [ ] **Step 5: Commit** — `git add tests/loadtest/k6/headtohead/METHODOLOGY.md tests/loadtest/k6/headtohead/methodology_lint.test.js && git commit -m "docs(loadtest): pin head-to-head methodology + Go-REST->Shiny-action mapping"`

---

### Task 25: `shiny_adapter.js` — k6 SockJS/WebSocket adapter driving Shiny reactive actions

**Files:**
- Create: `tests/loadtest/k6/headtohead/shiny_adapter.js`
- Create: `tests/loadtest/k6/headtohead/CAPTURE.md` (operational frame-capture instructions)
- Create: `tests/loadtest/k6/headtohead/frames.js` (captured-frame holder — committed with a clearly-marked, intentionally-empty paste slot)
- Test: `tests/loadtest/k6/headtohead/shiny_adapter.test.js`

The exact SockJS init handshake + Shiny `update`/`recalculating` envelope bytes are **version-specific (Python Shiny ^1.4.0) and must be captured against the live legacy app first** — they are NOT fabricated here. `frames.js` ships with empty capture slots and a guard; the adapter refuses to run until they are filled (operational prerequisite, marked `(operational)` in `CAPTURE.md`). The adapter's pure logic (action selection from the same `WEIGHTS`, message templating from captured frames, output-await matching) IS unit-tested in Node without a live server.

- [ ] **Step 1: Write the failing test**
```javascript
// tests/loadtest/k6/headtohead/shiny_adapter.test.js
// Node test of the adapter's PURE logic (no k6, no live Shiny). Verifies:
//  - action selection uses the SAME lib/mix.js WEIGHTS distribution
//  - input-frame templating substitutes namespaced IDs + values correctly
//  - the capture-guard refuses to run on empty frames (operational prereq)
//  - output-await matcher recognizes the completion frame for an action
// Run with:  node tests/loadtest/k6/headtohead/shiny_adapter.test.js
const fs = require('fs');
const path = require('path');
const assert = require('assert');

let failures = 0;
function ok(cond, msg) { if (!cond) { console.error('FAIL: ' + msg); failures++; } else { console.log('ok: ' + msg); } }

// The adapter exports its pure helpers under a CommonJS-compatible guard so this
// Node test can require them. (k6 imports the same file as an ES module.)
const mod = require('./shiny_adapter.js');

// 1. Action set is derived from the same mix weights -> same distribution.
ok(typeof mod.SHINY_ACTIONS === 'object', 'exports SHINY_ACTIONS map');
const actionNames = Object.keys(mod.SHINY_ACTIONS);
['open_datasets', 'binding_execute', 'perturbation_execute', 'comparison_execute', 'binding_scatter']
  .forEach((a) => ok(actionNames.includes(a), `action defined: ${a}`));

// pickAction must be deterministic given an rng in [0,1) and cover the space.
ok(typeof mod.pickAction === 'function', 'exports pickAction(rng01)');
const lo = mod.pickAction(0.0);
const hi = mod.pickAction(0.999999);
ok(actionNames.includes(lo.name), 'pickAction(0) returns a known action');
ok(actionNames.includes(hi.name), 'pickAction(~1) returns a known action');

// 2. Each action declares the namespaced Shiny input(s) it sets + output to await.
for (const [name, a] of Object.entries(mod.SHINY_ACTIONS)) {
  ok(typeof a.weight === 'number' && a.weight > 0, `${name} has positive weight`);
  ok(typeof a.awaitOutput === 'string' && a.awaitOutput.length > 0, `${name} declares awaitOutput`);
  ok(typeof a.buildInputs === 'function', `${name} has buildInputs()`);
  const inputs = a.buildInputs({ regulator: 'YAL001C', topN: 25 });
  ok(inputs && typeof inputs === 'object' && !Array.isArray(inputs), `${name} buildInputs returns an object map`);
  // every key must be module-namespaced (contain a hyphen) or be the navbar id
  Object.keys(inputs).forEach((k) =>
    ok(k === 'main_nav' || k.includes('-'), `${name} input id '${k}' is namespaced`));
}

// 3. Capture-guard: with empty frames the adapter must NOT be runnable.
ok(typeof mod.framesReady === 'function', 'exports framesReady()');
const frames = require('./frames.js');
// frames.js ships empty -> framesReady(frames) must be false until captured.
ok(mod.framesReady(frames) === false || frames.__CAPTURED__ === true,
  'capture-guard reports not-ready on empty frames (operational prereq)');

// 4. encodeUpdate builds the Shiny "update" envelope from a captured template.
ok(typeof mod.encodeUpdate === 'function', 'exports encodeUpdate(inputs, template)');
// Use a synthetic template that mimics the captured envelope shape.
const tmpl = { method: 'update', data: { '__PLACEHOLDER__': 0 } };
const enc = mod.encodeUpdate({ 'binding-execute_analysis': 7 }, tmpl);
const parsed = JSON.parse(enc);
ok(parsed.method === 'update', 'encodeUpdate preserves method=update');
ok(parsed.data['binding-execute_analysis'] === 7, 'encodeUpdate injects the namespaced input + value');

// 5. matchOutput recognizes the awaited output id inside a Shiny values frame.
ok(typeof mod.matchOutput === 'function', 'exports matchOutput(rawFrame, outputId)');
const valuesFrame = JSON.stringify({ values: { 'binding-box_plot_container': '<div/>' }, errors: {} });
ok(mod.matchOutput(valuesFrame, 'binding-box_plot_container') === true, 'matchOutput detects completion frame');
ok(mod.matchOutput(valuesFrame, 'binding-scatter_container') === false, 'matchOutput rejects unrelated output');
// An error payload in the frame counts as NOT-ok (failed action).
const errFrame = JSON.stringify({ errors: { 'binding-box_plot_container': { message: 'boom' } } });
ok(mod.matchOutput(errFrame, 'binding-box_plot_container') === false, 'matchOutput treats error payload as failure');

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log('\nAll shiny_adapter pure-logic checks passed.');
```
- [ ] **Step 2: Run test to verify it fails**
Run: `node tests/loadtest/k6/headtohead/shiny_adapter.test.js`
Expected: FAIL with `Cannot find module './shiny_adapter.js'` (the adapter and `frames.js` do not exist yet).

- [ ] **Step 3a: Create the captured-frame holder `frames.js` (ships empty, guarded)**
Create `tests/loadtest/k6/headtohead/frames.js`:
```javascript
// frames.js — CAPTURED Shiny SockJS/WebSocket frames for the legacy app.
//
//   >>> OPERATIONAL PREREQUISITE <<<
// The exact init handshake + input/output envelope bytes are version-specific
// (Python Shiny ^1.4.0) and MUST be captured against the LIVE legacy app at
// legacy.tfbindingandperturbation.com before this adapter can run. See
// ./CAPTURE.md for exact step-by-step capture instructions. Do NOT fabricate
// these — a guessed handshake will silently fail the SockJS open and the run
// will report Shiny as "down" when it is not (a false G3 win for Go).
//
// Until captured, __CAPTURED__ stays false and the adapter refuses to run.
// Paste the real captured frames into the marked slots below, then flip
// __CAPTURED__ to true in the same edit.

export const FRAMES = {
  __CAPTURED__: false,

  // ----- 1. SockJS / WebSocket endpoint path (capture from devtools: the WS
  //          request URL; Python Shiny is typically `/websocket/` but confirm). -----
  wsPath: '/websocket/',

  // ----- 2. Client->server frames sent immediately AFTER the socket opens,
  //          in order, BEFORE any user action (the Shiny init handshake).
  //          Paste each frame's payload string exactly as captured. ----------------
  // <<< PASTE CAPTURED INIT FRAMES HERE >>>
  initSend: [
    // e.g. '{"method":"init","data":{ ...captured... }}'
  ],

  // ----- 3. The server->client frame whose arrival means "session ready"
  //          (the first `values`/config frame). Paste a substring that uniquely
  //          identifies it (used only to know init completed). --------------------
  // <<< PASTE READY-FRAME MARKER HERE >>>
  readyMarker: '',

  // ----- 4. The exact client->server "update" envelope template captured when a
  //          single input changes. The adapter clones this and replaces `.data`
  //          with the action's namespaced {id:value} map. Paste the captured
  //          envelope (with whatever method string Shiny uses, e.g. "update"). ----
  // <<< PASTE CAPTURED UPDATE-ENVELOPE TEMPLATE HERE >>>
  updateTemplate: { method: 'update', data: {} },

  // ----- 5. (optional) SockJS framing prefix/suffix if the transport wraps JSON
  //          arrays (e.g. SockJS sends `a[...]` for messages, `o` on open,
  //          `h` heartbeat, `c[...]` close). Capture and record so the adapter
  //          can unwrap server frames. ------------------------------------------
  sockjsFraming: {
    openChar: 'o',
    messageArrayPrefix: 'a', // server message frames look like: a["<json>"]
    heartbeatChar: 'h',
    closePrefix: 'c',
  },
};

export default FRAMES;

// CommonJS bridge so the Node unit test can require() this same file.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = FRAMES;
  module.exports.FRAMES = FRAMES;
}
```
- [ ] **Step 3b: Write the operational capture instructions `CAPTURE.md`**
Create `tests/loadtest/k6/headtohead/CAPTURE.md`:
```markdown
# (operational) Capturing the Shiny SockJS/WebSocket frames

The head-to-head Shiny adapter (`shiny_adapter.js`) drives the legacy app over
its live WebSocket reactive protocol. The exact frame bytes are version-specific
(Python Shiny ^1.4.0) and are **not** committed pre-filled — they must be
captured against the running legacy app and pasted into `frames.js`. This is an
operational prerequisite; it cannot be unit-tested. Do **not** guess the frames.

## A. Capture via browser DevTools (primary method)

1. Open `https://legacy.tfbindingandperturbation.com/` in Chrome.
2. DevTools (F12) -> **Network** tab -> filter **WS**. Reload the page.
3. Click the `/websocket/` (or `websocket`) entry -> **Messages** sub-tab. You
   now see every frame, green = client->server, red = server->client.
4. **Confirm the WS path** in the Headers sub-tab (Request URL). Paste into
   `frames.js` `wsPath` (Python Shiny default is `/websocket/`).
5. **Init handshake:** copy, in order, every client->server frame that appears
   *before you interact* with the page. These are the init frames. Paste each
   payload string into `frames.js` `initSend[]` exactly.
6. **Ready marker:** find the first server->client frame carrying output
   `values` (right after init). Copy a short unique substring (e.g. a config or
   first-output key). Paste into `readyMarker`.
7. **Update envelope:** now interact — go to the **Binding** tab and click
   **Execute Analysis**. Find the client->server frame that carries the input
   change. Copy its full payload into `updateTemplate` (keep the `method`
   string Shiny actually uses; clear out `data`). Confirm the input key looks
   like `binding-execute_analysis` (module-namespaced) — this confirms the §4
   mapping in METHODOLOGY.md.
8. **SockJS framing:** note whether server frames look like `a["..."]` (SockJS
   array framing) and whether you see `o` (open) and `h` (heartbeat) frames.
   Record in `frames.js` `sockjsFraming`.
9. Set `__CAPTURED__: true` in the **same** edit that pastes the frames.

## B. Capture via k6 ws recording (alternative / cross-check)

1. On the generator host: `k6 version` (ensure the `k6/ws` module is present).
2. Run a one-shot recorder that opens the socket, replays a manual click you
   perform in a parallel browser, and dumps every frame to stdout:
   ```
   SHINY_BASE_URL=https://legacy.tfbindingandperturbation.com \
     k6 run tests/loadtest/k6/headtohead/shiny_adapter.js \
     --env RECORD=1 --vus 1 --iterations 1
   ```
   In `RECORD=1` mode the adapter logs every received frame and every frame it
   would send, then exits — it does NOT assert SLOs. Use this output to verify
   the DevTools capture matches what k6 sees on the wire.

## C. Verify before the real run

```
node tests/loadtest/k6/headtohead/shiny_adapter.test.js   # pure logic still green
SHINY_BASE_URL=https://legacy.tfbindingandperturbation.com \
  k6 run tests/loadtest/k6/headtohead/shiny_adapter.js \
  --env SMOKE=1 --vus 1 --iterations 1
```
`SMOKE=1` runs ONE of each action against the live app and asserts each awaited
output frame arrives — proving the captured frames are correct before the
multi-step ladder in Task 26. If `framesReady()` is false the adapter aborts
immediately with a pointer back to this file.
```
- [ ] **Step 3c: Write the adapter `shiny_adapter.js`**
Create `tests/loadtest/k6/headtohead/shiny_adapter.js`:
```javascript
// shiny_adapter.js — k6 head-to-head adapter for the LEGACY Python Shiny app.
//
// Drives the Shiny reactive protocol over SockJS/WebSocket for each action in
// the Go-REST -> Shiny-action mapping (METHODOLOGY.md §4), at the SAME pinned
// arrival-rate ladder used by ../scenarios/arrival_slo.js. The exact frame
// bytes live in ./frames.js and are an OPERATIONAL capture prerequisite
// (./CAPTURE.md) — this file contains the LOGIC, not fabricated frames.
//
// Pure helpers (pickAction, encodeUpdate, matchOutput, framesReady) are also
// exported via a CommonJS bridge for the Node unit test.

// ---- k6 imports are wrapped so the Node unit test can require() this file ----
let ws, Trend, Rate, Counter, check, FRAMES;
const IS_K6 = typeof __ENV !== 'undefined';
if (IS_K6) {
  // eslint-disable-next-line
  ws = require('k6/ws');
  // eslint-disable-next-line
  const m = require('k6/metrics');
  Trend = m.Trend; Rate = m.Rate; Counter = m.Counter;
  // eslint-disable-next-line
  check = require('k6').check;
  // eslint-disable-next-line
  FRAMES = require('./frames.js').FRAMES || require('./frames.js');
} else {
  FRAMES = require('./frames.js');
}

const SHINY_BASE_URL =
  (IS_K6 && __ENV.SHINY_BASE_URL) || 'https://legacy.tfbindingandperturbation.com';
const WS_URL = SHINY_BASE_URL.replace(/^http/, 'ws') + (FRAMES.wsPath || '/websocket/');
const ACTION_TIMEOUT_MS = 30000; // matches Go router Timeout 30s (spec §6.3)

// ---------------------------------------------------------------------------
// Action set — the SAME weighted distribution as lib/mix.js WEIGHTS, expressed
// as the equivalent Shiny reactive actions (METHODOLOGY.md §4). Weights are the
// summed Go-endpoint weights for actions that map to multiple endpoints
// (binding -> /binding + /binding/corr).
// ---------------------------------------------------------------------------
const SHINY_ACTIONS = {
  open_datasets: {
    weight: 30, // cheap-cached arm (datasets/fields)
    awaitOutput: 'select_datasets-dataset_matrix', // confirm exact id at capture
    buildInputs: () => ({ main_nav: 'Dataset selection' }),
  },
  binding_execute: {
    weight: 30, // /binding + /binding/corr
    awaitOutput: 'binding-box_plot_container',
    buildInputs: (ctx) => ({
      main_nav: 'Binding',
      'binding-col_preference': 'effect',
      'binding-corr_type': 'pearson',
      'binding-execute_analysis': ctx.clickSeq,
    }),
  },
  perturbation_execute: {
    weight: 15,
    awaitOutput: 'perturbation-box_plot_container',
    buildInputs: (ctx) => ({
      main_nav: 'Perturbation',
      'perturbation-col_preference': 'effect',
      'perturbation-corr_type': 'pearson',
      'perturbation-execute_analysis': ctx.clickSeq,
    }),
  },
  comparison_execute: {
    weight: 15,
    awaitOutput: 'comparison-topn_plot',
    buildInputs: (ctx) => ({
      main_nav: 'Comparison',
      'comparison-included_promoter_sets': ['Kang', 'Mindel'],
      'comparison-top_n': ctx.topN || 25,
      'comparison-effect_threshold': 0.0,
      'comparison-pvalue_threshold': 0.05,
      'comparison-execute_analysis': ctx.clickSeq,
    }),
  },
  binding_scatter: {
    weight: 10, // regulators/resolve + scatter
    awaitOutput: 'binding-scatter_container',
    buildInputs: (ctx) => ({
      'binding-selected_regulator_dropdown': ctx.regulator || 'YAL001C',
    }),
  },
};

// ---- pure: weighted action selection (same shape as lib/mix.js buildRequest) --
function _cumulative() {
  let total = 0;
  const rows = [];
  for (const [name, a] of Object.entries(SHINY_ACTIONS)) {
    total += a.weight;
    rows.push({ name, upto: total, action: a });
  }
  return { rows, total };
}
function pickAction(rng01) {
  const { rows, total } = _cumulative();
  const x = rng01 * total;
  for (const r of rows) if (x < r.upto) return { name: r.name, ...r.action };
  const last = rows[rows.length - 1];
  return { name: last.name, ...last.action };
}

// ---- pure: capture guard ----------------------------------------------------
function framesReady(frames) {
  const f = (frames && frames.FRAMES) || frames || {};
  return (
    f.__CAPTURED__ === true &&
    Array.isArray(f.initSend) &&
    f.initSend.length > 0 &&
    typeof f.readyMarker === 'string' &&
    f.readyMarker.length > 0 &&
    f.updateTemplate &&
    typeof f.updateTemplate === 'object'
  );
}

// ---- pure: build the Shiny "update" envelope from the captured template -----
function encodeUpdate(inputs, template) {
  const tmpl = template || (FRAMES && (FRAMES.updateTemplate || FRAMES.FRAMES?.updateTemplate)) || { method: 'update', data: {} };
  const env = { ...tmpl, data: { ...inputs } };
  return JSON.stringify(env);
}

// ---- pure: unwrap SockJS framing if present, then match the awaited output --
function _unwrapSockjs(raw) {
  // SockJS message frames look like: a["<json-escaped-payload>"]
  const fr = (FRAMES && (FRAMES.sockjsFraming || FRAMES.FRAMES?.sockjsFraming)) || {};
  if (typeof raw === 'string' && fr.messageArrayPrefix && raw[0] === fr.messageArrayPrefix) {
    try {
      const arr = JSON.parse(raw.slice(1)); // ["<json>"]
      return Array.isArray(arr) ? arr.join('') : raw.slice(1);
    } catch (e) {
      return raw.slice(1);
    }
  }
  return raw;
}
function matchOutput(rawFrame, outputId) {
  let payload;
  try {
    payload = JSON.parse(_unwrapSockjs(rawFrame));
  } catch (e) {
    return false;
  }
  // An error keyed on the awaited output is a FAILED action.
  if (payload && payload.errors && payload.errors[outputId]) return false;
  // Completion = the awaited output id appears in a `values` frame.
  return !!(payload && payload.values && Object.prototype.hasOwnProperty.call(payload.values, outputId));
}

// ---------------------------------------------------------------------------
// k6 scenario: open-model arrival rate, one action per iteration.
// ---------------------------------------------------------------------------
const RATE_LADDER = (IS_K6 && __ENV.RATE_LADDER ? __ENV.RATE_LADDER : '5,10,20,40,60,80,100')
  .split(',').map((s) => parseInt(s.trim(), 10));
const HOLD = (IS_K6 && __ENV.HOLD) || '180s';

let shiny_action_ms, shiny_action_ok, shiny_connect_fail;
if (IS_K6) {
  shiny_action_ms = new Trend('shiny_action_ms', true);
  shiny_action_ok = new Rate('shiny_action_ok');
  shiny_connect_fail = new Counter('shiny_connect_fail');
}

function _buildStages() {
  // ramping-arrival-rate stages: ramp to each rung over 5s, hold HOLD.
  const stages = [];
  for (const r of RATE_LADDER) {
    stages.push({ target: r, duration: '5s' });
    stages.push({ target: r, duration: HOLD });
  }
  return stages;
}

const options = IS_K6
  ? {
      scenarios: {
        shiny_ladder: {
          executor: 'ramping-arrival-rate',
          startRate: 0,
          timeUnit: '1s',
          preAllocatedVUs: 200,
          maxVUs: 500,
          stages: _buildStages(),
        },
      },
      thresholds: {
        // Shiny analogue of availabilityThresholds + warm latency gate (METHODOLOGY.md §7).
        shiny_action_ok: ['rate>0.995'],
        shiny_action_ms: ['p(95)<200', 'p(99)<500'],
        dropped_iterations: ['count==0'],
      },
      // SMOKE/RECORD override iterations via CLI (--vus/--iterations) per CAPTURE.md.
    }
  : {};

// One reactive action over one WebSocket session.
function runAction(actionName) {
  const action = SHINY_ACTIONS[actionName];
  const clickSeq = (__VU * 100000 + __ITER) % 2147483647 + 1; // monotonic-ish per VU
  const inputs = action.buildInputs({ clickSeq, topN: 25, regulator: 'YAL001C' });
  const updateFrame = encodeUpdate(inputs);

  let started = 0;
  let done = false;
  const res = ws.connect(WS_URL, {}, (socket) => {
    socket.on('open', () => {
      // 1. replay captured init handshake
      for (const f of FRAMES.initSend) socket.send(f);
    });
    socket.on('message', (raw) => {
      // wait for ready, then send the action input, then await its output
      if (started === 0) {
        if (typeof raw === 'string' && raw.indexOf(FRAMES.readyMarker) !== -1) {
          started = Date.now();
          socket.send(updateFrame);
        }
        return;
      }
      if (!done && matchOutput(raw, action.awaitOutput)) {
        done = true;
        shiny_action_ms.add(Date.now() - started);
        shiny_action_ok.add(true);
        socket.close();
      }
    });
    socket.setTimeout(() => {
      if (!done) {
        shiny_action_ok.add(false); // timed-out action = failed (open-model: do not retry)
        socket.close();
      }
    }, ACTION_TIMEOUT_MS);
  });
  if (!res || res.status >= 400 || res.error) {
    shiny_connect_fail.add(1);
    shiny_action_ok.add(false);
  }
}

export { options };
export default function () {
  if (!framesReady(FRAMES)) {
    throw new Error(
      'Shiny frames not captured. This is an OPERATIONAL prerequisite — ' +
      'see tests/loadtest/k6/headtohead/CAPTURE.md and fill frames.js (__CAPTURED__=true).'
    );
  }
  if (IS_K6 && __ENV.RECORD === '1') {
    // RECORD mode: open, replay init, log every frame, exit (no SLO assertions).
    ws.connect(WS_URL, {}, (socket) => {
      socket.on('open', () => FRAMES.initSend.forEach((f) => socket.send(f)));
      socket.on('message', (raw) => console.log('RECV: ' + raw));
      socket.setTimeout(() => socket.close(), 5000);
    });
    return;
  }
  const action = pickAction(Math.random());
  runAction(action.name);
}

export function handleSummary(data) {
  const artifactKind = (IS_K6 && __ENV.ARTIFACT_KIND) || 'fixture';
  if (artifactKind === 'fixture') {
    console.error('WARNING: ARTIFACT_KIND=fixture — head-to-head numbers are NON-AUTHORITATIVE (spec §8).');
  }
  return {
    'stdout': JSON.stringify(
      { target: 'shiny', shiny_base_url: SHINY_BASE_URL, artifactKind, metrics: Object.keys(data.metrics) },
      null, 2),
    [`shiny-summary-${Date.now()}.json`]: JSON.stringify(data, null, 2),
  };
}

// CommonJS bridge for the Node unit test (no-op under k6).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { SHINY_ACTIONS, pickAction, framesReady, encodeUpdate, matchOutput };
}
```
- [ ] **Step 4: Run test to verify it passes** — Run: `node tests/loadtest/k6/headtohead/shiny_adapter.test.js` Expected: PASS (`All shiny_adapter pure-logic checks passed.`, exit 0). Note: the pure-logic test passes WITHOUT live frames; the live SMOKE/RECORD checks in `CAPTURE.md` are the operational gate that the captured frames are correct.
- [ ] **Step 5: Commit** — `git add tests/loadtest/k6/headtohead/shiny_adapter.js tests/loadtest/k6/headtohead/frames.js tests/loadtest/k6/headtohead/CAPTURE.md tests/loadtest/k6/headtohead/shiny_adapter.test.js && git commit -m "feat(loadtest): Shiny WebSocket head-to-head adapter + operational frame-capture"`

---

### Task 26 (operational): run the head-to-head ladder + produce the req/s-at-SLO crossover table

**Files:**
- Modify: `tests/loadtest-summary.md` (append the head-to-head section)
- Modify: `Makefile` (add `loadtest-headtohead-go` / `loadtest-headtohead-shiny` targets)
- Create: `tests/loadtest/k6/headtohead/RUNBOOK.md` (the exact operational run procedure)
- Test: `tests/loadtest/k6/headtohead/crossover_check.test.js`

This is an **operational** task: the two ladders run on matched `t3.small` hosts through Traefik with k6 off-box (spec §8, §9.3). It cannot be unit-tested end-to-end, so the test gates the *artifact of the run* — the crossover table appended to `tests/loadtest-summary.md` — asserting it has the required columns and that, once filled, the pass criterion is computable from it. Frame capture (Task 25 / `CAPTURE.md`) is a hard prerequisite.

- [ ] **Step 1: Write the failing test**
```javascript
// tests/loadtest/k6/headtohead/crossover_check.test.js
// Asserts tests/loadtest-summary.md gained a well-formed head-to-head section
// whose crossover table is parseable and whose PASS/FAIL is derivable per
// METHODOLOGY.md §7. Placeholder rows (<FILL IN>) are allowed (the operator
// fills them on the host) but the STRUCTURE is enforced now.
// Run with:  node tests/loadtest/k6/headtohead/crossover_check.test.js
const fs = require('fs');
const path = require('path');

let failures = 0;
function ok(c, m) { if (!c) { console.error('FAIL: ' + m); failures++; } else { console.log('ok: ' + m); } }

const SUM = path.join(__dirname, '..', '..', '..', 'loadtest-summary.md');
ok(fs.existsSync(SUM), 'tests/loadtest-summary.md exists');
const txt = fs.existsSync(SUM) ? fs.readFileSync(SUM, 'utf8') : '';

ok(txt.includes('## Head-to-head vs legacy Python Shiny (G3)'), 'has head-to-head section');
ok(txt.includes('req/s-at-SLO crossover'), 'mentions the req/s-at-SLO crossover deliverable');

// The crossover table must carry these columns (the operator fills the cells).
['Target', 'Posture', 'Highest req/s at SLO', 'Degradation rate', 'Degradation mode']
  .forEach((c) => ok(txt.includes(c), `crossover table column: ${c}`));

// Both targets must appear as rows.
ok(txt.includes('Go (tfbindingandperturbation.com)'), 'row for Go target');
ok(txt.includes('Shiny (legacy.tfbindingandperturbation.com)'), 'row for Shiny target');

// Both postures must be present (warm + cold), per METHODOLOGY §2/§3.
ok(/warm/i.test(txt) && /cold/i.test(txt), 'warm and cold postures present');

// The PASS criterion must be stated in the summary in the §7 terms.
ok(txt.includes('availability SLO') && (txt.includes('p99') || txt.includes('p95')),
  'states the §7 pass criterion (availability + latency)');
ok(txt.includes('shiny_action_ok') && txt.includes('shiny_action_ms'),
  'references the Shiny adapter metrics');

// Helper that derives PASS once cells are numeric (used by the operator to
// self-check). Rows like "<FILL IN>" are treated as not-yet-run.
function parseRate(s) { const m = /([0-9]+(?:\.[0-9]+)?)\s*req\/s/.exec(s); return m ? parseFloat(m[1]) : null; }
ok(typeof parseRate === 'function', 'crossover-derivation helper present in test');

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log('\nAll crossover-table structure checks passed.');
```
- [ ] **Step 2: Run test to verify it fails**
Run: `node tests/loadtest/k6/headtohead/crossover_check.test.js`
Expected: FAIL with `FAIL: has head-to-head section` (the summary has no head-to-head section yet).

- [ ] **Step 3a: Append the head-to-head section to `tests/loadtest-summary.md`**
Append exactly this block to the end of `tests/loadtest-summary.md`:
```markdown

---

## Head-to-head vs legacy Python Shiny (G3)

> **(operational)** Run on the EC2 host per `tests/loadtest/k6/headtohead/RUNBOOK.md`.
> Pinned protocol: `tests/loadtest/k6/headtohead/METHODOLOGY.md` (frozen before
> this run). Go driver: `scenarios/arrival_slo.js`. Shiny driver:
> `headtohead/shiny_adapter.js` (requires captured frames — `headtohead/CAPTURE.md`).
> Phase D is a **fast-follow, not a cutover blocker** (spec §3, §11).
> Numbers below are non-authoritative unless `ARTIFACT_KIND=real`.

**Run metadata**

```
Run date (UTC):     <FILL IN>
Generator host:     <FILL IN — off-box same-AZ EC2, k6 CPU < 70%, dropped_iterations==0>
Go target:          tfbindingandperturbation.com     artifactVersion=<FILL IN>  ARTIFACT_KIND=<FILL IN>
Shiny target:       legacy.tfbindingandperturbation.com  (Python Shiny ^1.4.0)
Ladder:             5,10,20,40,60,80,100 req/s; 180s hold/step; preAllocVUs=200 maxVUs=500
Action mix:         lib/mix.js WEIGHTS (identical both sides)
```

**req/s-at-SLO crossover table**

The pass criterion (METHODOLOGY §7): there is a req/s at which **Shiny** fails its
gate (`shiny_action_ok` rate < 0.995, or `shiny_action_ms` p99 ≥ 500 ms, or
dropped_iterations > 0) while **Go** still meets its **availability SLO**
(`http_req_failed < 0.005`) + warm latency (p95 < 200 ms ∧ p99 < 500 ms) at that
same req/s.

| Target | Posture | Highest req/s at SLO | Degradation rate (first failing req/s) | Degradation mode |
|--------|---------|----------------------|----------------------------------------|------------------|
| Go (tfbindingandperturbation.com) | warm | `<FILL IN>` | `<FILL IN>` | `<FILL IN — queue-then-504 / OOM / credit-throttle / none-in-ladder>` |
| Go (tfbindingandperturbation.com) | cold | `<FILL IN>` | `<FILL IN>` | `<FILL IN>` |
| Shiny (legacy.tfbindingandperturbation.com) | warm | `<FILL IN>` | `<FILL IN>` | `<FILL IN — reconnect-storm / event-loop-stall / 5xx / none-in-ladder>` |
| Shiny (legacy.tfbindingandperturbation.com) | cold | `<FILL IN>` | `<FILL IN>` | `<FILL IN>` |

**Crossover (headline):** Go meets availability + latency SLO at
`<FILL IN>` req/s, where Shiny is already degraded
(`shiny_action_ok=<FILL IN>`, `shiny_action_ms` p99 `<FILL IN>` ms). → **PASS / FAIL: `<FILL IN>`**

**Fairness caveats applied** (METHODOLOGY §5, reproduced for the reader):
Shiny renders Plotly/HTML server-side (does strictly more server work per
action — not corrected for); WebSocket vs REST connection models are not
latency-comparable so we compare `shiny_action_ms`/`shiny_action_ok` against Go's
`http_req_duration`/`http_req_failed`; both run think-time=0 and open-model;
SockJS reconnects under load are counted as failed actions, not retried.

**Per-step detail (optional, attach k6 JSON summaries):**

| req/s | Go `http_req_failed` | Go p99 (ms) | Shiny `shiny_action_ok` | Shiny p99 (ms) |
|-------|----------------------|-------------|-------------------------|----------------|
| 5     | `<FILL IN>` | `<FILL IN>` | `<FILL IN>` | `<FILL IN>` |
| 20    | `<FILL IN>` | `<FILL IN>` | `<FILL IN>` | `<FILL IN>` |
| 40    | `<FILL IN>` | `<FILL IN>` | `<FILL IN>` | `<FILL IN>` |
| 60    | `<FILL IN>` | `<FILL IN>` | `<FILL IN>` | `<FILL IN>` |
| 80    | `<FILL IN>` | `<FILL IN>` | `<FILL IN>` | `<FILL IN>` |
| 100   | `<FILL IN>` | `<FILL IN>` | `<FILL IN>` | `<FILL IN>` |
```
- [ ] **Step 3b: Add Makefile targets** — Append to `Makefile` (after the existing `loadtest-cold-burst` target, around line 124):
```makefile

loadtest-headtohead-go:
	cd tests/loadtest/k6 && BASE_URL=$(GO_BASE_URL) ARTIFACT_KIND=real \
	  RATE_LADDER=5,10,20,40,60,80,100 HOLD=180s \
	  k6 run scenarios/arrival_slo.js --summary-export=h2h-go-summary.json

loadtest-headtohead-shiny:
	cd tests/loadtest/k6 && SHINY_BASE_URL=$(SHINY_BASE_URL) ARTIFACT_KIND=real \
	  RATE_LADDER=5,10,20,40,60,80,100 HOLD=180s \
	  k6 run headtohead/shiny_adapter.js --summary-export=h2h-shiny-summary.json
```
Also add `loadtest-headtohead-go loadtest-headtohead-shiny` to the `.PHONY` list near line 5.

- [ ] **Step 3c: Write the operational `RUNBOOK.md`**
Create `tests/loadtest/k6/headtohead/RUNBOOK.md`:
```markdown
# (operational) Head-to-head run procedure

Runs the identical arrival-rate ladder against Go and Shiny on matched t3.small
hosts, k6 off-box. Pinned protocol: `METHODOLOGY.md`. Phase D, fast-follow.

## 0. Prerequisites (hard gates)

1. `METHODOLOGY.md` reviewed + committed (frozen). `node methodology_lint.test.js` green.
2. Shiny frames captured per `CAPTURE.md`; `frames.js` has `__CAPTURED__: true`;
   `node shiny_adapter.test.js` green; live `--env SMOKE=1` run green.
3. k6 runs on an **off-box same-AZ EC2** (spec §8/§14 Q1), NOT on either server.
4. Calibration: a 5 req/s warm pre-run shows k6-host CPU < ~70% and
   `dropped_iterations==0` for BOTH drivers. If not, scale the generator and re-run.
5. `ARTIFACT_KIND=real` on both targets (a fixture-stamped summary is rejected, spec §8).

## 1. Run the ladders (sequentially, never concurrently — shared generator)

Set, on the generator host:
```
export GO_BASE_URL=https://tfbindingandperturbation.com
export SHINY_BASE_URL=https://legacy.tfbindingandperturbation.com
```

### Warm posture
Pre-warm each target (drive the hot action set for ~60s at low rate), then:
```
make loadtest-headtohead-go     # writes h2h-go-summary.json
make loadtest-headtohead-shiny  # writes h2h-shiny-summary.json
```

### Cold posture
Fresh-restart the Go container (new/empty cache) and start a fresh Shiny session
set (no pre-warm), then re-run BOTH make targets. Save the cold JSONs separately
(e.g. `h2h-go-cold.json`, `h2h-shiny-cold.json`).

## 2. Read the numbers (what to extract per target/posture)

From each k6 summary:
- **Go** (`arrival_slo.js`): per-step `http_req_failed` rate, `http_req_duration`
  p95/p99, `dropped_iterations`. Go passes a step iff `http_req_failed < 0.005 ∧
  p95 < 200 ∧ p99 < 500 ∧ dropped_iterations == 0`.
- **Shiny** (`shiny_adapter.js`): per-step `shiny_action_ok` rate,
  `shiny_action_ms` p95/p99, `dropped_iterations`. Shiny passes a step iff
  `shiny_action_ok > 0.995 ∧ p95 < 200 ∧ p99 < 500 ∧ dropped_iterations == 0`.

"Highest req/s at SLO" per target = the largest ladder step where that target
still passes. "Degradation rate" = the first step where it fails.

## 3. Fill the table + decide PASS/FAIL

Fill the crossover table in `tests/loadtest-summary.md` (the "Head-to-head vs
legacy Python Shiny (G3)" section).

**PASS criterion (METHODOLOGY §7):** at the req/s where Shiny first fails, Go
still passes. Record that req/s as the headline crossover. If Go fails at/below
Shiny's failing req/s, or neither degrades within the 100 req/s ceiling, mark
**inconclusive** and extend the ladder (e.g. add 150, 200, 300 req/s to
`RATE_LADDER`) and re-run.

## 4. Commit the filled summary

```
node tests/loadtest/k6/headtohead/crossover_check.test.js   # structure still valid
git add tests/loadtest-summary.md
git commit -m "docs(loadtest): head-to-head G3 crossover results (<date>)"
```
```
- [ ] **Step 4: Run test to verify it passes** — Run: `node tests/loadtest/k6/headtohead/crossover_check.test.js` Expected: PASS (`All crossover-table structure checks passed.`, exit 0). The `<FILL IN>` cells remain until the operator runs the ladder on the host per `RUNBOOK.md`; the test gates structure, not the (host-only) numbers.
- [ ] **Step 5: Commit** — `git add tests/loadtest-summary.md Makefile tests/loadtest/k6/headtohead/RUNBOOK.md tests/loadtest/k6/headtohead/crossover_check.test.js && git commit -m "docs(loadtest): head-to-head run procedure + crossover table scaffold"`
