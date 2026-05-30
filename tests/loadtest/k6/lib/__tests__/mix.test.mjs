// tests/loadtest/k6/lib/__tests__/mix.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WEIGHTS, buildRequest,
  bindingURL, perturbationURL, comparisonTopnURL, regulatorsResolveURL,
  scatterURL, selectionMatrixURL, datasetsURL,
} from '../mix.js';

const ctx = {
  baseUrl: 'http://localhost:8080',
  version: 'v9',
  regulators: ['YBR289W', 'YML007W', 'YPL248C'],
  bindingDatasets: ['callingcards', 'harbison'],
  perturbationDatasets: ['hackett'],
  datasetCombos: [['callingcards'], ['callingcards', 'harbison']],
  rng: () => 0.5, // some builders take secondary rolls; deterministic here
};

test('WEIGHTS is a non-empty positive weight table', () => {
  const keys = Object.keys(WEIGHTS);
  assert.ok(keys.length >= 5, `expected >=5 endpoints, got ${keys.length}`);
  for (const k of keys) {
    assert.equal(typeof WEIGHTS[k], 'number');
    assert.ok(WEIGHTS[k] > 0, `weight for ${k} must be > 0`);
  }
});

test('bindingURL targets /binding with regulator + datasets', () => {
  const u = bindingURL(ctx, 0.0);
  assert.ok(u.startsWith('http://localhost:8080/api/v/v9/binding?'), u);
  assert.match(u, /regulator=YBR289W|regulator=YML007W|regulator=YPL248C/);
  assert.match(u, /datasets=callingcards/);
});

test('perturbationURL targets /perturbation with regulator + a perturbation dataset', () => {
  const u = perturbationURL(ctx, 0.0);
  assert.ok(u.startsWith('http://localhost:8080/api/v/v9/perturbation?'), u);
  assert.match(u, /datasets=hackett/);
});

test('comparisonTopnURL has valid binding+perturbation+top_n+effect+pvalue', () => {
  const u = comparisonTopnURL(ctx, 0.0);
  assert.ok(u.startsWith('http://localhost:8080/api/v/v9/comparison/topn?'), u);
  assert.match(u, /binding=callingcards|binding=harbison/);
  assert.match(u, /perturbation=hackett/);
  assert.match(u, /top_n=\d+/);
  assert.match(u, /effect=[\d.]+/);
  assert.match(u, /pvalue=[\d.]+/);
});

test('regulatorsResolveURL intersects two binding datasets', () => {
  const u = regulatorsResolveURL(ctx, 0.0);
  assert.ok(u.startsWith('http://localhost:8080/api/v/v9/regulators/resolve?'), u);
  assert.match(u, /intersect=/);
});

test('scatterURL uses binding/scatter with a valid method and col and a 2-dataset pair', () => {
  const u = scatterURL(ctx, 0.0);
  assert.ok(u.startsWith('http://localhost:8080/api/v/v9/binding/scatter?'), u);
  assert.match(u, /method=(pearson|spearman)/);
  assert.match(u, /col=(effect|pvalue)/);
  const pair = decodeURIComponent(u.match(/pair=([^&]+)/)[1]).split(',');
  assert.equal(pair.length, 2);
});

test('selectionMatrixURL uses /selection/matrix with datasets', () => {
  const u = selectionMatrixURL(ctx, 0.0);
  assert.ok(u.startsWith('http://localhost:8080/api/v/v9/selection/matrix?'), u);
  assert.match(u, /datasets=/);
});

test('datasetsURL is the bare /datasets endpoint', () => {
  const u = datasetsURL(ctx);
  assert.equal(u, 'http://localhost:8080/api/v/v9/datasets');
});

test('buildRequest returns method GET, a url, and a route-pattern endpoint tag', () => {
  const req = buildRequest(0.0, ctx);
  assert.equal(req.method, 'GET');
  assert.equal(typeof req.url, 'string');
  assert.ok(req.url.startsWith('http://localhost:8080/api/v/v9/'));
  assert.ok(req.tags && typeof req.tags.endpoint === 'string');
  assert.match(req.tags.endpoint, /^\/api\/v\/\{v\}\//);
});

test('buildRequest spans every WEIGHTS endpoint across the rng01 range', () => {
  const seen = new Set();
  for (let i = 0; i < 1000; i++) {
    const req = buildRequest(i / 1000, ctx);
    seen.add(req.tags.endpoint);
  }
  // Every weighted endpoint must be reachable for some rng value.
  assert.equal(seen.size, Object.keys(WEIGHTS).length,
    `reached ${seen.size} of ${Object.keys(WEIGHTS).length} endpoints: ${[...seen].join(',')}`);
});

test('buildRequest is deterministic for a fixed rng01 + ctx', () => {
  const a = buildRequest(0.33, ctx);
  const b = buildRequest(0.33, ctx);
  assert.deepEqual(a, b);
});
