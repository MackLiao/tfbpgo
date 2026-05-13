// Phase 3 acceptance: steady-state throughput / latency profile.
//
// This file is a Phase 1 skeleton. The Phase 3 plan replaces it with a
// graduated VU ramp + endpoint mix derived from production access logs.
//
// Run with:   k6 run profile.js
// Override the base URL: k6 run -e BASE_URL=http://example:8080 profile.js
import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE = __ENV.BASE_URL || 'http://127.0.0.1:8080';

export const options = {
  vus: 1,
  duration: '5s',
};

export default function () {
  const res = http.get(`${BASE}/healthz`);
  check(res, { 'healthz 200': (r) => r.status === 200 });
  sleep(1);
}
