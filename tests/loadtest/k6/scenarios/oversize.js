// tests/loadtest/k6/scenarios/oversize.js
//
// Phase-C ristretto oversize / admission-rejection / eviction-pressure probe.
//
// Two-phase design:
//
//   Phase 1 (repeat_large):  One VU hammers PHASE1_ITERS times the largest
//   reachable key — selection/matrix over all datasets. When the cached
//   response exceeds budget/20 the ristretto backend emits WARN +
//   increments cache_oversize_responses_total{endpoint=...} and
//   cache_admission_rejected_total{endpoint=...}. If under threshold the
//   key should flip to X-Cache:HIT on the second request. Either path must
//   return 200 every time.
//
//   Phase 2 (walk_distinct):  4 VUs walk PHASE2_KEYS distinct keys (binding
//   + topn combos) to overflow the cache budget and force evictions.
//   cache_evictions_total should be > 0 on the real artifact; on the fixture
//   responses are tiny so evictions may not fire.
//
// FIXTURE NOTE: The committed test fixture produces responses of a few KB.
//   The ristretto budget on the real artifact is 128 MB (budget/20 ≈ 6.4 MB
//   per-item threshold). On the fixture the oversize and eviction counters
//   will remain 0. That is correct and expected. The fixture-mechanics run
//   asserts ONLY that: (a) both phases execute without error, (b) the
//   counter-parsing helpers return without throwing, (c) all HTTP responses
//   are 200. Oversize/eviction assertions are ARTIFACT_KIND==='real'-gated.
//
// Authoritative EC2 run (Step 4b):
//   cd /opt/tfbp
//   export BASE_URL=https://tfbindingandperturbation.com ARTIFACT_KIND=real
//   export PHASE1_ITERS=300 PHASE2_KEYS=50
//   k6 run --out csv=oversize.csv tests/loadtest/k6/scenarios/oversize.js

import http from 'k6/http';
import { check } from 'k6';
import {
  BASE_URL, ARTIFACT_KIND, resolveVersion, apiBase,
} from '../lib/config.js';
import { loadRegulators, datasetCombos } from '../lib/keyspace.js';
import { scrapeMetrics, parseCounter, metricDelta } from '../lib/metrics.js';

const PHASE1_ITERS = parseInt(__ENV.PHASE1_ITERS || '200', 10);
const PHASE2_KEYS  = parseInt(__ENV.PHASE2_KEYS  || '40',  10);

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
      startTime: '10s',  // small gap so phase-1 has seeded the cache first
      exec: 'walkDistinct',
      tags: { phase: 'walk' },
    },
  },
  thresholds: {
    http_req_failed: ['rate==0'],
  },
};

// Module-scope snapshot for handleSummary (k6 does not pass setup() data in).
let _version = 'unknown';

export function setup() {
  if (ARTIFACT_KIND === 'fixture') {
    console.warn(
      'oversize: ARTIFACT_KIND=fixture — fixture responses are tiny (~KB); ' +
      'cache_oversize_responses_total and cache_evictions_total will be 0 here. ' +
      'Run against the real artifact on EC2 for authoritative oversize/eviction numbers.',
    );
  }

  const version = resolveVersion();
  _version = version;

  const allDatasets = ['callingcards', 'harbison', 'hackett'];
  const regulators  = loadRegulators(version, ['callingcards', 'harbison']);
  const before      = scrapeMetrics(BASE_URL);

  return {
    version,
    allDatasets,
    regulators,
    combos: datasetCombos(allDatasets),
    metricsBefore: before,
    rejectBefore: parseCounter(before, 'cache_admission_rejected_total',
      { endpoint: '/api/v/{v}/selection/matrix' }),
    oversizeBefore: parseCounter(before, 'cache_oversize_responses_total',
      { endpoint: '/api/v/{v}/selection/matrix' }),
    evictBefore: parseCounter(before, 'cache_evictions_total'),
  };
}

// ── Phase 1: repeat one large key ──────────────────────────────────────────
// The largest naturally-available key on the fixture is selection/matrix over
// all datasets. On the real artifact this can easily exceed the per-item
// oversize threshold (budget/20 ≈ 6.4 MB at 128 MB cache). We tag with the
// chi route pattern so server-side metrics align with the k6 tags.
// No ?filters= — selection/matrix does not take per-dataset filters; the
// oversize scenario measures raw response size, not filter coverage.
export function repeatLarge(data) {
  const base = apiBase(BASE_URL, data.version);
  const url  = `${base}/selection/matrix?datasets=${data.allDatasets.join(',')}`;

  const res = http.get(url, {
    tags: { endpoint: '/api/v/{v}/selection/matrix', phase: 'repeat' },
  });
  check(res, { 'matrix 200': (r) => r.status === 200 });
}

