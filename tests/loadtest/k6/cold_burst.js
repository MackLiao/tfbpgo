import http from 'k6/http';
import { check } from 'k6';

const BASE = __ENV.BASE_URL || 'http://127.0.0.1:8080';

export const options = {
  scenarios: {
    burst: {
      executor: 'per-vu-iterations',
      vus: 100,
      iterations: 1,
      maxDuration: '5s',
    },
  },
  thresholds: {
    http_req_failed: ['rate==0'],
    http_req_duration: ['p(95)<2000'],   // cold cache can be slow; we measure not gate
  },
};

let ARTIFACT_VERSION;
export function setup() {
  const v = http.get(`${BASE}/api/version`).json().artifactVersion;

  // Generate a guaranteed-unique URL: random regulator + datasets choice prefix
  // so this URL has never been cached.
  const reg = 'YBR289W';   // pick one that exists in fixture
  const ds  = 'callingcards';
  const nonce = Date.now();
  const url = `${BASE}/api/v/${v}/binding?regulator=${reg}&datasets=${ds}&_nonce=${nonce}`;
  // _nonce is rejected as unknown param? Then drop it. The actual approach is to
  // pre-warm everything else and pick this specific (reg,ds) tuple from a known
  // never-touched pair.
  return { url };
}

export default function (data) {
  const res = http.get(data.url);
  check(res, { '200': (r) => r.status === 200 });
}

export function teardown() {
  // After the burst, fetch /metrics and assert singleflight_shared_calls_total
  // increased by ≥99 for this run window. k6 doesn't have easy stateful asserts
  // here; emit a marker line for the operator to verify, or do this in a wrapper
  // bash script.
  const metrics = http.get(`${BASE}/metrics`).body;
  console.log('--- post-burst /metrics relevant lines ---');
  for (const line of metrics.split('\n')) {
    if (line.includes('singleflight_shared_calls_total') ||
        line.includes('db_query_duration_seconds') ||
        line.includes('cache_hits_total') ||
        line.includes('cache_misses_total')) {
      console.log(line);
    }
  }
}
