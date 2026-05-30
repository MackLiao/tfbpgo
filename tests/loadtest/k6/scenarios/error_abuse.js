// tests/loadtest/k6/scenarios/error_abuse.js
//
// Phase-C error-path flood + maximal-legal payload scenario.
//
// Open-model (constant-arrival-rate) mix of four request kinds:
//
//   (1) 410 arm  (~30%): stale artifact version -> 410 Gone + Location: /api/version.
//       No SQL, no cache lookup. Must be the cheapest path.
//
//   (2) 400 arm  (~25%): bogus / injection-shaped dataset name -> 400.
//       Identifier whitelisting rejects before DB access.
//
//   (3) 405 arm  (~20%): POST on a GET-only route -> 405.
//       chi MethodNotAllowed — no handler logic executes.
//
//   (4) legalmax (~25%): maximal-LEGAL payloads that are accepted (200) but
//       bounded — top_n=1000, all datasets, ~16KiB filters, 64-char search.
//       These exercise the DB and are the only arm that should consume a pool
//       connection. Key assertions: NOT 5xx, and the MaxFiltersBytes=16384
//       cap ensures the filter is accepted (not rejected like the >16KiB arm
//       in smoke.js's negative suite).
//
// Goals:
//   - Reject paths (410/400/405) must NOT consume a DB connection.
//   - No 5xx: every reject is a deliberate 4xx.
//   - `dropped_iterations count==0`: arrival rate is sustainable (server keeps up).
//   - Reject-path p95 < 50 ms, p99 < 150 ms.
//
// FIXTURE NOTE: The committed test fixture is tiny; legalmax filter payloads
//   referencing unknown fields may return 400 (acceptable — the cap assertion
//   is "not 5xx"). The authoritative reject-path latency gate (p95<50ms) is
//   meaningful only on EC2.
//
// Authoritative EC2 run (Step 4b of task_22.md):
//   cd /opt/tfbp
//   SAMPLE_INTERVAL=1 SAMPLE_OUT=error_abuse_sample.csv \
//     BASE_URL=https://tfbindingandperturbation.com CONTAINER=tfbp \
//     bash tests/loadtest/k6/chaos/sampler.sh &
//   SAMP=$!
//   export BASE_URL=https://tfbindingandperturbation.com ARTIFACT_KIND=real
//   export TARGET_RATE=500 DURATION=2m
//   k6 run --out csv=error_abuse.csv tests/loadtest/k6/scenarios/error_abuse.js
//   kill "$SAMP"

import http from 'k6/http';
import { check } from 'k6';
import {
  BASE_URL, ARTIFACT_KIND, TARGET_RATE, DURATION, resolveVersion, apiBase,
} from '../lib/config.js';
import { loadRegulators } from '../lib/keyspace.js';
import { openModelThresholds } from '../thresholds.js';

const _rate     = parseInt(__ENV.TARGET_RATE || String(TARGET_RATE || '200'), 10);
const _duration = __ENV.DURATION || DURATION || '2m';

export const options = {
  scenarios: {
    abuse: {
      executor: 'constant-arrival-rate',
      rate: _rate,
      timeUnit: '1s',
      duration: _duration,
      preAllocatedVUs: Math.max(50, _rate),
      maxVUs: Math.max(200, _rate * 4),
    },
  },
  thresholds: {
    // openModelThresholds: http_req_failed rate==0, dropped_iterations count==0.
    // We deliberately exclude the global http_req_duration gate from
    // openModelThresholds so the legalmax arm (which runs real queries) does
    // not create a race against the reject-path p95 gate.
    http_req_failed:    openModelThresholds.http_req_failed,
    dropped_iterations: openModelThresholds.dropped_iterations,
    // The key gate: reject paths (410/400/405) must be cheap — no SQL, no marshal.
    'http_req_duration{kind:reject}': ['p(95)<50', 'p(99)<150'],
  },
};

// Build a filter JSON string that is LEGAL (< 16 KiB) but referencing a large
// list of integer values to pad the payload. On the real artifact this exercises
// the MaxFiltersBytes=16384 cap (just under it) for the 'time' field of the
// 'hackett' dataset (numeric field, always present in field_manifest). On the
// fixture 'time' is the only hackett field, so the filter parses and is applied.
// The large value list uses the numeric type so the server casts to two floats
// — the first two elements become the [lo, hi] range; the rest are ignored.
// The important invariant: NOT 5xx. A 400 ("value out of range" or similar) is
// also acceptable; the cap must never cause a 500.
function buildLegalFilter() {
  const vals = [];
  for (let i = 0; i < 1800; i++) vals.push(i);
  // FiltersByDB outer shape: {dataset: {field: {type, value}}}
  // hackett/time is a numeric field present in the test fixture.
  const inner = { time: { type: 'numeric', value: vals } };
  let s = JSON.stringify({ hackett: inner });
  if (s.length > 16 * 1024) {
    // Stay just under MaxFiltersBytes=16384; truncate the value array JSON.
    s = s.slice(0, 16 * 1024 - 4) + ']}}}';
  }
  return s;
}