// ── Phase 2: walk PHASE2_KEYS distinct large keys ──────────────────────────
// Wide binding + topn=1000 combos across all regulator × dataset × combo
// combinations. Goal: exhaust the ristretto budget so evictions fire.
// No ?filters= on the binding/topn calls — keeping URLs simple maximises the
// distinct-key spread (filters would create additional key variants but the
// fixture has no filterable data for non-callingcards datasets).
export function walkDistinct(data) {
  const i     = __ITER;
  const reg   = data.regulators[i % data.regulators.length];
  const combo = data.combos[i % data.combos.length];
  const base  = apiBase(BASE_URL, data.version);

  // Binding datasets only (hackett is perturbation-only).
  const bindingCombo = combo.filter((d) => d !== 'hackett');
  if (bindingCombo.length === 0) {
    // combos that are hackett-only: skip binding, still do topn.
    const tURL = `${base}/comparison/topn?binding=callingcards&perturbation=hackett&top_n=1000`;
    http.get(tURL, { tags: { endpoint: '/api/v/{v}/comparison/topn', phase: 'walk' } });
    return;
  }

  // Wide binding response (varies by regulator + dataset combo).
  const bURL = `${base}/binding?regulator=${reg}&datasets=${bindingCombo.join(',')}`;
  http.get(bURL, { tags: { endpoint: '/api/v/{v}/binding', phase: 'walk' } });

  // topn=1000 on the first binding dataset vs hackett (maximum result-set size).
  const bindDs = bindingCombo[0];
  const tURL   = `${base}/comparison/topn?binding=${bindDs}&perturbation=hackett&top_n=1000`;
  http.get(tURL, { tags: { endpoint: '/api/v/{v}/comparison/topn', phase: 'walk' } });
}

// ── Teardown: report deltas and largest observed response buckets ───────────
export function teardown(data) {
  let after;
  try {
    after = scrapeMetrics(BASE_URL);
  } catch (e) {
    console.error('oversize teardown: scrapeMetrics failed:', String(e));
    return;
  }

  const rejectDelta  = metricDelta(data.metricsBefore, after,
    'cache_admission_rejected_total', { endpoint: '/api/v/{v}/selection/matrix' });
  const oversizeDelta = metricDelta(data.metricsBefore, after,
    'cache_oversize_responses_total', { endpoint: '/api/v/{v}/selection/matrix' });
  const evictDelta   = metricDelta(data.metricsBefore, after, 'cache_evictions_total');

  // Largest populated http_response_bytes bucket per route.
  // We read `http_response_bytes_bucket{le="...",route="..."}` lines to find
  // the highest `le` bucket with a non-zero count — a proxy for max observed
  // response size. Operators should record these in tests/loadtest-summary.md.
  const maxBucket = {};
  const lines = (after || '').split('\n');
  for (const line of lines) {
    const m = line.match(/^http_response_bytes_bucket\{le="([0-9.e+]+)",route="([^"]+)"\}\s+(\d+)/);
    if (m && parseInt(m[3], 10) > 0) {
      const le    = parseFloat(m[1]);
      const route = m[2];
      if (!maxBucket[route] || le > maxBucket[route]) maxBucket[route] = le;
    }
  }

  console.log('--- oversize scenario deltas ---');
  console.log(`cache_admission_rejected_total{endpoint="/api/v/{v}/selection/matrix"} += ${rejectDelta}`);
  console.log(`cache_oversize_responses_total{endpoint="/api/v/{v}/selection/matrix"} += ${oversizeDelta}`);
  console.log(`cache_evictions_total += ${evictDelta}`);
  console.log('largest populated http_response_bytes le-bucket per route:');
  for (const route of Object.keys(maxBucket)) {
    console.log(`  ${route}: <= ${maxBucket[route]} bytes`);
  }

  if (ARTIFACT_KIND === 'real') {
    // On the real artifact with 128 MB cache (budget/20 ≈ 6.4 MB threshold):
    // if selection/matrix produces a >6.4 MB response -> oversize > 0.
    // Phase 2 walking 40-50 distinct large keys should force evictions > 0.
    // We log warnings here; the authoritative check is the operator's review
    // of the teardown output + /metrics delta printed above.
    if (rejectDelta === 0 && oversizeDelta === 0) {
      console.log('NOTE: no admission rejects observed on real artifact — ' +
        'selection/matrix response < budget/20 (≈6.4 MB); X-Cache should be HIT after first request.');
    } else {
      console.log(`PASS: oversize/admission path fired (oversize Δ=${oversizeDelta}, reject Δ=${rejectDelta}).`);
    }
    if (evictDelta === 0) {
      console.warn('WARN: cache_evictions_total Δ=0 on real artifact — try PHASE2_KEYS=100+ to force evictions.');
    } else {
      console.log(`PASS: cache_evictions_total Δ=${evictDelta} — phase-2 walk overflowed the cache budget.`);
    }
  } else {
    // Fixture: counters expected to be 0. Log informational only.
    console.log('fixture: admit-reject Δ=' + rejectDelta + ' evict Δ=' + evictDelta +
      ' (expected 0 — fixture responses are tiny; see FIXTURE NOTE at top of file).');
  }
}

export function handleSummary(data) {
  return {
    stdout: JSON.stringify({
      scenario: 'oversize',
      artifactKind: ARTIFACT_KIND,
      artifactVersion: _version,
      phase1Iters: PHASE1_ITERS,
      phase2Keys: PHASE2_KEYS,
    }, null, 2) + '\n',
    'oversize.summary.json': JSON.stringify(data, null, 2),
  };
}
