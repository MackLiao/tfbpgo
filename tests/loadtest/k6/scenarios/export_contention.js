// tests/loadtest/k6/scenarios/export_contention.js
//
// Phase-C /export semaphore-1 contention-isolation scenario.
//
// Three concurrent roles:
//
//   VU A  (bigExport):    Issues ONE large /export. On the real artifact the
//   export spans several seconds while it streams a multi-dataset tar.gz;
//   it holds the semaphore for the full duration.
//
//   VU B  (secondExport): Issues a SECOND /export starting 1 s after A. On
//   the real artifact A is still streaming, so B blocks on the semaphore
//   acquire until the 30 s router-level middleware.Timeout fires, cancels
//   B's request context, and the semaphore select {} branch returns 408
//   "export queue timeout". EXPECT_408=1 gates this assertion (default on
//   the real artifact, set to 0 for the fixture).
//
//   VUs C (cachedJson):   8 VUs hammer cached binding + expensive topn JSON
//   concurrently with A and B. They must stay fast (p95<300ms, p99<800ms)
//   and never fail (http_req_failed{role:C}==0). This proves the cap-1
//   semaphore keeps one pool connection free for API traffic even while an
//   export holds the other.
//
// FIXTURE NOTE: The committed test fixture produces exports of ~1-2 KB; they
//   complete in < 10 ms, long before B fires (B starts 1 s later). Therefore
//   B always receives 200 on the fixture — the 408 path cannot be observed.
//   The fixture-mechanics run asserts ONLY that: (a) the scenario runs without
//   error, (b) A and B both succeed (200 or 408 are both acceptable), (c)
//   JSON co-traffic (role C) stays 200. The 408-rate threshold and p95-hold
//   assertions are ARTIFACT_KIND==='real'-gated (EXPECT_408=1).
//
// Authoritative EC2 run (Step 4b of task_21.md):
//   cd /opt/tfbp
//   SAMPLE_INTERVAL=1 SAMPLE_OUT=export_contention_sample.csv \
//     BASE_URL=https://tfbindingandperturbation.com CONTAINER=tfbp \
//     bash tests/loadtest/k6/chaos/sampler.sh &
//   SAMP=$!
//   export BASE_URL=https://tfbindingandperturbation.com ARTIFACT_KIND=real
//   export EXPECT_408=1 DURATION=3m
//   k6 run --out csv=export_contention.csv \
//     tests/loadtest/k6/scenarios/export_contention.js
//   kill "$SAMP"

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate } from 'k6/metrics';
import {
  BASE_URL, ARTIFACT_KIND, DURATION, resolveVersion, apiBase,
} from '../lib/config.js';
import { loadRegulators, datasetCombos } from '../lib/keyspace.js';
import { bindingURL, comparisonTopnURL } from '../lib/mix.js';
import { scrapeMetrics, parseCounter } from '../lib/metrics.js';

// EXPECT_408: set to '1' on EC2 (A still streaming when B fires -> 408);
//             '0' on fixture (exports complete in < 1 ms; B always gets 200).
const EXPECT_408 = (__ENV.EXPECT_408 !== undefined ? __ENV.EXPECT_408 : '1') === '1';
const _duration  = DURATION || '2m';

export const options = {
  scenarios: {
    exporterA: {
      executor: 'shared-iterations',
      vus: 1,
      iterations: 1,
      maxDuration: _duration,
      exec: 'bigExport',
      startTime: '0s',
      tags: { role: 'A' },
    },
    exporterB: {
      executor: 'shared-iterations',
      vus: 1,
      iterations: 1,
      maxDuration: _duration,
      exec: 'secondExport',
      startTime: '1s',
      tags: { role: 'B' },
    },
    jsonHammer: {
      executor: 'constant-vus',
      vus: 8,
      duration: _duration,
      exec: 'cachedJson',
      startTime: '0s',
      tags: { role: 'C' },
    },
  },
  thresholds: {
    // Co-running JSON must stay fast while exports contend.
    'http_req_duration{role:C}': ['p(95)<300', 'p(99)<800'],
    'http_req_failed{role:C}':   ['rate==0'],
    // 408 rate gate: real-artifact only (EXPECT_408=1).
    export_queue_408: EXPECT_408 ? ['rate>0'] : ['rate>=0'],
  },
};

// Custom metrics.
const exportLatency = new Trend('export_latency_ms', true);
const export408     = new Rate('export_queue_408');

// Module-scope version for handleSummary (k6 does not pass setup() data in).
let _version = 'unknown';

