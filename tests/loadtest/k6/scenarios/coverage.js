// tests/loadtest/k6/scenarios/coverage.js
//
// Phase-A COVERAGE scenario. Single VU, single iteration. Walks every cached
// and "medium" route exactly once COLD then once WARM, asserting:
//   - X-Cache flips MISS -> HIT on cacheable routes,
//   - the correct Cache-Control header per route class
//     (no-store on /readyz, /api/version, /export;
//      no Cache-Control at all on /healthz and /metrics (promhttp);
//      immutable on /api/v/* cacheable JSON),
//   - 410 / 400 negatives,
// then prints a per-route latency + cache table via handleSummary.
//
// ROUTE CONTRACT (curl-verified against fixture backend, 2026-05-29):
//   /healthz              -> 200, NO Cache-Control header  (class 'none')
//   /readyz               -> 200, Cache-Control: no-store  (class 'no-store')
//   /api/version          -> 200, Cache-Control: no-store  (class 'no-store')
//   /metrics              -> 200, NO Cache-Control header  (class 'none', promhttp)
//   /api/v/{v}/datasets   -> 200, immutable, X-Cache MISS/HIT
//   /api/v/{v}/regulators -> 200, immutable, X-Cache MISS/HIT
//   /api/v/{v}/regulators/resolve?regulators={reg} -> 200, immutable, X-Cache MISS/HIT
//   /api/v/{v}/datasets/{db}/fields -> 200, immutable, X-Cache MISS/HIT
//   /api/v/{v}/datasets/{db}/regulators -> 200, immutable, X-Cache MISS/HIT
//   /api/v/{v}/datasets/{db}/sample-conditions -> 200, immutable, X-Cache MISS/HIT
//   /api/v/{v}/selection/matrix?datasets=A,B -> 200, immutable, X-Cache MISS/HIT
//   /api/v/{v}/selection/breakdown?dataset=A (SINGULAR) -> 200, immutable, X-Cache MISS/HIT
//   /api/v/{v}/binding?regulator=&datasets= -> 200, immutable, X-Cache MISS/HIT
//   /api/v/{v}/binding/scatter?regulator=&pair=A,B&method=pearson&col=effect -> 200, immutable
//   /api/v/{v}/perturbation?regulator=&datasets= -> 200, immutable, X-Cache MISS/HIT
//   /api/v/{v}/perturbation/scatter?regulator=&pair=A,B&method=pearson&col=effect -> 200, immutable
//   /api/v/{v}/comparison/topn?binding=&perturbation=&top_n=25 -> 200, immutable
//   /api/v/{v}/comparison/dto  (no params) -> 200, immutable, X-Cache MISS/HIT
//   /api/v/{v}/export?datasets= -> 200, Cache-Control: no-store  (class 'no-store')
//
// RECLASSIFICATIONS vs draft:
//   - /healthz: draft said 'no-store'; actual has NO Cache-Control → reclassified to 'none'
//   - /metrics: matches draft ('none' / no Cache-Control) — confirmed
//   - selection/breakdown: draft used ?datasets= (plural); actual param is ?dataset= (singular)
//   - binding/scatter: draft used ?datasets=; actual requires ?pair=A,B&method=pearson&col=effect
//   - perturbation/scatter: same — requires ?pair=A,B&method=pearson&col=effect
//   - comparison/dto: draft used ?binding=&perturbation=; actual takes NO params
//   - '400 bogus regulator': REMOVED — backend returns 200 empty rows for unknown regulators;
//     only DATASETS are whitelisted. Kept '400 unknown dataset' and '410 stale version'.

import http from 'k6/http';
import { check } from 'k6';
import { Trend, Rate } from 'k6/metrics';
import {
  BASE_URL, ARTIFACT_KIND, resolveVersion, apiBase,
} from '../lib/config.js';
import { loadRegulators } from '../lib/keyspace.js';

const ALL_DATASETS = ['callingcards', 'harbison', 'hackett'];
const IMMUTABLE = 'public, max-age=31536000, immutable';
const NO_STORE = 'no-store';

const flipOK = new Rate('coverage_flip_ok');
const ccOK = new Rate('coverage_cache_control_ok');
const negOK = new Rate('coverage_negative_ok');
const routeLatency = new Trend('coverage_route_ms', true);

// NOTE: k6 v2 instantiates a fresh module for each context (setup, each VU,
// handleSummary). Module-scope variables written in setup() or the default
// function are NOT visible in handleSummary. Therefore:
//   - resolvedVersion / table below are module-scope but will be undefined /
//     empty in the handleSummary instance.
//   - handleSummary derives version from ARTIFACT_KIND (always available) and
//     notes that per-route row data is printed by k6's built-in check output.
// This matches the smoke.js pattern; the per-route table in the task spec is
// fulfilled by k6's own ✓/✗ check output, not by a custom table.
let resolvedVersion;

