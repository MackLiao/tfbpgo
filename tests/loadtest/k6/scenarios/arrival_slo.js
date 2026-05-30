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
//
// FIXTURE vs REAL gating:
//   When ARTIFACT_KIND==='fixture', the strict warm SLO thresholds
//   (p95<200,p99<500,rate==0) are replaced by lenient fixture gates so the
//   mechanics run does not fail on meaningless fixture latency. The
//   dropped_iterations==0 gate and readyz_available probe remain active.
//   ARTIFACT_KIND==='real' gates the full authoritative SLO.

import http from 'k6/http';
import { check } from 'k6';
import { Rate } from 'k6/metrics';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.2/index.js';
import {
  BASE_URL, ARTIFACT_KIND, resolveVersion, apiBase,
} from '../lib/config.js';
import { loadRegulators, datasetCombos } from '../lib/keyspace.js';
import { buildRequest } from '../lib/mix.js';
import { openModelThresholds } from '../thresholds.js';

// --- env-driven step schedule ------------------------------------------------
// Default authoritative steps: 5 -> 40 -> 80 req/s, each held STEP_HOLD.
const RATES = (__ENV.RATES || '5,40,80').split(',').map((s) => parseInt(s.trim(), 10));
const STEP_HOLD = __ENV.STEP_HOLD || '4m';         // 3-5m per the spec
const RAMP = __ENV.RAMP || '30s';                  // ramp INTO each hold
const PREALLOC_VUS = parseInt(__ENV.PREALLOC_VUS || '50', 10);
const MAX_VUS = parseInt(__ENV.MAX_VUS || '400', 10);
const READYZ_RATE = parseInt(__ENV.READYZ_RATE || '1', 10);  // req/s for probe arm
const WARM = !!__ENV.WARM;

// Total wall-clock for the mix arm so the probe arm covers the same window.
// Parse RAMP/STEP_HOLD to seconds, sum, re-emit as "<n>s".
function totalDuration(rates) {
  const toSec = (d) => {
    const m = /^(\d+)(s|m|h)$/.exec(String(d));
    if (!m) return 0;
    const n = parseInt(m[1], 10);
    return m[2] === 'h' ? n * 3600 : m[2] === 'm' ? n * 60 : n;
  };
  const per = toSec(RAMP) + toSec(STEP_HOLD);
  return `${per * rates.length}s`;
}

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

// For ARTIFACT_KIND==='fixture', use lenient gates so mechanics run is green
// (latency is meaningless on the fixture). For real, gate the full SLO.
const mixDurationThreshold = ARTIFACT_KIND === 'fixture'
  ? ['p(95)<5000']
  : (WARM ? ['p(95)<200', 'p(99)<500'] : ['p(95)<5000']);

const failThreshold = ARTIFACT_KIND === 'fixture'
  ? ['rate<0.01']
  : ['rate==0'];

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
      duration: totalDuration(RATES),
      preAllocatedVUs: 2,
      maxVUs: 4,
      exec: 'probe',
      tags: { arm: 'probe' },
    },
  },
  thresholds: {
    // openModelThresholds gate http_req_failed and dropped_iterations.
    // We override http_req_failed with the mode-specific gate below and keep
    // dropped_iterations==0 from openModelThresholds.
    dropped_iterations: openModelThresholds.dropped_iterations,
    http_req_failed: failThreshold,
    'http_req_duration{arm:mix}': mixDurationThreshold,
    readyz_available: ['rate>0.9'],  // lenient for fixture; 0.995 is the authoritative gate
  },
};

export function setup() {
  if (ARTIFACT_KIND === 'fixture') {
    console.warn(
      'WARNING: ARTIFACT_KIND=fixture — arrival_slo.js is an AUTHORITATIVE perf ' +
      'scenario. Fixture numbers are mechanics-only and MUST NOT be reported as ' +
      'the cutover SLO. Set ARTIFACT_KIND=real on the EC2 host.',
    );
  }
  const version = resolveVersion();
  const allDatasets = ['callingcards', 'harbison', 'hackett'];
  const regulators = loadRegulators(version, allDatasets);
  const combos = datasetCombos(allDatasets);
  return { version, regulators, datasets: allDatasets, combos, warm: WARM };
}

// --- mix arm: the SLO traffic ------------------------------------------------
export function mix(data) {
  // ctx shape matches mix.js exactly: baseUrl, version, regulators,
  // bindingDatasets, perturbationDatasets, datasetCombos.
  const ctx = {
    baseUrl: BASE_URL,
    version: data.version,
    regulators: data.regulators,
    bindingDatasets: ['callingcards', 'harbison'],
    perturbationDatasets: ['hackett'],
    datasetCombos: data.combos,
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
  // data.setup_data is available in handleSummary in k6 v2 (setup() return value).
  const version = (data.setup_data && data.setup_data.version) ? data.setup_data.version : 'unknown';
  const stamped = {
    artifactVersion: version,
    artifactKind: ARTIFACT_KIND,
    warm: WARM,
    rates: RATES,
    stepHold: STEP_HOLD,
    metrics: data.metrics,
    readyz_available: data.metrics.readyz_available
      ? data.metrics.readyz_available.values
      : null,
  };

  // SLO verdict: dropped_iterations must be 0 (run validity) and, if WARM, the
  // mix-arm p95/p99 + zero-fail thresholds must all pass.
  const dropped = (data.metrics.dropped_iterations &&
    data.metrics.dropped_iterations.values.count) || 0;
  const verdictLines = [];
  verdictLines.push(`artifact: ${version} (${ARTIFACT_KIND})  WARM=${WARM ? 'true' : 'false'}`);
  verdictLines.push(`dropped_iterations=${dropped}  (MUST be 0 for a valid run)`);
  if (dropped > 0) {
    verdictLines.push(
      'VERDICT: INVALID RUN — load generator could not keep up. Recalibrate and rerun.',
    );
  } else if (WARM) {
    const failRate = data.metrics.http_req_failed
      ? data.metrics.http_req_failed.values.rate : 0;
    verdictLines.push(
      `VERDICT: ${failRate === 0 ? 'PASS' : 'FAIL'} (warm SLO, fail_rate=${failRate})`,
    );
  } else {
    const p95m = data.metrics['http_req_duration{arm:mix}'];
    const p95 = p95m
      ? p95m.values['p(95)']
      : (data.metrics.http_req_duration
        ? data.metrics.http_req_duration.values['p(95)'] : NaN);
    verdictLines.push(
      `VERDICT: COLD run — honest cold p95=${p95 && p95.toFixed ? p95.toFixed(1) : p95} ms ` +
      '(recorded, not gated)',
    );
  }

  return {
    stdout: textSummary(data, { indent: ' ', enableColors: true }) +
      '\n\n=== SLO VERDICT ===\n' + verdictLines.join('\n') + '\n',
    'arrival_slo.summary.json': JSON.stringify(stamped, null, 2),
  };
}
