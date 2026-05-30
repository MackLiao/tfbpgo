// tests/loadtest/k6/scenarios/cold_start_cliff.js
//
// AUTHORITATIVE restart-recovery cliff scenario (spec §11 / operational runbook).
//
// Two constant-arrival-rate phases bracketing a mid-run backend restart:
//   Phase 1 (pre_restart)  — steady Zipfian traffic for PHASE1_DURATION, warms
//                            the ristretto cache so restart disruption is visible.
//   Phase 2 (post_restart) — same rate for PHASE2_DURATION; measures cache-hit
//                            recovery from zero (cold cache post-restart) back to
//                            a warm steady state.
//
// The restart itself is EXTERNALLY driven — k6 cannot kill a process. The host
// harness (cold_start_cliff.fixture.sh) or the operational EC2 block trigger the
// restart at the phase boundary. k6 drives continuous traffic through both phases
// and records all 503s / failed requests that occur during the restart window.
//
// FIXTURE vs REAL gating:
//   ARTIFACT_KIND==='fixture'
//     - Emits a console.warn (mandatory for authoritative scenarios).
//     - Strict thresholds (http_req_failed==0, cache_hit{phase:post}>=FLOOR,
//       readyz_available>0.99) are replaced by lenient gates so the mechanics
//       run is green on the tiny fixture where no real restart occurs and hit
//       rates are unpredictable.
//   ARTIFACT_KIND==='real'
//     - Full authoritative gates apply; see Step 4b for the EC2 pass/fail spec.
//
// Recovery gate:
//   cache_hit{phase:post} rate >= RECOVERY_HIT_FLOOR (default 0.85) by end of
//   phase 2. This measures whether ristretto re-warms to the pre-restart level.
//
// Available env overrides:
//   PHASE1_DURATION  (default 5m)  — steady warm traffic pre-restart
//   PHASE2_DURATION  (default 10m) — recovery window post-restart
//   TARGET_RATE      (default 15)  — req/s for both phases
//   ZIPF_EXP         (default 1.1) — Zipfian skew exponent
//   RECOVERY_HIT_FLOOR (default 0.85) — cache_hit rate gate for post phase
//   BASE_URL, ARTIFACT_KIND        — standard config overrides
//
// Operational restart command (EC2 — Step 4b):
//   cd /opt/tfbp
//   export BASE_URL=https://tfbindingandperturbation.com ARTIFACT_KIND=real
//   export TARGET_RATE=15 PHASE1_DURATION=5m PHASE2_DURATION=10m
//   export ZIPF_EXP=1.1 RECOVERY_HIT_FLOOR=0.85
//   k6 run --out csv=cold_start_cliff.csv \
//     tests/loadtest/k6/scenarios/cold_start_cliff.js &
//   K6_PID=$!
//   sleep 300                                 # let phase-1 warm the cache for 5m
//   docker compose restart tfbp               # the mid-run restart (cliff)
//   until curl -sf "$BASE_URL/readyz" >/dev/null; do sleep 1; done
//   wait "$K6_PID"

import http from 'k6/http';
import { check } from 'k6';
import { Rate, Trend } from 'k6/metrics';
import {
  BASE_URL, ARTIFACT_KIND, TARGET_RATE, ZIPF_EXP, resolveVersion,
} from '../lib/config.js';
import { loadRegulators, makeZipf, datasetCombos } from '../lib/keyspace.js';
import { buildRequest } from '../lib/mix.js';
import { availabilityThresholds } from '../thresholds.js';

// Phase durations are independent of DURATION so the restart can be bracketed
// precisely. The host harness restarts the backend at the phase-1/phase-2
// boundary (k6 cannot kill a process; see cold_start_cliff.fixture.sh and the
// operational block above).
const PHASE1 = __ENV.PHASE1_DURATION || '5m';   // steady warm traffic pre-restart
const PHASE2 = __ENV.PHASE2_DURATION || '10m';  // recovery window post-restart
const RECOVERY_HIT_FLOOR = parseFloat(__ENV.RECOVERY_HIT_FLOOR || '0.85');

const rate = parseInt(String(TARGET_RATE), 10);

