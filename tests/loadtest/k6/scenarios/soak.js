// tests/loadtest/k6/scenarios/soak.js
//
// AUTHORITATIVE long soak / endurance scenario (spec §11.3.4 / §6.6).
//
// Constant-arrival-rate at TARGET_RATE (~60-70% of the measured knee) for a
// long DURATION (default 2h). Realistic Zipfian endpoint mix from lib/mix.js.
// Pairs with the host sampler (tests/loadtest/k6/chaos/sampler.sh, Task 23) to
// record process_resident_memory_bytes, go_goroutines, and CPUCreditBalance
// over the full soak window.
//
// What this scenario detects:
//   - Burst-credit exhaustion on t3.small (CPUCreditBalance -> 0 over 2h).
//   - Memory leaks: monotonic RSS growth over the soak (sampler CSV column).
//   - DuckDB temp-spill growth: temp_directory size climbs with no cache benefit.
//   - Goroutine leaks: go_goroutines drifts upward from the 5-min steady state.
//   - Rate collapse: dropped_iterations > 0 means the scheduler fell behind.
//
// k6 thresholds (gate the long run):
//   http_req_failed rate < 0.005    — no sustained error budget burn
//   http_req_duration p(95) < 300ms — p95 must stay sane at 65% of knee
//   http_req_duration p(99) < 800ms — p99 headroom
//   dropped_iterations count == 0   — scheduler kept up = no rate collapse
//
// Pass/fail criteria for the authoritative EC2 run (read from k6 + soak_sample.csv):
//   - http_req_failed rate < 0.005 for the full DURATION — k6 threshold ✓
//   - dropped_iterations count == 0 (arrival-rate scheduler never fell behind)
//   - In soak_sample.csv: process_resident_memory_bytes peak < 1.5 GB AND
//     no monotonic upward drift (last-hour mean vs first-hour mean < 5% growth)
//   - go_goroutines is flat (end-of-soak within ±10% of 5-min-mark value)
//   - dmesg | grep -i 'killed process' -> 0 OOM kills
//   - CloudWatch CPUCreditBalance (t3.small) does not trend to 0 over the soak
//
// FIXTURE vs REAL gating:
//   ARTIFACT_KIND==='fixture'
//     - Emits a console.warn (mandatory for authoritative scenarios).
//     - Latency thresholds are relaxed (p95<5s, p99<15s) so the toy fixture
//       does not fail on meaningless latency numbers.
//     - dropped_iterations==0 and http_req_failed<0.005 remain active.
//   ARTIFACT_KIND==='real'
//     - Full authoritative gates: p95<300ms, p99<800ms.
//
// Available env overrides:
//   TARGET_RATE    (default 50)  — set to round(0.65 * measured_knee_rps) for real runs
//   DURATION       (default 2h)  — override with e.g. 10s for fixture mechanics
//   ZIPF_EXP       (default 1.1) — Zipfian skew exponent
//   KNEE_FRACTION  (default 0.65)— recorded in summary, not used to gate
//   BASE_URL, ARTIFACT_KIND      — standard config overrides
//
// Operational command (EC2 — Step 4b):
//   # 1. Determine knee with profile.js / step runs.
//   # 2. Co-run host sampler:
//   SAMPLE_INTERVAL=15 SAMPLE_OUT=soak_sample.csv \
//     BASE_URL=https://tfbindingandperturbation.com \
//     CONTAINER=tfbp bash tests/loadtest/k6/chaos/sampler.sh &
//   SAMP=$!
//   # 3. Run soak:
//   export BASE_URL=https://tfbindingandperturbation.com ARTIFACT_KIND=real
//   export TARGET_RATE=<round(0.65 * measured_knee_rps)> DURATION=2h ZIPF_EXP=1.1 KNEE_FRACTION=0.65
//   k6 run --out csv=soak.csv tests/loadtest/k6/scenarios/soak.js
//   kill "$SAMP"

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

const rate = parseInt(String(TARGET_RATE), 10);
const KNEE_FRACTION = parseFloat(__ENV.KNEE_FRACTION || '0.65'); // recorded, not gated

// --- Threshold gating: lenient for fixture mechanics, strict for real artifact ---
const isFixture = ARTIFACT_KIND !== 'real';

const latencyThresholds = isFixture
  ? ['p(95)<5000', 'p(99)<15000']
  : ['p(95)<300', 'p(99)<800'];

export const options = {
  scenarios: {
    soak: {
      executor: 'constant-arrival-rate',
      rate,
      timeUnit: '1s',
      duration: DURATION,                         // default 2h; override via env
      preAllocatedVUs: Math.max(20, rate * 4),
      maxVUs: Math.max(50, rate * 10),
    },
  },
  thresholds: {
    ...availabilityThresholds,                    // http_req_failed: rate<0.005
    http_req_duration: latencyThresholds,
    dropped_iterations: ['count==0'],             // scheduler kept up = no rate collapse
  },
};

