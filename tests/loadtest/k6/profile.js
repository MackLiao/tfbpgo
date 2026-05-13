import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Trend, Rate } from 'k6/metrics';
import { warmThresholds } from './thresholds.js';
import {
  popularRegulator, variedRegulator,
  pickBindingDataset, pickPerturbationDataset,
} from './lib/random_query.js';

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

let ARTIFACT_VERSION;
export function setup() {
  const res = http.get(`${BASE}/api/version`);
  return { v: res.json().artifactVersion };
}

const popularLatency = new Trend('popular_latency_ms', true);
const popularCacheHit = new Rate('popular_cache_hit');

export default function (data) {
  ARTIFACT_VERSION = data.v;
  const r = Math.random();

  if (r < 0.6) {
    // 60% popular: cache-friendly traffic
    group('popular', () => {
      const reg = popularRegulator(Math.random());
      const ds  = pickBindingDataset(Math.random());
      const res = http.get(
        `${BASE}/api/v/${ARTIFACT_VERSION}/binding?regulator=${reg}&datasets=${ds}`,
        { tags: { segment: 'popular' } },
      );
      check(res, { 'popular 200': (x) => x.status === 200 });
      popularLatency.add(res.timings.duration);
      popularCacheHit.add(res.headers['X-Cache'] === 'hit'); // backend may not emit X-Cache; ok if 0
    });
  } else if (r < 0.9) {
    // 30% varied: stresses cache fill
    group('varied', () => {
      const reg = variedRegulator(Math.random());
      const ds  = pickBindingDataset(Math.random());
      http.get(`${BASE}/api/v/${ARTIFACT_VERSION}/binding?regulator=${reg}&datasets=${ds}`,
        { tags: { segment: 'varied' } });
    });
  } else {
    // 10% deep-filter combinations: topn with effect+pvalue
    group('topn', () => {
      const b = pickBindingDataset(Math.random());
      const p = pickPerturbationDataset(Math.random());
      const eff = (Math.random() * 0.5 + 0.1).toFixed(2);
      const pv  = (Math.random() * 0.05).toFixed(4);
      http.get(
        `${BASE}/api/v/${ARTIFACT_VERSION}/comparison/topn?binding=${b}&perturbation=${p}&top_n=25&effect=${eff}&pvalue=${pv}`,
        { tags: { segment: 'topn' } },
      );
    });
  }

  sleep(2 + Math.random() * 6); // 2-8 s think time
}