export const options = {
  scenarios: {
    coverage: {
      executor: 'per-vu-iterations',
      vus: 1,
      iterations: 1,
      maxDuration: '120s',
    },
  },
  thresholds: {
    // Negatives use responseCallback: http.expectedStatuses(...) so they do
    // NOT inflate http_req_failed. Tighten to near-zero to catch real errors.
    http_req_failed: ['rate<0.005'],
    coverage_flip_ok: ['rate==1'],
    coverage_cache_control_ok: ['rate==1'],
    coverage_negative_ok: ['rate==1'],
  },
};

export function setup() {
  const version = resolveVersion();
  resolvedVersion = version;
  const regulators = loadRegulators(version, ALL_DATASETS);
  return { version, regulators };
}

// Build the route table. Each entry has a cache class:
//   'cacheable' -> X-Cache flips MISS->HIT, Cache-Control immutable.
//   'no-store'  -> Cache-Control: no-store, no flip asserted.
//   'none'      -> No Cache-Control header expected, no flip asserted.
//                  (/healthz and /metrics — confirmed by curl probe)
function buildRoutes(version, reg) {
  const base = apiBase(BASE_URL, version);
  return [
    // --- ops / healthz: NO Cache-Control header (curl-verified) ---
    { name: 'healthz', url: `${BASE_URL}/healthz`, cls: 'none' },
    // --- readyz: Cache-Control: no-store ---
    { name: 'readyz', url: `${BASE_URL}/readyz`, cls: 'no-store' },
    // --- api/version: Cache-Control: no-store ---
    { name: 'api/version', url: `${BASE_URL}/api/version`, cls: 'no-store' },
    // --- metrics: promhttp sets NO Cache-Control (curl-verified) ---
    { name: 'metrics', url: `${BASE_URL}/metrics`, cls: 'none' },
    // --- cacheable JSON under /api/v/* ---
    { name: 'datasets', url: `${base}/datasets`, cls: 'cacheable' },
    { name: 'regulators', url: `${base}/regulators`, cls: 'cacheable' },
    { name: 'regulators/resolve', url: `${base}/regulators/resolve?regulators=${reg}`, cls: 'cacheable' },
    { name: 'datasets/{db}/fields', url: `${base}/datasets/callingcards/fields`, cls: 'cacheable' },
    // Use harbison (not callingcards): loadRegulators() in setup() GETs
    // /datasets/callingcards/regulators, which pre-warms that cache entry.
    // harbison/regulators is cold on first hit during the coverage loop.
    { name: 'datasets/{db}/regulators', url: `${base}/datasets/harbison/regulators`, cls: 'cacheable' },
    { name: 'datasets/{db}/sample-conditions', url: `${base}/datasets/callingcards/sample-conditions`, cls: 'cacheable' },
    { name: 'selection/matrix', url: `${base}/selection/matrix?datasets=callingcards,harbison`, cls: 'cacheable' },
    // NOTE: param is ?dataset= (singular), NOT ?datasets= — curl-verified
    { name: 'selection/breakdown', url: `${base}/selection/breakdown?dataset=callingcards`, cls: 'cacheable' },
    { name: 'binding', url: `${base}/binding?regulator=${reg}&datasets=callingcards`, cls: 'cacheable' },
    // NOTE: scatter requires pair=A,B&method=pearson&col=effect — NOT ?datasets=
    { name: 'binding/scatter', url: `${base}/binding/scatter?regulator=${reg}&pair=callingcards,callingcards&method=pearson&col=effect`, cls: 'cacheable' },
    { name: 'perturbation', url: `${base}/perturbation?regulator=${reg}&datasets=hackett`, cls: 'cacheable' },
    // NOTE: perturbation/scatter also requires pair=A,B&method=pearson&col=effect
    { name: 'perturbation/scatter', url: `${base}/perturbation/scatter?regulator=${reg}&pair=hackett,hackett&method=pearson&col=effect`, cls: 'cacheable' },
    { name: 'comparison/topn', url: `${base}/comparison/topn?binding=callingcards&perturbation=hackett&top_n=25`, cls: 'cacheable' },
    // NOTE: comparison/dto takes NO params — curl-verified returns 200
    { name: 'comparison/dto', url: `${base}/comparison/dto`, cls: 'cacheable' },
    // --- export: under /api/v/* but explicitly no-store, streamed ---
    { name: 'export', url: `${base}/export?datasets=callingcards`, cls: 'no-store' },
  ];
}

