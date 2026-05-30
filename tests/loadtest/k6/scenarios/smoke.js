// tests/loadtest/k6/scenarios/smoke.js
//
// Phase-A FIXTURE smoke test. Runs ~20 req/s for 20-60s over the full
// endpoint mix (lib/mix.js), interleaving NEGATIVE checks that assert the
// backend's documented 4xx/410/405 behavior and the X-Cache MISS->HIT flip.
//
// Thresholds gate ERRORS ONLY. We deliberately set NO absolute-ms gate here:
// on the tiny committed fixture, latency is meaningless. Authoritative perf
// numbers come from scenarios/profile.js against ARTIFACT_KIND=real.
import http from 'k6/http';
import { check } from 'k6';
import { Rate } from 'k6/metrics';
import {
  BASE_URL, ARTIFACT_KIND, resolveVersion, apiBase,
} from '../lib/config.js';
import { loadRegulators, datasetCombos } from '../lib/keyspace.js';
import { buildRequest } from '../lib/mix.js';
import { availabilityThresholds } from '../thresholds.js';

const ALL_DATASETS = ['callingcards', 'harbison', 'hackett'];

// Custom rates so a single failed negative check trips the threshold.
const negative4xx = new Rate('smoke_negative_4xx_ok');
const cacheFlip = new Rate('smoke_cache_flip_ok');
const readyzUp = new Rate('readyz_available');

// Module-scope resolved version — set in setup(), read in handleSummary().
// k6 does NOT pass setup() return data into handleSummary, so we capture it here.
let resolvedVersion;

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
  resolvedVersion = version;
  const regulators = loadRegulators(version, ALL_DATASETS);
  const combos = datasetCombos(ALL_DATASETS);
  return { version, regulators, combos };
}

export default function (data) {
  // ctx shape MUST match mix.js exactly: baseUrl, version, regulators,
  // bindingDatasets, perturbationDatasets, datasetCombos.
  const ctx = {
    baseUrl: BASE_URL,
    version: data.version,
    regulators: data.regulators,
    bindingDatasets: ['callingcards', 'harbison'],
    perturbationDatasets: ['hackett'],
    datasetCombos: data.combos,
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
    runNegatives(data.version, data.regulators);
    runCacheFlip(data.version, data.regulators);
  }
}

