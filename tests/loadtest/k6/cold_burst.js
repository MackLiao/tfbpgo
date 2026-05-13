// Phase 3 acceptance: cold-cache burst targeting singleflight coalescing.
//
// Phase 1 skeleton. Phase 3 expands this to assert that
// cache_admission_rejected_total and cache_oversize_responses_total stay
// within the per-endpoint thresholds from spec §8.1.
//
// Run with:   k6 run cold_burst.js
import http from 'k6/http';
import { check } from 'k6';

const BASE = __ENV.BASE_URL || 'http://127.0.0.1:8080';

export const options = {
  vus: 1,
  iterations: 1,
};

export default function () {
  const res = http.get(`${BASE}/healthz`);
  check(res, { 'healthz 200': (r) => r.status === 200 });
}