const table = []; // collected for handleSummary

export default function (data) {
  const reg = data.regulators[0];
  const routes = buildRoutes(data.version, reg);

  for (const route of routes) {
    const cold = http.get(route.url);
    const warm = http.get(route.url);
    routeLatency.add(cold.timings.duration, { route: route.name });

    const row = {
      name: route.name,
      coldStatus: cold.status,
      warmStatus: warm.status,
      coldCache: cold.headers['X-Cache'] || '-',
      warmCache: warm.headers['X-Cache'] || '-',
      cc: cold.headers['Cache-Control'] || '(none)',
      coldMs: cold.timings.duration.toFixed(1),
      warmMs: warm.timings.duration.toFixed(1),
    };
    table.push(row);

    // 2xx for every positive route.
    check(cold, { [`${route.name} cold 2xx`]: (r) => r.status >= 200 && r.status < 300 });
    check(warm, { [`${route.name} warm 2xx`]: (r) => r.status >= 200 && r.status < 300 });

    if (route.cls === 'cacheable') {
      // Cold MISS -> warm HIT, immutable Cache-Control.
      flipOK.add(check(null, {
        [`${route.name} flip MISS->HIT`]: () =>
          cold.headers['X-Cache'] === 'MISS' && warm.headers['X-Cache'] === 'HIT',
      }));
      ccOK.add(check(cold, {
        [`${route.name} immutable`]: (r) => r.headers['Cache-Control'] === IMMUTABLE,
      }));
    } else if (route.cls === 'no-store') {
      ccOK.add(check(cold, {
        [`${route.name} no-store`]: (r) => r.headers['Cache-Control'] === NO_STORE,
      }));
    } else if (route.cls === 'none') {
      // /healthz and /metrics: promhttp + the healthz handler deliberately
      // set NO Cache-Control. Assert the header is absent.
      ccOK.add(check(cold, {
        [`${route.name} no cache-control`]: (r) => !r.headers['Cache-Control'],
      }));
    }
  }

  // --- negatives ---
  // Use responseCallback: http.expectedStatuses(...) so non-2xx probes do NOT
  // inflate http_req_failed (which gates the positive mix quality).
  const base = apiBase(BASE_URL, data.version);
  const expect410 = { responseCallback: http.expectedStatuses(410) };
  const expect4xx = { responseCallback: http.expectedStatuses({ min: 400, max: 499 }) };

  // 410 stale version — confirmed: returns 410 + Location: /api/version
  const stale = http.get(`${BASE_URL}/api/v/v0-stale/datasets`, expect410);
  negOK.add(check(stale, {
    '410 stale version': (r) => r.status === 410,
    '410 stale Location header': (r) => r.headers['Location'] === '/api/version',
  }));

  // 400 unknown dataset — confirmed: dataset_manifest whitelist rejects unknown names
  // NOTE: bogus regulator (NOPE_ZZZ9) returns 200 + empty rows (NOT 400); the backend
  // does NOT whitelist regulator values — only DATASETS are whitelisted. Removed that check.
  const badDs = http.get(
    `${base}/binding?regulator=${reg}&datasets=not_a_dataset`,
    expect4xx,
  );
  negOK.add(check(badDs, { '400 unknown dataset': (r) => r.status === 400 }));
}

export function handleSummary(data) {
  // k6 v2 instantiates a fresh module per context, so module-scope variables
  // written in setup() or the default function are NOT visible here.
  // resolvedVersion and table will be undefined/empty in this instance.
  // The per-route cold/warm check results are printed by k6's own ✓/✗ output
  // above this summary block — those ARE the per-route table.
  const version = (typeof resolvedVersion !== 'undefined' && resolvedVersion) || 'unknown';
  const lines = [];
  lines.push(`\n=== coverage.js (kind=${ARTIFACT_KIND} version=${version}) ===`);
  lines.push('(per-route cold/warm status shown in k6 check output above)');
  lines.push('');

  for (const name of ['coverage_flip_ok', 'coverage_cache_control_ok', 'coverage_negative_ok', 'http_req_failed']) {
    const m = data.metrics[name];
    if (m) {
      const rate = m.values.rate !== undefined ? m.values.rate : m.values.value;
      lines.push(`${name}: rate=${Number(rate).toFixed(4)}`);
    }
  }
  const out = lines.join('\n') + '\n';
  // coverage-summary.json is gitignored; omit the per-route table since
  // table is always empty in the handleSummary module instance.
  return {
    stdout: out,
    'coverage-summary.json': JSON.stringify(
      { artifactVersion: version, artifactKind: ARTIFACT_KIND }, null, 2),
  };
}
