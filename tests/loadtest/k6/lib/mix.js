// tests/loadtest/k6/lib/mix.js
//
// Action mix: a weighted endpoint table plus pure per-endpoint URL builders.
// Everything here is PURE (no k6 imports) so it is unit-testable under Node.
// ctx carries the resolved version, the loaded regulator pool, and dataset
// combos; rng01 selects both the endpoint and the per-endpoint variations.

// WEIGHTS: relative traffic share per endpoint (spec §9.1). Reconcile the
// exact ratios with §9.1 when the spec lands; the shape mirrors profile.js's
// read-heavy 60/30/10 intent extended across the full endpoint surface.
export const WEIGHTS = Object.freeze({
  binding: 34,
  perturbation: 22,
  comparisonTopn: 14,
  regulatorsResolve: 8,
  scatter: 12,
  selectionMatrix: 6,
  datasets: 4,
});

// Route-pattern endpoint tags — MUST match the chi route templates the
// backend stamps into http_request_duration_seconds{route,...} so k6 tags
// line up 1:1 with server-side metrics.
const ENDPOINT_TAG = Object.freeze({
  binding: '/api/v/{v}/binding',
  perturbation: '/api/v/{v}/perturbation',
  comparisonTopn: '/api/v/{v}/comparison/topn',
  regulatorsResolve: '/api/v/{v}/regulators/resolve',
  scatter: '/api/v/{v}/binding/scatter',
  selectionMatrix: '/api/v/{v}/selection/matrix',
  datasets: '/api/v/{v}/datasets',
});

// --- small pure helpers ----------------------------------------------------
function apiBase(ctx) {
  return `${String(ctx.baseUrl).replace(/\/+$/, '')}/api/v/${ctx.version}`;
}
function qs(params) {
  return Object.keys(params)
    .filter((k) => params[k] !== undefined && params[k] !== '')
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
    .join('&');
}
function pick(arr, roll) {
  if (!arr || arr.length === 0) return undefined;
  return arr[Math.min(arr.length - 1, Math.floor(roll * arr.length))];
}
// Derive an independent secondary roll from a primary rng01 so a fixed
// rng01 yields a fixed-but-varied request (deterministic for tests).
function reroll(rng01, salt) {
  const x = (rng01 * 1000 + salt) % 1;
  return x < 0 ? x + 1 : x;
}

// --- per-endpoint URL builders (pure) --------------------------------------
export function bindingURL(ctx, rng01 = 0) {
  const reg = pick(ctx.regulators, reroll(rng01, 1));
  const ds = pick(ctx.bindingDatasets, reroll(rng01, 2));
  return `${apiBase(ctx)}/binding?${qs({ regulator: reg, datasets: ds })}`;
}

export function perturbationURL(ctx, rng01 = 0) {
  const reg = pick(ctx.regulators, reroll(rng01, 3));
  const ds = pick(ctx.perturbationDatasets, reroll(rng01, 4));
  return `${apiBase(ctx)}/perturbation?${qs({ regulator: reg, datasets: ds })}`;
}

export function comparisonTopnURL(ctx, rng01 = 0) {
  const b = pick(ctx.bindingDatasets, reroll(rng01, 5));
  const p = pick(ctx.perturbationDatasets, reroll(rng01, 6));
  // top_n in {10,25,50,100}; effect in [0.1,0.6); pvalue in (0,0.05].
  const topNs = [10, 25, 50, 100];
  const topN = topNs[Math.floor(reroll(rng01, 7) * topNs.length)];
  const effect = (reroll(rng01, 8) * 0.5 + 0.1).toFixed(2);
  const pvalue = (reroll(rng01, 9) * 0.049 + 0.001).toFixed(4);
  return `${apiBase(ctx)}/comparison/topn?${qs({
    binding: b, perturbation: p, top_n: topN, effect, pvalue,
  })}`;
}

export function regulatorsResolveURL(ctx, rng01 = 0) {
  // Intersect two binding datasets when available, else fall back to one.
  const ds = ctx.bindingDatasets.length >= 2
    ? [ctx.bindingDatasets[0], ctx.bindingDatasets[1]]
    : ctx.bindingDatasets.slice(0, 1);
  return `${apiBase(ctx)}/regulators/resolve?${qs({ intersect: ds.join(',') })}`;
}

export function scatterURL(ctx, rng01 = 0) {
  const reg = pick(ctx.regulators, reroll(rng01, 10));
  const method = reroll(rng01, 11) < 0.5 ? 'pearson' : 'spearman';
  const col = reroll(rng01, 12) < 0.5 ? 'effect' : 'pvalue';
  // pair requires exactly 2 dataset entries; self-pairs are legal but we
  // prefer two distinct binding datasets when available.
  const a = ctx.bindingDatasets[0];
  const b = ctx.bindingDatasets.length >= 2 ? ctx.bindingDatasets[1] : ctx.bindingDatasets[0];
  return `${apiBase(ctx)}/binding/scatter?${qs({
    regulator: reg, method, col, pair: `${a},${b}`,
  })}`;
}

export function selectionMatrixURL(ctx, rng01 = 0) {
  const combo = pick(ctx.datasetCombos, reroll(rng01, 13)) || ctx.bindingDatasets.slice(0, 1);
  return `${apiBase(ctx)}/selection/matrix?${qs({ datasets: combo.join(',') })}`;
}

export function datasetsURL(ctx) {
  return `${apiBase(ctx)}/datasets`;
}

// --- weighted dispatch -----------------------------------------------------
// Stable iteration order matches the WEIGHTS declaration order.
const ORDER = Object.keys(WEIGHTS);
const TOTAL = ORDER.reduce((s, k) => s + WEIGHTS[k], 0);

const BUILDERS = {
  binding: bindingURL,
  perturbation: perturbationURL,
  comparisonTopn: comparisonTopnURL,
  regulatorsResolve: regulatorsResolveURL,
  scatter: scatterURL,
  selectionMatrix: selectionMatrixURL,
  datasets: (ctx) => datasetsURL(ctx),
};

// buildRequest(rng01, ctx) -> {method:'GET', url, tags:{endpoint}}.
// Maps rng01 through the cumulative weight table to pick an endpoint, then
// reuses the SAME rng01 (re-rolled per builder) for the URL variation, so a
// fixed rng01 is fully deterministic.
export function buildRequest(rng01, ctx) {
  const r = (rng01 <= 0 ? 0 : rng01 >= 1 ? 0.999999999 : rng01) * TOTAL;
  let acc = 0;
  let chosen = ORDER[ORDER.length - 1];
  for (const k of ORDER) {
    acc += WEIGHTS[k];
    if (r < acc) { chosen = k; break; }
  }
  const url = BUILDERS[chosen](ctx, rng01);
  return { method: 'GET', url, tags: { endpoint: ENDPOINT_TAG[chosen] } };
}