// --- Threshold gating: lenient for fixture mechanics, strict for real artifact ---
// The fixture harness (cold_start_cliff.fixture.sh) performs an ACTUAL mid-run
// backend restart, so there IS a real failure window. The fixture-mode thresholds
// must tolerate those failures:
//   - http_req_failed: up to 50% is fine for a ~0.5s restart gap at 5 req/s.
//   - cache_hit{phase:post}: rate>=0 (any value; fixture keyspace is too small
//     for meaningful recovery assertion).
//   - readyz_available: rate>0.5 (brief restart gap is allowed).
// For ARTIFACT_KIND==='real' the full authoritative gates apply.
const isFixture = ARTIFACT_KIND !== 'real';

const failThreshold       = isFixture ? ['rate<0.5']    : ['rate==0'];
const hitFloorThreshold   = isFixture ? ['rate>=0']     : [`rate>=${RECOVERY_HIT_FLOOR}`];
const readyzThreshold     = isFixture ? ['rate>0.5']    : ['rate>0.99'];

export const options = {
  scenarios: {
    pre_restart: {
      executor: 'constant-arrival-rate',
      rate,
      timeUnit: '1s',
      duration: PHASE1,
      preAllocatedVUs: Math.max(20, rate * 4),
      maxVUs: Math.max(50, rate * 10),
      startTime: '0s',
      tags: { phase: 'pre' },
    },
    post_restart: {
      executor: 'constant-arrival-rate',
      rate,
      timeUnit: '1s',
      duration: PHASE2,
      preAllocatedVUs: Math.max(20, rate * 4),
      maxVUs: Math.max(50, rate * 10),
      startTime: PHASE1,
      tags: { phase: 'post' },
    },
  },
  thresholds: {
    ...availabilityThresholds,            // http_req_failed: rate<0.005 baseline
    // Override http_req_failed: ==0 for real (no 503 tolerated), <0.5 for fixture
    // (brief restart gap at 5 req/s will produce a handful of connection-refused errors).
    http_req_failed: failThreshold,
    'cache_hit{phase:post}': hitFloorThreshold,
    readyz_available: readyzThreshold,
  },
};

// --- Custom metrics ---
const cacheHit       = new Rate('cache_hit');
const readyzAvail    = new Rate('readyz_available');
const recovLatencyMs = new Trend('post_restart_latency_ms', true);

export function setup() {
  if (ARTIFACT_KIND === 'fixture') {
    console.warn(
      'WARNING: cold_start_cliff: ARTIFACT_KIND=fixture — recovery numbers are ' +
      'NOT authoritative; fixture has no real restart and a tiny keyspace. ' +
      'Run against the real artifact on EC2 per the operational block in the file header.',
    );
  }
  const version = resolveVersion();
  const allDatasets = ['callingcards', 'harbison', 'hackett'];
  const regulators = loadRegulators(version, ['callingcards', 'harbison']);
  const combos = datasetCombos(allDatasets);
  return { version, regulators, combos };
}

export default function (data) {
  // ctx shape matches mix.js exactly.
  const ctx = {
    baseUrl: BASE_URL,
    version: data.version,
    regulators: data.regulators,
    bindingDatasets: ['callingcards', 'harbison'],
    perturbationDatasets: ['hackett'],
    datasetCombos: data.combos,
  };

  // Zipf-skew the regulator pick for realistic cache reuse.
  const pickReg = makeZipf(data.regulators, parseFloat(String(ZIPF_EXP)));
  ctx.regulators = [pickReg(Math.random())];

  const req = buildRequest(Math.random(), ctx);
  // During the restart window the backend may be briefly unavailable; we track
  // failures via http_req_failed (k6 built-in) and our Rate thresholds, NOT by
  // hard-failing the check (which would mask the recovery window in the summary).
  const res = http.request(req.method, req.url, null, { tags: req.tags });

  check(res, { 'status<500': (r) => r.status < 500 });

  // cache_hit tagged with the scenario phase (pre / post) — used by the
  // 'cache_hit{phase:post}' threshold to gate post-restart recovery.
  // Phase tag comes from the scenario-level tags injected by k6 (__ENV.K6_SCENARIO_NAME
  // is not available at VU scope; use the req.tags.phase if set, else derive from
  // the scenario name). k6 injects scenario tags directly onto metrics when a
  // scenario-level `tags` map is set.
  cacheHit.add(res.headers['X-Cache'] === 'HIT');
  recovLatencyMs.add(res.timings.duration);

  // Low-rate /readyz probe — availability Rate for the readyz_available threshold.
  // We sample probabilistically (~1 in 5) to avoid doubling the request rate.
  if (Math.random() < 0.2) {
    const baseNoTrailing = BASE_URL.replace(/\/+$/, '');
    const ready = http.get(`${baseNoTrailing}/readyz`, {
      tags: { endpoint: 'readyz' },
      // Tolerate the brief restart window without failing the VU.
      responseCallback: http.expectedStatuses({ min: 200, max: 599 }),
    });
    readyzAvail.add(ready.status === 200);
  }
}

