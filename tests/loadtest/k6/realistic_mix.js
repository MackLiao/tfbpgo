import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Trend, Rate } from 'k6/metrics';
import { warmThresholds } from './thresholds.js';
import {
  popularRegulator, variedRegulator,
  pickBindingDataset, pickPerturbationDataset,
} from './lib/random_query.js';

// Realistic-user traffic mix (companion to profile.js).
//
// profile.js deliberately over-weights the cold path to stress the cache/pool:
// 10% of its requests are comparison/topn with RANDOM effect+pvalue, so every
// one is an uncacheable cold DuckDB query. Real users don't browse that way —
// the Comparison page is an occasional deep-dive, and when they open it they
// look at common dataset pairs with the DEFAULT sidebar params, which cache.
//
// This profile models that: binding-heavy, a real perturbation arm, and only a
// small slice of comparison traffic that uses cacheable common parameters.
// Use it for "what a real crowd actually experiences"; use profile.js for the
// adversarial cold-path stress number.

const BASE = __ENV.BASE_URL || 'http://127.0.0.1:8080';

export const options = {
  scenarios: {
    main: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '1m', target: 50 },
        { duration: '8m', target: 50 },
        { duration: '1m', target: 0 },
      ],
      gracefulRampDown: '30s',
    },
  },
  thresholds: warmThresholds,
};

export function setup() {
  const res = http.get(`${BASE}/api/version`);
  return { v: res.json().artifactVersion };
}

const popularLatency = new Trend('popular_latency_ms', true);
const popularCacheHit = new Rate('popular_cache_hit');
const topnLatency = new Trend('topn_latency_ms', true);
const topnCacheHit = new Rate('topn_cache_hit');

// A handful of common dataset pairs viewed with the DEFAULT Comparison sidebar
// params (top_n=25, effect=0, pvalue=0.05) — so repeat views hit the cache,
// exactly like real users revisiting the page. All 1-pair, well inside the
// MAX_COMPARISON_PAIRS cap.
const COMMON_PAIRS = [
  ['callingcards', 'hackett'],
  ['harbison', 'hackett'],
  ['callingcards', 'kemmeren'],
];

export default function (data) {
  const r = Math.random();

  if (r < 0.70) {
    // 70% popular binding — the dominant real action, cache-friendly.
    group('popular', () => {
      const reg = popularRegulator(Math.random());
      const ds = pickBindingDataset(Math.random());
      const res = http.get(
        `${BASE}/api/v/${data.v}/binding?regulator=${reg}&datasets=${ds}`,
        { tags: { segment: 'popular' } },
      );
      check(res, { 'popular 200': (x) => x.status === 200 });
      popularLatency.add(res.timings.duration);
      popularCacheHit.add(res.headers['X-Cache'] === 'HIT');
    });
  } else if (r < 0.92) {
    // 22% varied binding — exploration of less-popular regulators (cache fill).
    group('varied', () => {
      const reg = variedRegulator(Math.random());
      const ds = pickBindingDataset(Math.random());
      http.get(`${BASE}/api/v/${data.v}/binding?regulator=${reg}&datasets=${ds}`,
        { tags: { segment: 'varied' } });
    });
  } else if (r < 0.97) {
    // 5% perturbation — the other main per-regulator page.
    group('perturbation', () => {
      const reg = popularRegulator(Math.random());
      const ds = pickPerturbationDataset(Math.random());
      http.get(`${BASE}/api/v/${data.v}/perturbation?regulator=${reg}&datasets=${ds}`,
        { tags: { segment: 'perturbation' } });
    });
  } else {
    // 3% comparison/topn — occasional deep-dive with DEFAULT (cacheable) params.
    group('topn', () => {
      const pair = COMMON_PAIRS[Math.floor(Math.random() * COMMON_PAIRS.length)];
      const res = http.get(
        `${BASE}/api/v/${data.v}/comparison/topn?binding=${pair[0]}&perturbation=${pair[1]}&top_n=25&effect=0&pvalue=0.05`,
        { tags: { segment: 'topn' } },
      );
      check(res, { 'topn 200': (x) => x.status === 200 });
      topnLatency.add(res.timings.duration);
      topnCacheHit.add(res.headers['X-Cache'] === 'HIT');
    });
  }

  sleep(2 + Math.random() * 6); // 2-8 s think time
}
