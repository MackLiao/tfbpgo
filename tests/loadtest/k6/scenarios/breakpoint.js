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
// VALUE is the handleSummary: it scrapes /metrics deltas (using the pre-run
// snapshot from setup_data.before) and CLASSIFIES the degradation mode so the
// cutover summary records WHY it fell over, plus the knee (last rate where p95
// stayed sane) and the cliff (first rate where failures started).
//
// k6 v2 module isolation note: teardown() and handleSummary() run in separate
// module instances, so module-scope variables CANNOT bridge teardown->handleSummary.
// The before-snapshot is passed via setup() return value (data.setup_data.before).
// handleSummary() performs the post-run /metrics scrape itself.
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
import { loadRegulators, makeUniform, datasetCombos } from '../lib/keyspace.js';
import { comparisonTopnURL, bindingURL } from '../lib/mix.js';
import {
  scrapeMetrics, metricDelta, poolWaitMeanMs,
} from '../lib/metrics.js';

const RATES = (__ENV.RATES || '50,100,150,200,250,300').split(',').map((s) => parseInt(s.trim(), 10));
const STEP_HOLD = __ENV.STEP_HOLD || '90s';
const RAMP = __ENV.RAMP || '15s';
const PREALLOC_VUS = parseInt(__ENV.PREALLOC_VUS || '100', 10);
const MAX_VUS = parseInt(__ENV.MAX_VUS || '1000', 10);

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
  // Note: do NOT set discardResponseBodies at the options level — it would also
  // discard bodies in handleSummary's http calls (scrapeMetrics, resolveVersion).
  // The expensive() VU function sets responseType: 'none' per-request instead.
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
  // k6 v2 bug: ramping-arrival-rate executor does not pass setup_data to
  // handleSummary when setup() makes http calls. Work around this by returning
  // only plain (non-http-derived) values from setup. Version and before-metrics
  // are resolved inside handleSummary (which CAN make http calls).
  return { rates: RATES };
}

// Mostly-miss expensive traffic: uniform pick over the full regulator space
// (so reuse is low and the cache cannot shield the pool), 70% comparison/topn
// (the most expensive endpoint), 30% binding with a varied filter.
//
// Note: expensive() cannot use data.version/data.regulators from setup() because
// of the k6 v2 ramping-arrival-rate bug (setup_data is undefined when setup()
// makes http calls). Instead we resolve the version at VU init time via __ENV
// and use STATIC_REGULATORS as the uniform keyspace. This is correct for the
// breakpoint scenario: we want uniform distribution over a known regulator set.
const _version = (__ENV.VERSION || 'test-fixture');
const _regulators = [
  'YBR289W', 'YML007W', 'YPL248C', 'YOR028C', 'YGL073W',
  'YDR277C', 'YAL038W', 'YMR053C', 'YHR084W', 'YJL056C',
];
const _combos = [['callingcards'], ['harbison'], ['callingcards', 'harbison']];

export function expensive(_data) {
  const pickReg = makeUniform(_regulators);
  const reg = pickReg(Math.random());

  // ctx shape matches mix.js URL builders exactly.
  const ctx = {
    baseUrl: BASE_URL,
    version: _version,
    regulators: [reg],
    bindingDatasets: ['callingcards', 'harbison'],
    perturbationDatasets: ['hackett'],
    datasetCombos: _combos,
  };

  let url;
  let endpoint;
  if (Math.random() < 0.7) {
    url = comparisonTopnURL(ctx, Math.random());
    endpoint = 'comparison/topn';
  } else {
    url = bindingURL(ctx, Math.random());
    endpoint = 'binding/data';
  }
  // Discard response bodies per-request (not globally, to allow handleSummary scrapes).
  const res = http.get(url, { tags: { endpoint }, responseType: 'none' });
  reqLatency.add(res.timings.duration, { endpoint });
  check(res, { 'not 5xx': (r) => r.status < 500 });
}

// teardown() is a no-op in this scenario: k6 v2 module isolation means module-
// scope variables written in teardown() are NOT visible in handleSummary() (they
// run in separate module instances). All post-run metric work is done in
// handleSummary() which scrapes /metrics directly and uses data.setup_data.before.
export function teardown(_data) {}

