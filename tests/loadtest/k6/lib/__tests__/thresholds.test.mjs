// tests/loadtest/k6/lib/__tests__/thresholds.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  warmThresholds, openModelThresholds, availabilityThresholds,
} from '../../thresholds.js';

test('warmThresholds is preserved unchanged', () => {
  assert.deepEqual(warmThresholds.http_req_failed, ['rate==0']);
  assert.deepEqual(warmThresholds.http_req_duration, ['p(95)<200', 'p(99)<500']);
});

test('openModelThresholds gates zero failures, p95/p99 latency, and no dropped iterations', () => {
  assert.deepEqual(openModelThresholds.http_req_failed, ['rate==0']);
  assert.deepEqual(openModelThresholds.http_req_duration, ['p(95)<200', 'p(99)<500']);
  assert.deepEqual(openModelThresholds.dropped_iterations, ['count==0']);
});

test('availabilityThresholds allows a small failure budget', () => {
  assert.deepEqual(availabilityThresholds.http_req_failed, ['rate<0.005']);
});

test('all three threshold sets are plain serializable objects', () => {
  for (const t of [warmThresholds, openModelThresholds, availabilityThresholds]) {
    assert.equal(typeof t, 'object');
    assert.deepEqual(JSON.parse(JSON.stringify(t)), t);
  }
});
