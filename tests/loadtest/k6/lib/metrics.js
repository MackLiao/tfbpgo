// tests/loadtest/k6/lib/metrics.js
//
// k6-facing metrics module. Imports 'k6/http' at the top level (init scope,
// required by k6 v2). PURE helpers live in metrics_pure.js and are
// re-exported here so scenarios only need one import.

import http from 'k6/http';
import { parseCounter, metricDelta, cacheHitRate, poolWaitMeanMs } from './metrics_pure.js';
export { parseCounter, metricDelta, cacheHitRate, poolWaitMeanMs };

// scrapeMetrics(baseUrl) -> raw /metrics text. k6-runtime only.
export function scrapeMetrics(baseUrl) {
  const res = http.get(`${String(baseUrl).replace(/\/+$/, '')}/metrics`);
  return res.body;
}
