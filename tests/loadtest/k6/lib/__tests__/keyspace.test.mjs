// tests/loadtest/k6/lib/__tests__/keyspace.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeZipf, makeUniform, datasetCombos,
  validFilter, filterToParam, parseRegulators, STATIC_REGULATORS,
} from '../keyspace.js';

// Deterministic LCG returning floats in [0,1). Seeded so the test is stable.
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function tally(sampler, rng, n) {
  const counts = new Map();
  for (let i = 0; i < n; i++) {
    const item = sampler(rng());
    counts.set(item, (counts.get(item) || 0) + 1);
  }
  return counts;
}

test('makeZipf produces a skewed distribution (top > 3x median)', () => {
  const items = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
  const rng = lcg(42);
  const counts = tally(makeZipf(items, 1.1), rng, 20000);
  const freqs = items.map((it) => counts.get(it) || 0).sort((x, y) => y - x);
  const top = freqs[0];
  const median = freqs[Math.floor(freqs.length / 2)];
  assert.ok(median > 0, `median must be > 0, got ${median}`);
  assert.ok(top > 3 * median, `expected top(${top}) > 3*median(${3 * median})`);
});

test('makeUniform is approximately flat (max within 1.5x of min)', () => {
  const items = ['a', 'b', 'c', 'd', 'e'];
  const rng = lcg(7);
  const counts = tally(makeUniform(items), rng, 50000);
  const freqs = items.map((it) => counts.get(it) || 0);
  const max = Math.max(...freqs);
  const min = Math.min(...freqs);
  assert.ok(min > 0, 'every item must be drawn at least once');
  assert.ok(max < 1.5 * min, `expected max(${max}) < 1.5*min(${min})`);
});

test('makeZipf and makeUniform clamp rng01 edge values to valid items', () => {
  const items = ['x', 'y', 'z'];
  const z = makeZipf(items, 1.0);
  const u = makeUniform(items);
  assert.ok(items.includes(z(0)));
  assert.ok(items.includes(z(0.999999)));
  assert.ok(items.includes(u(0)));
  assert.ok(items.includes(u(0.999999)));
});

test('datasetCombos returns realistic non-empty combos from the dataset list', () => {
  const all = ['callingcards', 'harbison', 'hackett', 'chec_m2025'];
  const combos = datasetCombos(all);
  assert.ok(Array.isArray(combos) && combos.length > 0);
  for (const c of combos) {
    assert.ok(Array.isArray(c) && c.length >= 1);
    for (const d of c) assert.ok(all.includes(d), `${d} not in provided list`);
  }
  // Must include at least one single-dataset and one multi-dataset combo.
  assert.ok(combos.some((c) => c.length === 1));
  assert.ok(combos.some((c) => c.length >= 2));
});

test('validFilter returns a typed filters object for known datasets', () => {
  const cc = validFilter('callingcards');
  assert.equal(cc.condition.type, 'categorical');
  assert.ok(Array.isArray(cc.condition.value));

  const hk = validFilter('hackett');
  assert.equal(hk.time.type, 'numeric');
  assert.equal(hk.time.value.length, 2);
  assert.ok(hk.time.value[0] <= hk.time.value[1]);
});

test('validFilter varies VALUES across calls but keeps the same key', () => {
  const seen = new Set();
  for (let i = 0; i < 50; i++) {
    const f = validFilter('hackett', () => i / 50);
    assert.deepEqual(Object.keys(f), ['time']);
    seen.add(JSON.stringify(f.time.value));
  }
  assert.ok(seen.size > 1, 'expected validFilter to vary numeric range values');
});

test('validFilter returns null/empty for a dataset with no known filterable field', () => {
  const f = validFilter('unknown_dataset_xyz');
  assert.deepEqual(f, {});
});

test('filterToParam(validFilter(x)) round-trips via JSON.parse', () => {
  const obj = validFilter('callingcards');
  const param = filterToParam(obj);
  assert.equal(typeof param, 'string');
  assert.deepEqual(JSON.parse(param), obj);
});

test('parseRegulators extracts locusTag list from the API body shape', () => {
  const body = {
    dbName: 'callingcards',
    regulators: [
      { locusTag: 'YBR289W', symbol: 'SNF5', display: 'SNF5 (YBR289W)' },
      { locusTag: 'YML007W', symbol: 'YAP1', display: 'YAP1 (YML007W)' },
    ],
  };
  assert.deepEqual(parseRegulators(body, STATIC_REGULATORS), ['YBR289W', 'YML007W']);
});

test('parseRegulators falls back to the static list when empty', () => {
  assert.deepEqual(parseRegulators({ regulators: [] }, STATIC_REGULATORS), STATIC_REGULATORS);
  assert.deepEqual(parseRegulators(null, STATIC_REGULATORS), STATIC_REGULATORS);
  assert.deepEqual(parseRegulators({}, STATIC_REGULATORS), STATIC_REGULATORS);
});
