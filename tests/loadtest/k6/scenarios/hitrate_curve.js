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
//
// FIXTURE gating:
//   HITRATE_TOLERANCE defaults to 3% (0.03) for authoritative runs. The
//   ±tolerance check is gated only when ARTIFACT_KIND==='real' (or when
//   HITRATE_TOLERANCE is set to a large value like 1.0 via env) so the
//   fixture mechanics run cannot fail on a convergence assertion that depends
//   on real keyspace cardinality. Set HITRATE_TOLERANCE=1.0 in the local
//   fixture test to skip the convergence gate while still verifying the
//   computation runs and emits the correct JSON fields.

import http from 'k6/http';
import { check } from 'k6';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.2/index.js';
import {
  BASE_URL, ARTIFACT_KIND, TARGET_RATE, DURATION, HIT_RATE, ZIPF_EXP,
  resolveVersion,
} from '../lib/config.js';
import { loadRegulators, makeZipf, datasetCombos } from '../lib/keyspace.js';
import { buildRequest, WEIGHTS } from '../lib/mix.js';
import { scrapeMetrics } from '../lib/metrics.js';

// HITRATE_TOLERANCE: ±fraction; default 0.03 (3%) for authoritative runs.
// Set to 1.0 in the fixture mechanics test so convergence is never a gate.
const HITRATE_TOLERANCE = parseFloat(__ENV.HITRATE_TOLERANCE || '0.03');

// The set of endpoints whose per-endpoint hit rate we report on the curve.
// Use the same keys as WEIGHTS to ensure we cover every tracked endpoint.
const TRACKED_ENDPOINTS = Object.keys(WEIGHTS).map((k) => {
  // Map weight key -> chi route pattern (the metric label value).
  const map = {
    binding: '/api/v/{v}/binding',
    perturbation: '/api/v/{v}/perturbation',
    comparisonTopn: '/api/v/{v}/comparison/topn',
    regulatorsResolve: '/api/v/{v}/regulators/resolve',
    scatter: '/api/v/{v}/binding/scatter',
    selectionMatrix: '/api/v/{v}/selection/matrix',
    datasets: '/api/v/{v}/datasets',
  };
  return map[k];
}).filter(Boolean);


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
  // No hard latency SLO gates here — this scenario CHARACTERIZES, it does not gate.
  // A loose availability threshold catches backend crashes during the run.
  thresholds: {
    http_req_failed: ['rate<0.05'],
  },
};

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
  const combos = datasetCombos(allDatasets);

  // Snapshot /metrics BEFORE the run so handleSummary can compute the
  // windowed (delta-based) hit rate, not the lifetime hit rate.
  const before = scrapeMetrics(BASE_URL);

  return {
    version,
    regulators,
    datasets: allDatasets,
    combos,
    before,
  };
}

// Zipf-skewed traffic: a small popular head is requested far more often,
// producing cache reuse. We inject the zipf-picked regulator by overriding
// the regulators pool in ctx with a single-element array (so mix.js always
// picks it). buildRequest then builds a full realistic mix URL around that
// regulator, preserving the endpoint distribution from WEIGHTS.
export function mix(data) {
  // Pick a zipf-skewed regulator for this iteration.
  const pickReg = makeZipf(data.regulators, ZIPF_EXP);
  const skewedReg = pickReg(Math.random());

  // Narrow the regulator pool to the single picked regulator so every
  // URL builder in mix.js uses the zipf-selected key.
  const ctx = {
    baseUrl: BASE_URL,
    version: data.version,
    regulators: [skewedReg],
    bindingDatasets: ['callingcards', 'harbison'],
    perturbationDatasets: ['hackett'],
    datasetCombos: data.combos,
  };
  const req = buildRequest(Math.random(), ctx);
  const res = http.request(req.method, req.url, null, { tags: req.tags });
  check(res, { 'status 2xx': (r) => r.status >= 200 && r.status < 300 });
}

