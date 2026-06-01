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
//      the delta equals N)
//
// THESE STRICT EQUALITIES ARE ARTIFACT_KIND=real-GATED. They hold only when the
// singleflight in-flight window dominates k6's VU-startup jitter — true on the
// real artifact (binding query takes tens of ms) but NOT on the fixture (the
// query is sub-millisecond). See the per-kind gate in teardown().
//
// NOTE on singleflight `shared` semantics (empirically verified):
//   Go's singleflight.Do returns shared=true when the result was produced by a
//   concurrent in-flight call, i.e. when two or more callers for the same key
//   raced. On the REAL artifact, with N=40 VUs firing into K=3 cold keys (~13
//   per key), all callers arrive before the leader finishes the query and calls
//   cache.Wait(), so ALL callers per key receive shared=true (Δsf == N).
//
//   On the FIXTURE the leader often finishes first: late VUs then resolve as
//   cache HITS (not shared calls), so Δsf drops well below N (observed 13–40
//   over a 20-run study) while Δsf + Δhits stays == N, and Δdb stays at K (very
//   rarely K+1 when a late VU misses both the cache and the in-flight window).
//   The fixture therefore asserts the timing-robust pair Δdb <= 2K and
//   Δsf + Δhits >= N-K — both proven by the study to never false-fail while
//   still collapsing loudly if coalescing regresses (broken singleflight →
//   Δdb ≈ N, Δsf + Δhits ≈ small).
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
  console.log(`Δ db_query_duration_seconds_count{query_name="${QUERY_NAME}"} = ${dbDelta}`);
  console.log(`Δ singleflight_shared_calls_total{endpoint="${ENDPOINT}"}     = ${sfDelta}`);
  console.log(`Δ cache_hits_total{endpoint="${ENDPOINT}"}                    = ${cacheHitDelta}`);

  if (ARTIFACT_KIND === 'real') {
    // REAL ARTIFACT — deterministic. The binding query takes tens of ms, so the
    // singleflight in-flight window dominates k6's VU-startup jitter: every one
    // of the N callers lands while the K leaders are still running.
    console.log(`(real gate: expect Δdb == ${K}, Δsf >= ${N - K})`);

    // STRICT: exactly K DB queries ran — one leader per cold key, never more.
    // The core coalescing proof: all N requests resolved from K DB hits.
    check(null, {
      'db query count delta == K': () => dbDelta === K,
    });

    // STRICT: at least N-K requests coalesced as shared singleflight calls.
    // Δsf == N is typical (Go marks ALL callers shared when a key has concurrent
    // waiters); Δsf >= N-K is the conservative lower bound.
    check(null, {
      [`singleflight delta >= N-K (${N - K})`]: () => sfDelta >= (N - K),
    });
  } else {
    // FIXTURE — timing-robust. The binding query is sub-millisecond, so the
    // in-flight window is narrower than VU-startup jitter. Late VUs legitimately
    // resolve as cache HITS rather than shared singleflight calls, which drags
    // Δsf below N-K without any regression (DB still hit exactly K times). The
    // strict ==K / >=N-K checks are therefore real-only; here we assert the
    // invariants a 20-run jitter study showed never false-fail (see header).
    console.log(`(fixture gate: expect Δdb <= ${2 * K}, Δsf+Δhits >= ${N - K}; strict ==K is real-only)`);

    // The DB was hit ~K times, not ~N. A broken singleflight would let most of
    // the N concurrent cold misses query the DB independently (Δdb ≈ N).
    check(null, {
      [`db query count delta <= 2K (${2 * K}) — coalesced to ~K DB hits`]: () => dbDelta <= (2 * K),
    });

    // Conservation: at least N-K of the N concurrent requests were absorbed by
    // singleflight-sharing OR the cache, i.e. did NOT issue an independent DB
    // query. Broken singleflight → requests query the DB independently →
    // Δsf + Δhits collapses → this fails loudly.
    check(null, {
      [`singleflight+cache absorbed >= N-K (${N - K})`]: () => (sfDelta + cacheHitDelta) >= (N - K),
    });
  }

  // COLD GUARD (both kinds): at most N-K late VUs may have seen a warm cache.
  // If more than that fired as cache hits, the backend was not cold (a prior
  // run warmed it) — setup() also guards this via cache_hits_total == 0.
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