export function setup() {
  if (ARTIFACT_KIND === 'fixture') {
    console.warn(
      'export_contention: ARTIFACT_KIND=fixture — exports are tiny (~KB, < 1 ms); ' +
      'the second export (VU B) will always 200 before the semaphore queue times out. ' +
      '408 and p95-hold assertions are ARTIFACT_KIND=real-gated. ' +
      'Run on EC2 against the real artifact for the authoritative starvation-guard gate.',
    );
  }

  const version = resolveVersion();
  _version = version;

  const allDatasets = ['callingcards', 'harbison', 'hackett'];
  const regulators  = loadRegulators(version, ['callingcards', 'harbison']);
  return { version, allDatasets, regulators };
}

// Build the /export URL for all datasets. No filter — largest possible export.
function exportURL(version, datasets) {
  return `${apiBase(BASE_URL, version)}/export?datasets=${datasets.join(',')}`;
}

// ── VU A: large export ──────────────────────────────────────────────────────
export function bigExport(data) {
  const url = exportURL(data.version, data.allDatasets);
  const res = http.get(url, {
    tags: { endpoint: '/api/v/{v}/export', role: 'A' },
    timeout: '300s',
  });
  exportLatency.add(res.timings.duration);
  check(res, { 'A export 200': (r) => r.status === 200 });
}

// ── VU B: second export (expects 408 on real artifact) ──────────────────────
export function secondExport(data) {
  const url = exportURL(data.version, data.allDatasets);
  // On the real artifact A is still streaming (several seconds); B blocks
  // on the semaphore acquire. When the 30 s router timeout fires it cancels
  // B's context, the select branch returns 408 "export queue timeout".
  const res = http.get(url, {
    tags: { endpoint: '/api/v/{v}/export', role: 'B' },
    timeout: '60s',
    responseCallback: http.expectedStatuses(200, 408),
  });
  exportLatency.add(res.timings.duration);

  const got408 = res.status === 408;
  export408.add(got408);

  if (EXPECT_408) {
    check(res, {
      'B queued then 408 (or 200 if A finished first)': (r) => r.status === 408 || r.status === 200,
      'B 408 within ~32 s if blocked': (r) => r.status !== 408 || r.timings.duration <= 32000,
    });
  } else {
    // Fixture: B succeeds (200) because A completes in < 1 ms before B fires.
    check(res, { 'B 200 or 408': (r) => r.status === 200 || r.status === 408 });
  }
}

// ── VUs C: concurrent JSON hammer ───────────────────────────────────────────
export function cachedJson(data) {
  const reg   = data.regulators[Math.floor(Math.random() * data.regulators.length)];
  const combo = datasetCombos(data.allDatasets)[0]; // callingcards (fastest warm path)

  const ctx = {
    baseUrl: BASE_URL,
    version: data.version,
    regulators: data.regulators,
    bindingDatasets: ['callingcards', 'harbison'],
    perturbationDatasets: ['hackett'],
    datasetCombos: datasetCombos(data.allDatasets),
  };

  if (Math.random() < 0.7) {
    // Warm-cache binding: ~50% of the test-mix; exercises the HIT path.
    const url = bindingURL(ctx, Math.random());
    http.get(url, { tags: { endpoint: '/api/v/{v}/binding', role: 'C' } });
  } else {
    // Expensive topn: exercises the DB + singleflight path under export load.
    const url = comparisonTopnURL(ctx, Math.random());
    http.get(url, { tags: { endpoint: '/api/v/{v}/comparison/topn', role: 'C' } });
  }
  // Light think time so VUs don't pile up on a single key.
  sleep(0.1 + Math.random() * 0.4);
}

// ── Teardown: print pool gauge + 408 count ──────────────────────────────────
export function teardown(data) {
  let after;
  try {
    after = scrapeMetrics(BASE_URL);
  } catch (e) {
    console.error('export_contention teardown: scrapeMetrics failed:', String(e));
    return;
  }

  // db_pool_in_use is a gauge — final sample is indicative only.
  // The authoritative peak comes from the co-running host sampler.
  const inUseLine = (after.match(/^db_pool_in_use\s+([0-9.]+)/m) || ['', 'n/a'])[1];
  const http408   = parseCounter(after, 'http_requests_total', { code: '408' });

  console.log(`db_pool_in_use (final sample): ${inUseLine}`);
  console.log(`http_requests_total{code="408"} (cumulative): ${http408}`);
  console.log(`export_queue_408 rate expected: ${EXPECT_408 ? '>0 (real artifact)' : '>=0 (fixture)'}`);
}

export function handleSummary(data) {
  return {
    stdout: JSON.stringify({
      scenario: 'export_contention',
      artifactKind: ARTIFACT_KIND,
      artifactVersion: _version,
      expect408: EXPECT_408,
    }, null, 2) + '\n',
    'export_contention.summary.json': JSON.stringify(data, null, 2),
  };
}