// NEGATIVE CHECKS — assert the backend's documented rejection behavior.
//
// ACTUAL BEHAVIORS OBSERVED (curl-verified against fixture backend):
//  1. bogus regulator -> 200 with empty rows (NOT 400); backend does not whitelist
//     regulator values. Instead we test "missing regulator" -> 400, and
//     "bogus dataset" -> 400 (dataset IS whitelisted via dataset_manifest).
//  2. stale /api/v/{old} -> 410 + Location: /api/version  [as documented]
//  3. >16KiB filters -> 400 + Cache-Control: no-store  [as documented]
//  4. top_n=0 -> 200 + topN:1 (JSON field is "topN" camelCase, NOT "top_n")
//     top_n=99999 -> 200 + topN:1000  [as documented, but field name differs from draft]
//  5. >32 query keys -> 400 + body {"error":"too many query parameters"}  [as documented]
//  6. POST /api/version -> 405  [as documented]
//
// All expected-error requests use responseCallback: http.expectedStatuses(...)
// to prevent them from inflating http_req_failed (which tracks the positive mix).
function runNegatives(version, regulators) {
  const base = apiBase(BASE_URL, version);
  // Params telling k6 that 4xx/5xx is the EXPECTED outcome for these probes,
  // so they don't inflate http_req_failed.
  const expect4xx = { responseCallback: http.expectedStatuses({ min: 400, max: 499 }) };
  const expect410 = { responseCallback: http.expectedStatuses(410) };
  const expect405 = { responseCallback: http.expectedStatuses(405) };

  // 1. Missing required param -> 400.
  //    Bogus regulator strings return 200+empty rows; missing param is rejected.
  const missingReg = http.get(`${base}/binding?datasets=callingcards`, expect4xx);
  negative4xx.add(check(missingReg, {
    'missing regulator -> 400': (r) => r.status === 400,
  }));

  // 2. Bogus dataset name -> 400 (not in dataset_manifest whitelist).
  const bogusDs = http.get(
    `${base}/binding?regulator=${regulators[0]}&datasets=BOGUS_DATASET_ZZZ`,
    expect4xx,
  );
  negative4xx.add(check(bogusDs, {
    'bogus dataset -> 400': (r) => r.status === 400,
  }));

  // 3. stale /api/v/{old} -> 410 Gone + Location advisory.
  const stale = http.get(`${BASE_URL}/api/v/v0-does-not-exist/datasets`, expect410);
  negative4xx.add(check(stale, {
    'stale version -> 410': (r) => r.status === 410,
    'stale version Location header': (r) => r.headers['Location'] === '/api/version',
  }));

  // 4. >16KiB ?filters= -> 400 (validateLength, MaxFiltersBytes=16*1024).
  //    Build a JSON object whose stringified form exceeds 16384 bytes but
  //    stays under the 32KiB RequestGuard per-value cap so we exercise the
  //    handler-level length check, not the guard.
  const big = 'x'.repeat(17000);
  const filtersTooBig = encodeURIComponent(JSON.stringify({ junkpad: big }));
  const bigFilters = http.get(
    `${base}/binding?regulator=${regulators[0]}&datasets=callingcards&filters=${filtersTooBig}`,
    expect4xx,
  );
  negative4xx.add(check(bigFilters, {
    '>16KiB filters -> 400': (r) => r.status === 400,
  }));

  // 5. top_n clamp to [1, 1000]: top_n=0 -> topN==1; top_n=99999 -> topN==1000.
  //    NOTE: The JSON field is "topN" (camelCase), NOT "top_n" as the draft assumed.
  //    These are 200 responses — no expectedStatuses override needed.
  const lo = http.get(`${base}/comparison/topn?binding=callingcards&perturbation=hackett&top_n=0`);
  const hi = http.get(`${base}/comparison/topn?binding=callingcards&perturbation=hackett&top_n=99999`);
  negative4xx.add(check(lo, {
    'top_n=0 -> 200': (r) => r.status === 200,
    'top_n=0 clamps to topN=1': (r) => {
      if (r.status !== 200) return false;
      try { return r.json('topN') === 1; } catch (_) { return false; }
    },
  }));
  negative4xx.add(check(hi, {
    'top_n=99999 -> 200': (r) => r.status === 200,
    'top_n=99999 clamps to topN=1000': (r) => {
      if (r.status !== 200) return false;
      try { return r.json('topN') === 1000; } catch (_) { return false; }
    },
  }));

  // 6. >32 distinct query keys -> RequestGuard 400 (MaxQueryKeys=32).
  const parts = [`regulator=${regulators[0]}`, 'datasets=callingcards'];
  for (let i = 0; i < 40; i++) parts.push(`junk${i}=1`);
  const manyKeys = http.get(`${base}/binding?${parts.join('&')}`, expect4xx);
  negative4xx.add(check(manyKeys, {
    '>32 query keys -> 400': (r) => r.status === 400,
    '>32 query keys message': (r) => r.status === 400 && String(r.body).includes('too many query parameters'),
  }));

  // 7. non-GET on a registered route -> 405 (chi MethodNotAllowed default).
  const post = http.post(`${BASE_URL}/api/version`, null, expect405);
  negative4xx.add(check(post, {
    'POST /api/version -> 405': (r) => r.status === 405,
  }));
}

// CACHE-FLIP CHECK — first hit MISS, second identical hit HIT.
function runCacheFlip(version, regulators) {
  const base = apiBase(BASE_URL, version);
  // Unique-per-VU-iteration regulator so the key is genuinely cold the first
  // time within this iteration (the fixture set is small; pick by index).
  const reg = regulators[(__VU + __ITER) % regulators.length];
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
  // k6 does NOT pass setup() return into handleSummary; use module-scope var.
  const stamp = {
    artifactVersion: resolvedVersion || 'unknown',
    artifactKind: ARTIFACT_KIND,
  };
  const summary = buildTextSummary(data, stamp);
  return {
    stdout: summary,
    'smoke-summary.json': JSON.stringify({ ...stamp, metrics: data.metrics }, null, 2),
  };
}

function buildTextSummary(data, stamp) {
  const lines = [];
  lines.push(`\n=== smoke.js summary (kind=${stamp.artifactKind} version=${stamp.artifactVersion}) ===`);
  try {
    const checks = data.metrics.checks;
    if (checks) {
      lines.push(`checks passes=${checks.values.passes} fails=${checks.values.fails}`);
    }
    for (const name of ['smoke_negative_4xx_ok', 'smoke_cache_flip_ok', 'readyz_available', 'http_req_failed']) {
      const m = data.metrics[name];
      if (m) {
        const rate = m.values.rate !== undefined ? m.values.rate : m.values.value;
        lines.push(`${name}: rate=${Number(rate).toFixed(4)}`);
      }
    }
  } catch (_e) {
    lines.push('(summary error: ' + String(_e) + ')');
  }
  return lines.join('\n') + '\n';
}
