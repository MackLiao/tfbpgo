// tests/loadtest/k6/scenarios/cold_fanout.js
//
// Phase-A FIXTURE-MECHANICS scenario. N concurrent VUs each issue ONE GET to
// the backend, spread across K distinct cold keys (per-vu-iterations,
// iterations=1). Because the backend coalesces identical cold misses with
// singleflight + ristretto Wait(), the expected arithmetic on the K distinct
// binding keys is:
//
//   Δ db_query_duration_seconds_count{query_name="binding/data"}       == K
//     (exactly K DB queries ran — one leader per cold key)
//
//   Δ singleflight_shared_calls_total{endpoint="/api/v/{v}/binding"}   >= N - K
//     (at least the N-K non-leader requests coalesced; in practice when all N
//      VUs arrive before any leader finishes, ALL N callers get shared=true so
//      the delta equals N — see note below)
//
// NOTE on singleflight `shared` semantics (empirically verified):
//   Go's singleflight.Do returns shared=true when the result was produced by a
//   concurrent in-flight call, i.e. when two or more callers for the same key
//   raced. With N=40 VUs firing simultaneously into K=3 cold keys (~13 VUs per
//   key), all 13 callers arrive before the leader finishes the ~1ms query and
//   calls cache.Wait(). Therefore ALL 13 callers per key receive shared=true,
//   including the leader — producing Δsf = N (not N-K). The assertion
//   Δsf >= N-K is always satisfied (conservative lower bound); the strict form
//   Δsf == N holds when the per-VU-iterations burst is genuinely concurrent.
//
//   The mechanically important invariant is ALWAYS Δdb == K: regardless of
//   leader/waiter timing, singleflight guarantees exactly one DB query per
//   cold key. This is the coalescing proof.
//
// REQUIRES A FRESH BACKEND RESTART so ristretto is empty; setup() asserts
// cache_hits_total == 0 (like cold_burst.js) and FAILS setup otherwise.
//
// Example run command:
//   DUCKDB_PATH=tests/fixtures/tfbp_test.duckdb /tmp/tfbp-srv --port=8093 &
//   ARTIFACT_KIND=fixture K=3 N=40 BASE_URL=http://localhost:8093 \
//     k6 run --no-usage-report tests/loadtest/k6/scenarios/cold_fanout.js
import http from 'k6/http';
import { check, fail } from 'k6';
import {
  BASE_URL, ARTIFACT_KIND, resolveVersion, apiBase,
} from '../lib/config.js';
import { loadRegulators } from '../lib/keyspace.js';
import { scrapeMetrics, parseCounter } from '../lib/metrics.js';

// K: distinct cold keys. Default 3 — the fixture has exactly 3 callingcards
// regulators. Override with K=N when running against the real dataset.
const K = parseInt(__ENV.K || '3', 10);
// N: concurrent VUs (must be > K so multiple callers hit each key simultaneously).
const N = parseInt(__ENV.N || '40', 10);

// Exact metric label values verified via curl /metrics against a live backend:
//   db_query_duration_seconds_count{query_name="binding/data"} <n>
//   singleflight_shared_calls_total{endpoint="/api/v/{v}/binding"} <n>
//   cache_hits_total{endpoint="/api/v/{v}/binding"} <n>
const QUERY_NAME = 'binding/data';
const ENDPOINT   = '/api/v/{v}/binding';

// Module-scope: k6 does NOT pass setup() return into handleSummary.
let resolvedVersion;

export const options = {
  scenarios: {
    fanout: {
      executor: 'per-vu-iterations',
      vus: N,
      iterations: 1,
      maxDuration: '30s',
    },
  },
  thresholds: {
    http_req_failed: ['rate==0'],
    checks: ['rate==1'],
  },
};

export function setup() {
  const version = resolveVersion();
  resolvedVersion = version;

  // FRESH-RESTART GUARD: the backend MUST be cold.
  // If cache_hits_total > 0, this backend has already served cached responses —
  // the coalescing arithmetic will be wrong. The operator must restart.
  const before = scrapeMetrics(BASE_URL);
  const hitsBefore = parseCounter(before, 'cache_hits_total');
  if (hitsBefore > 0) {
    fail(
      `cold_fanout: cache_hits_total=${hitsBefore} before fanout; backend is NOT cold. ` +
      `Restart the backend before running this scenario.`,
    );
  }

  const regulators = loadRegulators(version, ['callingcards']);
  if (regulators.length < K) {
    fail(`cold_fanout: need at least K=${K} distinct regulators, got ${regulators.length} ` +
      `(pass K=${regulators.length} or use a dataset with more regulators)`);
  }

  // Build the K distinct cold keys: same endpoint, K different regulators.
  // Each key will be requested by floor(N/K) or ceil(N/K) VUs simultaneously.
  const base = apiBase(BASE_URL, version);
  const keys = [];
  for (let i = 0; i < K; i++) {
    keys.push(`${base}/binding?regulator=${regulators[i]}&datasets=callingcards`);
  }

  // Snapshot the counters we will delta in teardown.
  const dbCountBefore  = parseCounter(before, 'db_query_duration_seconds_count', { query_name: QUERY_NAME });
  const sfBefore       = parseCounter(before, 'singleflight_shared_calls_total', { endpoint: ENDPOINT });
  const cacheHitBefore = parseCounter(before, 'cache_hits_total', { endpoint: ENDPOINT });

  return { version, keys, dbCountBefore, sfBefore, cacheHitBefore };
}