// --- Custom metrics ---
const soakLatencyMs = new Trend('soak_latency_ms', true);
const cacheHit      = new Rate('soak_cache_hit');

export function setup() {
  if (ARTIFACT_KIND === 'fixture') {
    console.warn(
      'WARNING: soak: ARTIFACT_KIND=fixture — soak numbers are NOT authoritative; ' +
      'run against the real artifact on EC2 for >=2h per the operational block ' +
      'in the file header. Fixture run is mechanics-only (short DURATION override).',
    );
  }
  const version = resolveVersion();
  const allDatasets = ['callingcards', 'harbison', 'hackett'];
  const regulators = loadRegulators(version, ['callingcards', 'harbison']);
  const combos = datasetCombos(allDatasets);
  return { version, regulators, combos, kneeFraction: KNEE_FRACTION };
}

export default function (data) {
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

  // Zipf-skew the regulator so popular keys get realistic cache reuse.
  ctx.regulators = [makeZipf(data.regulators, parseFloat(String(ZIPF_EXP)))(Math.random())];

  const req = buildRequest(Math.random(), ctx);
  const res = http.request(req.method, req.url, null, { tags: req.tags });

  check(res, { 'status<500': (r) => r.status < 500 });
  soakLatencyMs.add(res.timings.duration);
  cacheHit.add(res.headers['X-Cache'] === 'HIT');
}

export function handleSummary(data) {
  // k6 does NOT pass setup() return data into handleSummary. Capture what we
  // need from data.metrics. Wrap any http call in try/catch — connection may be
  // recycled at run end. Never throw from handleSummary.
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

  const failedRate  = data.metrics.http_req_failed
    ? data.metrics.http_req_failed.values.rate : 0;
  const dropped     = data.metrics.dropped_iterations
    ? data.metrics.dropped_iterations.values.count : 0;
  const p95         = data.metrics.http_req_duration
    ? data.metrics.http_req_duration.values['p(95)'] : NaN;
  const p99         = data.metrics.http_req_duration
    ? data.metrics.http_req_duration.values['p(99)'] : NaN;
  const hitRate     = data.metrics.soak_cache_hit
    ? data.metrics.soak_cache_hit.values.rate : null;

  const stamp = {
    scenario: 'soak',
    artifactVersion: version,
    artifactKind: ARTIFACT_KIND,
    targetRate: rate,
    kneeFraction: KNEE_FRACTION,
    duration: DURATION,
    droppedIterations: dropped,
    httpReqFailedRate: failedRate,
    p95Ms: p95 && p95.toFixed ? Number(p95.toFixed(1)) : p95,
    p99Ms: p99 && p99.toFixed ? Number(p99.toFixed(1)) : p99,
    cacheHitRate: hitRate,
  };

  const lines = [
    `artifact: ${version} (${ARTIFACT_KIND})`,
    `target rate:         ${rate} req/s  (${(KNEE_FRACTION * 100).toFixed(0)}% of knee)`,
    `duration:            ${DURATION}`,
    `dropped_iterations:  ${dropped}  (MUST be 0 for a valid run)`,
    `http_req_failed:     ${(failedRate * 100).toFixed(3)}%  (budget: <0.5%)`,
    `p95 / p99:           ${stamp.p95Ms} ms / ${stamp.p99Ms} ms`,
    `soak_cache_hit:      ${hitRate != null ? (hitRate * 100).toFixed(1) + '%' : 'n/a'}`,
  ];

  if (!isFixture) {
    const passDropped = dropped === 0;
    const passFail    = failedRate < 0.005;
    const passP95     = !isNaN(p95) && p95 < 300;
    const verdict     = (passDropped && passFail && passP95) ? 'PASS' : 'FAIL';
    lines.push(
      `VERDICT: ${verdict}  ` +
      `(dropped=${passDropped ? '✓' : '✗'}  fail<0.5%=${passFail ? '✓' : '✗'}  p95<300ms=${passP95 ? '✓' : '✗'})`,
    );
    lines.push(
      'NOTE: Memory/goroutine/CPU-credit drift must be verified from soak_sample.csv ' +
      '(see operational pass criteria in the file header).',
    );
  } else {
    lines.push('VERDICT: MECHANICS ONLY (ARTIFACT_KIND=fixture — not authoritative)');
  }

  return {
    stdout: '\n=== soak ===\n' + lines.join('\n') + '\n',
    'soak.summary.json': JSON.stringify(stamp, null, 2),
  };
}
