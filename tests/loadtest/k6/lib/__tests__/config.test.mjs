// tests/loadtest/k6/lib/__tests__/config.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apiBase, parseEnv, DEFAULTS } from '../config_pure.js';

test('apiBase joins base and version into the /api/v/{v} prefix', () => {
  assert.equal(
    apiBase('http://localhost:8080', 'sha256:abc123'),
    'http://localhost:8080/api/v/sha256:abc123',
  );
});

test('apiBase tolerates a trailing slash on the base url', () => {
  assert.equal(
    apiBase('http://localhost:8080/', 'v9'),
    'http://localhost:8080/api/v/v9',
  );
});

test('parseEnv falls back to defaults when env is empty', () => {
  const cfg = parseEnv({});
  assert.equal(cfg.BASE_URL, DEFAULTS.BASE_URL);
  assert.equal(cfg.ARTIFACT_KIND, 'fixture');
  assert.equal(cfg.TARGET_RATE, DEFAULTS.TARGET_RATE);
  assert.equal(cfg.DURATION, DEFAULTS.DURATION);
  assert.equal(cfg.HIT_RATE, DEFAULTS.HIT_RATE);
  assert.equal(cfg.KEYSPACE_MODE, DEFAULTS.KEYSPACE_MODE);
  assert.equal(cfg.ZIPF_EXP, DEFAULTS.ZIPF_EXP);
});

test('parseEnv reads and coerces overrides from the env object', () => {
  const cfg = parseEnv({
    BASE_URL: 'http://example:9000',
    ARTIFACT_KIND: 'real',
    TARGET_RATE: '120',
    DURATION: '10m',
    HIT_RATE: '0.9',
    KEYSPACE_MODE: 'uniform',
    ZIPF_EXP: '1.3',
  });
  assert.equal(cfg.BASE_URL, 'http://example:9000');
  assert.equal(cfg.ARTIFACT_KIND, 'real');
  assert.equal(cfg.TARGET_RATE, 120);
  assert.equal(typeof cfg.TARGET_RATE, 'number');
  assert.equal(cfg.DURATION, '10m');
  assert.equal(cfg.HIT_RATE, 0.9);
  assert.equal(cfg.KEYSPACE_MODE, 'uniform');
  assert.equal(cfg.ZIPF_EXP, 1.3);
});

test('parseEnv keeps an unknown ARTIFACT_KIND but flags it not-fixture/not-real', () => {
  const cfg = parseEnv({ ARTIFACT_KIND: 'bogus' });
  // We do not throw — scenarios decide what to do; we just surface the raw value.
  assert.equal(cfg.ARTIFACT_KIND, 'bogus');
});