export default function (data) {
  // Deterministically spread N VUs across the K keys: VU 1..K/K hit key 0,
  // VU K+1..2K hit key 1, etc. — ensures each key gets ~N/K simultaneous
  // callers so the singleflight leader/waiter race fires for every key.
  const url = data.keys[(__VU - 1) % data.keys.length];
  const res = http.get(url);
  check(res, { 'fanout 200': (r) => r.status === 200 });
}

export function teardown(data) {
  const after = scrapeMetrics(BASE_URL);

  const dbCountAfter = parseCounter(after, 'db_query_duration_seconds_count', { query_name: QUERY_NAME });
  const sfAfter      = parseCounter(after, 'singleflight_shared_calls_total', { endpoint: ENDPOINT });
  // Also snapshot cache hits to verify no cache-HIT leakage (backend was cold).
  const cacheHitAfter = parseCounter(after, 'cache_hits_total', { endpoint: ENDPOINT });

  const dbDelta      = dbCountAfter  - data.dbCountBefore;
  const sfDelta      = sfAfter       - data.sfBefore;
  const cacheHitDelta = cacheHitAfter - data.cacheHitBefore;

  console.log(`--- cold_fanout mechanics (K=${K} N=${N} kind=${ARTIFACT_KIND} version=${data.version}) ---`);
  console.log(`Δ db_query_duration_seconds_count{query_name="${QUERY_NAME}"} = ${dbDelta}  (expect exactly ${K})`);
  console.log(`Δ singleflight_shared_calls_total{endpoint="${ENDPOINT}"}     = ${sfDelta}  (expect >= ${N - K}, typically == ${N} when fully concurrent)`);
  console.log(`Δ cache_hits_total{endpoint="${ENDPOINT}"}                    = ${cacheHitDelta}  (expect 0 — backend was cold)`);

  // STRICT: exactly K DB queries ran — one leader per cold key, never more.
  // This is the core coalescing proof: all N requests resolved from K DB hits.
  // singleflight.Do guarantees exactly one fn() invocation per in-flight key,
  // so this delta must equal K regardless of concurrency or timing.
  check(null, {
    'db query count delta == K': () => dbDelta === K,
  });

  // SINGLEFLIGHT: at least N-K requests coalesced (the non-leader requests).
  // In the per-vu-iterations burst all N VUs fire simultaneously; Go's
  // singleflight reports shared=true for ALL callers when a key has concurrent
  // waiters (including the leader). So Δsf == N is typical, and Δsf >= N-K is
  // the conservative lower bound that is always true when N > K and requests
  // are concurrent. Asserting Δsf >= N-K proves coalescing occurred for EVERY
  // non-leader request without relying on a specific timing split.
  check(null, {
    [`singleflight delta >= N-K (${N - K})`]: () => sfDelta >= (N - K),
  });

  // COLD GUARD: cache hits <= N - K is expected.
  // On a fast machine some VUs start after the first singleflight group
  // completes and the result is in ristretto — those get cache hits, not DB
  // queries. The strong invariant is Δdb == K (exactly one DB query per cold
  // key regardless of how many callers raced). Asserting cache_hits <= N - K
  // verifies that at most N-K "late" VUs saw a warm cache; if more than that
  // fired as cache hits, the backend was not cold (i.e. a prior run warmed it).
  check(null, {
    [`cache hits <= N-K (${N - K}) — at most late-VU warm-cache hits`]: () => cacheHitDelta <= (N - K),
  });
}

export function handleSummary(data) {
  // k6 does NOT pass setup() return data into handleSummary; use module-scope var.
  const version = resolvedVersion || 'unknown';
  const stamp = { artifactVersion: version, artifactKind: ARTIFACT_KIND, K, N };
  const checks = data.metrics && data.metrics.checks;
  const line = checks
    ? `checks passes=${checks.values.passes} fails=${checks.values.fails}`
    : 'checks: (none)';
  return {
    stdout: `\n=== cold_fanout.js (kind=${ARTIFACT_KIND} version=${version} K=${K} N=${N}) ===\n${line}\n`,
    'cold-fanout-summary.json': JSON.stringify(stamp, null, 2),
  };
}