// 64-character search string — exactly at the MaxSearchChars=64 boundary (legal).
const SEARCH_64 = 'Y'.repeat(64);

// Module-scope version for handleSummary (k6 does not pass setup() data in).
let _version = 'unknown';

export function setup() {
  if (ARTIFACT_KIND === 'fixture') {
    console.warn(
      'error_abuse: ARTIFACT_KIND=fixture — reject-path latency numbers are indicative only; ' +
      'run on EC2 at TARGET_RATE=500 for the authoritative p95<50ms gate.',
    );
  }

  const version   = resolveVersion();
  _version        = version;
  const regulators = loadRegulators(version, ['callingcards', 'harbison']);
  return { version, regulators, bigFilter: buildLegalFilter() };
}

export default function (data) {
  const r    = Math.random();
  const base = apiBase(BASE_URL, data.version);
  // Root of the API (strips /api/v/{v} prefix) for building stale URLs.
  const root = base.replace(/\/api\/v\/[^/]+$/, '');

  if (r < 0.30) {
    // ── 410 arm: stale artifact version ──────────────────────────────────
    // The version string '1970-01-01' will never match the artifact version;
    // the RequireArtifactVersion middleware returns 410 + Location: /api/version.
    // No DB access, no cache lookup. Cheapest possible reject.
    const res = http.get(
      `${root}/api/v/1970-01-01/datasets`,
      {
        tags: { endpoint: '/api/v/{v}/datasets', kind: 'reject', expect: '410' },
        responseCallback: http.expectedStatuses(410),
      },
    );
    check(res, {
      '410 gone': (x) => x.status === 410,
      '410 has Location header': (x) => x.headers['Location'] === '/api/version',
    });

  } else if (r < 0.55) {
    // ── 400 arm: bogus / injection-shaped dataset identifier ─────────────
    // "xyz';DROP--" is not in dataset_manifest; CheckDataset() returns 400
    // before any SQL executes. Tests the identifier-whitelisting fast path.
    const res = http.get(
      `${base}/binding?regulator=YBR289W&datasets=${encodeURIComponent("xyz';DROP--")}`,
      {
        tags: { endpoint: '/api/v/{v}/binding', kind: 'reject', expect: '400' },
        responseCallback: http.expectedStatuses(400),
      },
    );
    check(res, { '400 bad identifier': (x) => x.status === 400 });

  } else if (r < 0.75) {
    // ── 405 arm: POST on a GET-only route ────────────────────────────────
    // chi's MethodNotAllowed is returned immediately by the router — the
    // handler never executes. Should be the fastest of all paths.
    const res = http.request(
      'POST',
      `${base}/binding?regulator=YBR289W&datasets=callingcards`,
      null,
      {
        tags: { endpoint: '/api/v/{v}/binding', kind: 'reject', expect: '405' },
        responseCallback: http.expectedStatuses(405),
      },
    );
    check(res, { '405 method not allowed': (x) => x.status === 405 });

  } else {
    // ── legalmax arm: maximal LEGAL payloads ─────────────────────────────
    // These are accepted (or 400 on unknown field) but never 5xx.
    // They exercise the DB path and the MaxFiltersBytes + MaxSearchChars caps.

    // (a) top_n=1000 + ~16KiB filters (legal, just under cap).
    const topnURL = `${base}/comparison/topn?binding=callingcards&perturbation=hackett&top_n=1000` +
      `&filters=${encodeURIComponent(data.bigFilter)}`;
    const topnRes = http.get(topnURL, {
      tags: { endpoint: '/api/v/{v}/comparison/topn', kind: 'legalmax', expect: '200or400' },
    });
    // On the fixture the 'strain' field may not exist in the whitelist -> 400.
    // Key assertion: not 5xx. The cap (16KiB) must never cause a 500.
    check(topnRes, { 'legalmax topn not 5xx': (x) => x.status < 500 });

    // (b) 64-char search boundary (legal, exactly at MaxSearchChars=64).
    const reg = data.regulators[Math.floor(Math.random() * data.regulators.length)];
    const searchRes = http.get(
      `${base}/regulators?search=${encodeURIComponent(SEARCH_64)}`,
      { tags: { endpoint: '/api/v/{v}/regulators', kind: 'legalmax', expect: '200' } },
    );
    check(searchRes, { 'search 64-char ok': (x) => x.status === 200 || x.status === 400 });
  }
}

export function handleSummary(data) {
  return {
    stdout: JSON.stringify({
      scenario: 'error_abuse',
      artifactKind: ARTIFACT_KIND,
      artifactVersion: _version,
      targetRate: _rate,
      duration: _duration,
    }, null, 2) + '\n',
    'error_abuse.summary.json': JSON.stringify(data, null, 2),
  };
}