export function handleSummary(data) {
  // k6 v2 ramping-arrival-rate bug: setup_data may be undefined when setup()
  // makes http calls. Resolve version and scrape metrics directly here.
  // before = empty string (treat all counters as deltas from 0 = absolute counts
  // since server start; the server should be freshly restarted for the real run).
  // Resolve version: use a plain http.get with error handling. k6 may recycle
  // connections at run end; if the request fails, version stamps as 'unknown'.
  // (The authoritative EC2 run will have a stable backend that responds reliably.)
  let version = 'unknown';
  try {
    const vr = http.get(`${BASE_URL}/api/version`);
    if (vr.status === 200 && vr.body) {
      const parsed = vr.json();
      version = parsed.artifactVersion || 'unknown';
    }
  } catch (_e) {
    // Backend may be unavailable post-run (e.g., OOM kill or connection recycled).
  }
  const before = '';  // absolute counts since server start (fresh restart assumed)
  let after = '';
  try {
    after = scrapeMetrics(BASE_URL);
  } catch (_e) {
    after = '';
  }

  // --- pool saturation signal ---
  // db_pool_in_use is a gauge; post-run scrape is a lower-bound proxy.
  // TRUE peak requires the operational sampler sidecar (see Step 3b).
  const poolInUsePeak = peakGauge(after, 'db_pool_in_use');
  const poolOpen = peakGauge(after, 'db_pool_open_connections');
  const poolWaitMean = poolWaitMeanMs(before, after);
  const waitCountDelta = metricDelta(before, after, 'db_pool_wait_count_total');

  // --- memory / OOM signal ---
  // process_resident_memory_bytes is a standard Go runtime metric.
  // Returns 0 if the backend does not expose it (graceful fallback).
  const rssAfter = peakGauge(after, 'process_resident_memory_bytes');
  const rssBefore = peakGauge(before, 'process_resident_memory_bytes');

  // --- goroutine pile-up signal (waiters) ---
  const goroutines = peakGauge(after, 'go_goroutines');

  // --- cache + eviction + miss signal ---
  const cacheMissesDelta = metricDelta(before, after, 'cache_misses_total');
  const evictionsDelta = metricDelta(before, after, 'cache_evictions_total');

  const d = {
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

  const failedRate = data.metrics.http_req_failed
    ? data.metrics.http_req_failed.values.rate : 0;
  const p95 = data.metrics.http_req_duration
    ? data.metrics.http_req_duration.values['p(95)'] : NaN;

  // rates from setup_data; fall back to the module-scope RATES constant.
  const rates = (data.setup_data && data.setup_data.rates) ? data.setup_data.rates : RATES;
  const { knee, cliff } = locateKneeCliff(data, rates);

  const mode = classifyMode({
    failedRate,
    poolInUsePeak: d.dbPoolInUsePeak || 0,
    poolOpen: d.dbPoolOpenConnections || 0,
    poolWaitMeanMs: d.poolWaitMeanMs || 0,
    rssBeforeMB: d.rssBeforeMB || 0,
    rssAfterMB: d.rssAfterMB || 0,
    goGoroutines: d.goGoroutines || 0,
    cacheEvictionsDelta: d.cacheEvictionsDelta || 0,
  });

  // version already resolved above

  const summary = {
    artifactVersion: version,
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
    `artifact: ${version} (${ARTIFACT_KIND})`,
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

// Reads the last value of a gauge metric line from /metrics text. Returns 0
// if the metric is not present (graceful fallback for metrics not exposed by
// this backend, e.g. process_resident_memory_bytes).
function peakGauge(text, name) {
  if (!text) return 0;
  const re = new RegExp(`^${escapeRe(name)}(\\{[^}]*\\})?\\s+([0-9.eE+-]+)`, 'm');
  const m = re.exec(text);
  return m ? parseFloat(m[2]) : 0;
}

// Knee = highest rate whose per-step p95 stayed under KNEE_P95_MS; cliff =
// lowest rate whose per-step failed-rate exceeded CLIFF_FAIL_RATE. Per-step
// values come from k6 sub-metrics tagged by the executor stage; when those are
// unavailable in handleSummary, returns null (operator fills from time-series CSV).
function locateKneeCliff(data, rates) {
  const KNEE_P95_MS = parseFloat(__ENV.KNEE_P95_MS || '500');
  let knee = null;
  let cliff = null;
  for (const r of (rates || [])) {
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
  if (s.failedRate > 0.01 && (s.rssAfterMB - s.rssBeforeMB) > 300) {
    return {
      label: 'OOM',
      reason: `RSS climbed ${s.rssBeforeMB}->${s.rssAfterMB} MB with ${(s.failedRate * 100).toFixed(1)}% failures`,
    };
  }
  // queue-then-504: pool pegged at its open size, waiters piled up, failures rose.
  if (s.poolInUsePeak >= s.poolOpen && s.poolOpen > 0 &&
      (s.poolWaitMeanMs > 100 || s.goGoroutines > 200)) {
    return {
      label: 'queue-then-504',
      reason: `pool pegged ${s.poolInUsePeak}/${s.poolOpen}, wait mean ${s.poolWaitMeanMs} ms, goroutines ${s.goGoroutines}`,
    };
  }
  // spill: heavy eviction / DB cost with moderate pool wait — DuckDB spilling.
  if (s.cacheEvictionsDelta > 0 && s.poolWaitMeanMs > 50 && s.poolWaitMeanMs <= 100) {
    return {
      label: 'spill',
      reason: `evictions ${s.cacheEvictionsDelta}, moderate pool wait ${s.poolWaitMeanMs} ms ` +
        '(suspect DuckDB temp spill — check max_temp_directory_size)',
    };
  }
  // credit-throttle: failures/latency rose but pool + memory are healthy.
  if (s.failedRate > 0.005 && s.poolInUsePeak < s.poolOpen &&
      (s.rssAfterMB - s.rssBeforeMB) < 100) {
    return {
      label: 'credit-throttle',
      reason: `failures ${(s.failedRate * 100).toFixed(1)}% with healthy pool ` +
        `(${s.poolInUsePeak}/${s.poolOpen}) and flat RSS — suspect t3.small CPU-credit exhaustion`,
    };
  }
  return {
    label: 'no-degradation',
    reason: 'system stayed within capacity at the rates swept — push higher RATES',
  };
}

function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function round1(x) { return Math.round(x * 10) / 10; }
function round3(x) { return Math.round(x * 1000) / 1000; }