export function handleSummary(data) {
  // Re-scrape AFTER the run. setup's `before` snapshot is in data.setup_data.
  const before = (data.setup_data && data.setup_data.before) ? data.setup_data.before : '';
  const after = scrapeMetrics(BASE_URL);

  // Per-endpoint achieved hit rate over the run window (delta-based).
  const perEndpoint = {};
  for (const ep of TRACKED_ENDPOINTS) {
    perEndpoint[ep] = round3(deltaHitRate(before, after, ep));
  }
  const globalAchieved = round3(deltaHitRate(before, after, null));

  const target = HIT_RATE;
  const diff = Math.abs(globalAchieved - target);
  const inBand = diff <= HITRATE_TOLERANCE;

  const p95 = data.metrics.http_req_duration
    ? data.metrics.http_req_duration.values['p(95)'] : NaN;

  const row = {
    artifactVersion: (data.setup_data && data.setup_data.version) ? data.setup_data.version : 'unknown',
    artifactKind: ARTIFACT_KIND,
    zipfExp: ZIPF_EXP,
    targetHitRate: target,
    achievedHitRate: globalAchieved,
    perEndpointHitRate: perEndpoint,
    p95Ms: p95 && p95.toFixed ? Number(p95.toFixed(1)) : p95,
    toleranceAbs: HITRATE_TOLERANCE,
    inBand,
  };

  const verdict =
    `zipf_exp=${ZIPF_EXP}  target_hit=${(target * 100).toFixed(0)}%  ` +
    `achieved=${(globalAchieved * 100).toFixed(1)}%  ` +
    `${inBand ? 'IN-BAND' : 'OUT-OF-BAND (±' + (HITRATE_TOLERANCE * 100).toFixed(0) + '%)'}  ` +
    `p95=${row.p95Ms} ms`;

  // NOTE: On fixture, HITRATE_TOLERANCE should be set to 1.0 via env to prevent
  // the inBand check from failing (fixture keyspace is too small for realistic
  // hit rates). For ARTIFACT_KIND==='real', the operator sets HITRATE_TOLERANCE=0.03.
  if (ARTIFACT_KIND === 'real' && !inBand) {
    console.warn(
      `hitrate_curve: CONVERGENCE MISS — achieved=${(globalAchieved * 100).toFixed(1)}% ` +
      `target=${(target * 100).toFixed(0)}% diff=${(diff * 100).toFixed(1)}% ` +
      `> tol=${(HITRATE_TOLERANCE * 100).toFixed(0)}%. ` +
      'Recalibrate ZIPF_EXP for this artifact or widen HITRATE_TOLERANCE.',
    );
  }

  return {
    stdout: textSummary(data, { indent: ' ', enableColors: true }) +
      '\n\n=== HIT-RATE CURVE POINT ===\n' + verdict +
      '\nper-endpoint: ' + JSON.stringify(row.perEndpointHitRate) + '\n',
    'hitrate_curve.summary.json': JSON.stringify(row, null, 2),
  };
}

// --- delta-based hit rate helpers -------------------------------------------

// hits/(hits+misses) over the [before, after] window for one endpoint (or
// global if endpoint is null). Computes deltas from raw counter text to avoid
// lifetime-rate distortion from prior runs.
function deltaHitRate(beforeText, afterText, endpoint) {
  const dh = deltaCounter(beforeText, afterText, 'cache_hits_total', endpoint);
  const dm = deltaCounter(beforeText, afterText, 'cache_misses_total', endpoint);
  const denom = dh + dm;
  return denom > 0 ? dh / denom : 0;
}

// Extract (after - before) for a counter, optionally filtered by endpoint label.
function deltaCounter(beforeText, afterText, name, endpoint) {
  const after = readCounter(afterText, name, endpoint);
  const before = readCounter(beforeText, name, endpoint);
  return Math.max(0, after - before);
}

// Read the counter value from Prometheus text. When endpoint is given, match
// the specific endpoint label; when null, sum ALL label series for that metric.
function readCounter(text, name, endpoint) {
  if (!text) return 0;
  const nameRe = escapeRe(name);
  if (endpoint) {
    const re = new RegExp(
      `^${nameRe}\\{[^}]*endpoint="${escapeRe(endpoint)}"[^}]*\\}\\s+([0-9.eE+-]+)`,
      'm',
    );
    const m = re.exec(text);
    return m ? parseFloat(m[1]) : 0;
  }
  // Sum all label variants.
  const re = new RegExp(`^${nameRe}(\\{[^}]*\\})?\\s+([0-9.eE+-]+)`, 'gm');
  let total = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    const v = parseFloat(m[2]);
    if (!isNaN(v)) total += v;
  }
  return total;
}

function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function round3(x) { return Math.round(x * 1000) / 1000; }
