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

export function setup() {
  const v = http.get(`${BASE}/api/version`).json().artifactVersion;

  // Pre-flight: snapshot cache_hits_total so teardown can compare deltas.
  // The operator MUST restart the backend immediately before running this
  // script (see README) so that ristretto is empty. We pick YML007W to
  // avoid colliding with profile.js's YBR289W warm-cache priming.
  const metricsBefore = http.get(`${BASE}/metrics`).body;
  const cacheHitsLine = (metricsBefore.match(/^cache_hits_total \d+/m) || [''])[0];
  const cacheHitsCount = parseInt((cacheHitsLine.match(/\d+/) || ['0'])[0], 10);
  if (cacheHitsCount > 0) {
    console.warn(
      `cold_burst: cache_hits_total=${cacheHitsCount} before burst; backend is NOT cold. ` +
      `Restart the backend before running this script (see tests/loadtest/k6/README.md).`,
    );
  }

  const url = `${BASE}/api/v/${v}/binding?regulator=YML007W&datasets=callingcards`;
  return { url, cacheHitsBefore: cacheHitsLine };
}

export default function (data) {
  const res = http.get(data.url);
  check(res, { '200': (r) => r.status === 200 });
}

export function teardown(data) {
  // After the burst, fetch /metrics and emit the relevant lines for the operator
  // to verify against tests/loadtest-summary.md.
  const metricsAfter = http.get(`${BASE}/metrics`).body;
  console.log('--- pre-burst:', data.cacheHitsBefore);
  console.log('--- post-burst /metrics relevant lines ---');
  for (const line of metricsAfter.split('\n')) {
    if (line.match(/^(singleflight_shared_calls_total|db_query_duration_seconds_count|cache_hits_total|cache_misses_total)\s/)) {
      console.log(line);
    }
  }
}