export function handleSummary(data) {
  // k6 does NOT pass setup() return data into handleSummary. Capture metrics
  // from data.metrics; wrap any http call in try/catch (connection may be
  // recycled at run end). Never throw from handleSummary.
  let version = 'unknown';
  try {
    const vr = http.get(`${BASE_URL.replace(/\/+$/, '')}/api/version`);
    if (vr && vr.status === 200 && vr.body) {
      const parsed = vr.json();
      version = parsed.artifactVersion || 'unknown';
    }
  } catch (_e) {
    // Backend may be transiently unavailable post-run.
  }

  const cacheHitPost = data.metrics['cache_hit{phase:post}'];
  const cacheHitPre  = data.metrics['cache_hit{phase:pre}'];
  const failedRate   = data.metrics.http_req_failed
    ? data.metrics.http_req_failed.values.rate : 0;
  const readyzRate   = data.metrics.readyz_available
    ? data.metrics.readyz_available.values.rate : null;

  const stamp = {
    scenario: 'cold_start_cliff',
    artifactVersion: version,
    artifactKind: ARTIFACT_KIND,
    phase1Duration: PHASE1,
    phase2Duration: PHASE2,
    targetRate: rate,
    zipfExp: ZIPF_EXP,
    recoveryHitFloor: RECOVERY_HIT_FLOOR,
    cacheHitRatePre:  cacheHitPre  ? cacheHitPre.values.rate  : null,
    cacheHitRatePost: cacheHitPost ? cacheHitPost.values.rate : null,
    httpReqFailedRate: failedRate,
    readyzAvailableRate: readyzRate,
  };

  const lines = [
    `artifact: ${version} (${ARTIFACT_KIND})`,
    `phase1 duration:  ${PHASE1}   phase2 duration: ${PHASE2}`,
    `target rate:      ${rate} req/s   zipf_exp: ${ZIPF_EXP}`,
    `cache_hit pre:    ${stamp.cacheHitRatePre  != null ? (stamp.cacheHitRatePre  * 100).toFixed(1) + '%' : 'n/a'}`,
    `cache_hit post:   ${stamp.cacheHitRatePost != null ? (stamp.cacheHitRatePost * 100).toFixed(1) + '%' : 'n/a'}  (floor: ${(RECOVERY_HIT_FLOOR * 100).toFixed(0)}%)`,
    `http_req_failed:  ${(failedRate * 100).toFixed(2)}%`,
    `readyz available: ${readyzRate != null ? (readyzRate * 100).toFixed(2) + '%' : 'n/a'}`,
  ];

  // Verdict only meaningful for ARTIFACT_KIND==='real' (fixture run is mechanics-only).
  if (!isFixture) {
    const passHitFloor = stamp.cacheHitRatePost != null &&
      stamp.cacheHitRatePost >= RECOVERY_HIT_FLOOR;
    const passNoFail  = failedRate === 0;
    const passReadyz  = readyzRate != null && readyzRate > 0.99;
    const verdict = (passHitFloor && passNoFail && passReadyz) ? 'PASS' : 'FAIL';
    lines.push(
      `VERDICT: ${verdict}  ` +
      `(hit_floor=${passHitFloor ? '✓' : '✗'}  no_fail=${passNoFail ? '✓' : '✗'}  readyz=${passReadyz ? '✓' : '✗'})`,
    );
  } else {
    lines.push('VERDICT: MECHANICS ONLY (ARTIFACT_KIND=fixture — not authoritative)');
  }

  return {
    stdout: '\n=== cold_start_cliff ===\n' + lines.join('\n') + '\n',
    'cold_start_cliff.summary.json': JSON.stringify(stamp, null, 2),
  };
}
