// tests/loadtest/k6/lib/__tests__/metrics.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCounter, metricDelta, cacheHitRate, poolWaitMeanMs,
} from '../metrics.js';

const TEXT_BEFORE = `# HELP cache_hits_total Cache hits.
# TYPE cache_hits_total counter
cache_hits_total{endpoint="/api/v/{v}/binding"} 10
cache_hits_total{endpoint="/api/v/{v}/perturbation"} 4
# HELP cache_misses_total Cache misses.
# TYPE cache_misses_total counter
cache_misses_total{endpoint="/api/v/{v}/binding"} 2
cache_misses_total{endpoint="/api/v/{v}/perturbation"} 1
# HELP db_pool_wait_duration_seconds_total total
# TYPE db_pool_wait_duration_seconds_total counter
db_pool_wait_duration_seconds_total 0.5
# HELP db_pool_wait_count_total total
# TYPE db_pool_wait_count_total counter
db_pool_wait_count_total 10
`;

const TEXT_AFTER = `cache_hits_total{endpoint="/api/v/{v}/binding"} 90
cache_hits_total{endpoint="/api/v/{v}/perturbation"} 8
cache_misses_total{endpoint="/api/v/{v}/binding"} 12
cache_misses_total{endpoint="/api/v/{v}/perturbation"} 2
db_pool_wait_duration_seconds_total 2.5
db_pool_wait_count_total 60
`;

test('parseCounter reads an unlabelled counter', () => {
  assert.equal(parseCounter(TEXT_BEFORE, 'db_pool_wait_count_total'), 10);
  assert.equal(parseCounter(TEXT_BEFORE, 'db_pool_wait_duration_seconds_total'), 0.5);
});

test('parseCounter reads a labelled CounterVec series by endpoint', () => {
  assert.equal(parseCounter(TEXT_BEFORE, 'cache_hits_total', { endpoint: '/api/v/{v}/binding' }), 10);
  assert.equal(parseCounter(TEXT_BEFORE, 'cache_hits_total', { endpoint: '/api/v/{v}/perturbation' }), 4);
});

test('parseCounter returns 0 when the metric or label is absent', () => {
  assert.equal(parseCounter(TEXT_BEFORE, 'does_not_exist'), 0);
  assert.equal(parseCounter(TEXT_BEFORE, 'cache_hits_total', { endpoint: '/api/v/{v}/nope' }), 0);
});

test('parseCounter sums all series of a name when no labels are given', () => {
  // global cache_hits_total = 10 + 4
  assert.equal(parseCounter(TEXT_BEFORE, 'cache_hits_total'), 14);
});

test('metricDelta subtracts after-before for a labelled series', () => {
  const d = metricDelta(TEXT_BEFORE, TEXT_AFTER, 'cache_hits_total', { endpoint: '/api/v/{v}/binding' });
  assert.equal(d, 80); // 90 - 10
});

test('metricDelta subtracts after-before for an unlabelled counter', () => {
  assert.equal(metricDelta(TEXT_BEFORE, TEXT_AFTER, 'db_pool_wait_count_total'), 50); // 60 - 10
});

test('cacheHitRate computes hits/(hits+misses) for an endpoint', () => {
  // binding: 10 / (10 + 2)
  assert.equal(cacheHitRate(TEXT_BEFORE, '/api/v/{v}/binding'), 10 / 12);
});

test('cacheHitRate computes a global rate when endpoint omitted', () => {
  // global hits 14, misses 3 -> 14/17
  assert.equal(cacheHitRate(TEXT_BEFORE), 14 / 17);
});

test('cacheHitRate is 0 when there is no traffic (no hits and no misses)', () => {
  assert.equal(cacheHitRate('', '/api/v/{v}/binding'), 0);
});

test('poolWaitMeanMs uses the counter pair: 1000 * Δwait_seconds / Δwait_count', () => {
  // Δwait_seconds = 2.5 - 0.5 = 2.0 ; Δwait_count = 60 - 10 = 50
  // mean = 1000 * 2.0 / 50 = 40 ms
  assert.equal(poolWaitMeanMs(TEXT_BEFORE, TEXT_AFTER), 40);
});

test('poolWaitMeanMs is 0 when the count delta is 0 (no division by zero)', () => {
  assert.equal(poolWaitMeanMs(TEXT_BEFORE, TEXT_BEFORE), 0);
});
