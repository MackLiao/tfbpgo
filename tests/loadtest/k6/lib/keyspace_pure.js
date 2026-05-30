// tests/loadtest/k6/lib/keyspace_pure.js
//
// PURE keyspace helpers — no k6 dependency. Importable by plain Node (--test)
// and by the k6-facing keyspace.js. Do not add any k6 builtins here.

// Static fallback regulator set (mirrors lib/random_query.js popular+varied).
export const STATIC_REGULATORS = [
  'YBR289W', 'YML007W', 'YPL248C', 'YOR028C', 'YGL073W',
  'YDR277C', 'YAL038W', 'YMR053C', 'YHR084W', 'YJL056C',
  'YKL062W', 'YPR065W', 'YGL013C', 'YBR234C', 'YDL106C',
  'YLR131C', 'YOR077W', 'YNL216W', 'YMR043W',
];

// makeZipf(items, exponent) -> fn(rng01)->item.
// Pre-computes a normalized cumulative Zipf CDF over rank i (1..N) with
// weight 1/i^exponent, then maps rng01 through it (inverse-CDF sampling).
// Item 0 is the most popular. Larger exponent => steeper skew.
export function makeZipf(items, exponent) {
  const n = items.length;
  const weights = new Array(n);
  let total = 0;
  for (let i = 0; i < n; i++) {
    weights[i] = 1 / Math.pow(i + 1, exponent);
    total += weights[i];
  }
  const cdf = new Array(n);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc += weights[i] / total;
    cdf[i] = acc;
  }
  cdf[n - 1] = 1; // guard floating-point drift at the tail
  return function pick(rng01) {
    const r = rng01 <= 0 ? 0 : rng01 >= 1 ? 0.999999999 : rng01;
    for (let i = 0; i < n; i++) {
      if (r < cdf[i]) return items[i];
    }
    return items[n - 1];
  };
}

// makeUniform(items) -> fn(rng01)->item. Flat distribution.
export function makeUniform(items) {
  const n = items.length;
  return function pick(rng01) {
    const r = rng01 <= 0 ? 0 : rng01 >= 1 ? 0.999999999 : rng01;
    return items[Math.min(n - 1, Math.floor(r * n))];
  };
}

// datasetCombos(allDatasets) -> string[][] realistic selection combos.
// Mirrors how the UI sends ?datasets=: single-dataset views plus a few
// 2- and 3-dataset multi-selects. Combos are filtered to datasets actually
// present in allDatasets so it adapts to the fixture vs real artifact.
export function datasetCombos(allDatasets) {
  const set = new Set(allDatasets);
  const keep = (arr) => arr.filter((d) => set.has(d));
  const candidates = [
    ['callingcards'],
    ['harbison'],
    ['hackett'],
    ['chec_m2025'],
    ['callingcards', 'harbison'],
    ['callingcards', 'harbison', 'chec_m2025'],
    ['harbison', 'chec_m2025'],
  ];
  const combos = candidates.map(keep).filter((c) => c.length > 0);
  // Always include at least each dataset alone so nothing is unreachable.
  for (const d of allDatasets) {
    if (!combos.some((c) => c.length === 1 && c[0] === d)) combos.push([d]);
  }
  return combos;
}

// DEFAULT_DATASET_FILTERS shape from data_prep/src/data_prep/manifests.py.
// validFilter(dataset, rng01?) -> a VALID filters-JSON object for ONE
// dataset (the per-db inner map). It varies the VALUES (not the key order)
// so cache keys spread realistically: categorical picks among valid levels,
// numeric jitters the range endpoints around the canonical center.
const CATEGORICAL_FILTER = {
  callingcards: { field: 'condition', values: ['YPD'] },
  harbison: { field: 'condition', values: ['YPD'] },
  chec_m2025: { field: 'condition', values: ['standard'] },
};
const NUMERIC_FILTER = {
  hackett: { field: 'time', center: 45, span: 0 },
};

export function validFilter(dataset, rng01) {
  const r = typeof rng01 === 'function' ? rng01() : rng01;
  const roll = typeof r === 'number' ? r : Math.random();

  if (CATEGORICAL_FILTER[dataset]) {
    const { field, values } = CATEGORICAL_FILTER[dataset];
    // Vary by choosing a (deterministic-with-rng) subset that always
    // includes at least the first level so the filter stays valid.
    const idx = Math.min(values.length - 1, Math.floor(roll * values.length));
    const chosen = values.slice(0, idx + 1);
    return { [field]: { type: 'categorical', value: chosen } };
  }
  if (NUMERIC_FILTER[dataset]) {
    const { field, center, span } = NUMERIC_FILTER[dataset];
    // Jitter the lower bound down by up to `span` * roll so VALUES vary
    // while the canonical center stays inside the range. For span=0
    // (hackett time=45) the value is always [45,45], so we widen the
    // window deterministically by the roll to still vary the key.
    const lo = center - Math.round(roll * (span + 10));
    const hi = center;
    return { [field]: { type: 'numeric', value: [lo, hi] } };
  }
  return {};
}

// filterToParam(obj) -> JSON string for ?filters=. The backend re-marshals
// map keys sorted, so plain JSON.stringify round-trips for cache-key parity.
export function filterToParam(obj) {
  return JSON.stringify(obj);
}

// parseRegulators(jsonBody, fallback) -> string[] of locusTags. Falls back
// to `fallback` when the body is missing/empty. PURE — no k6 dependency.
export function parseRegulators(jsonBody, fallback) {
  const regs = jsonBody && Array.isArray(jsonBody.regulators) ? jsonBody.regulators : [];
  const tags = regs.map((x) => x && x.locusTag).filter((t) => typeof t === 'string' && t.length > 0);
  return tags.length > 0 ? tags : fallback;
}
