// tests/loadtest/k6/lib/metrics_pure.js
//
// PURE Prometheus /metrics parse helpers — no k6 dependency. Importable by
// plain Node (--test) and by the k6-facing metrics.js. Do not add any k6
// builtins here.

// Escape a string for use inside a RegExp.
function reEscape(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// parseCounter(text, name, labels?) -> number.
//   - labels omitted: SUM of every series with that metric name (handles a
//     bare `name 12` line and the sum of all labelled series alike).
//   - labels given (e.g. {endpoint:'...'}): the single series whose line
//     contains every label=value pair. Returns 0 if absent.
// Values may be integer or float (pool-wait-seconds is a float).
export function parseCounter(text, name, labels) {
  if (!text) return 0;
  const nameRe = reEscape(name);
  // Match lines that start with the metric name, optionally a {labels} block,
  // then whitespace and a numeric value. Anchored per-line (multiline).
  const lineRe = new RegExp(`^${nameRe}(\\{.*\\})?\\s+([-+0-9.eE]+)\\s*$`, 'mg');

  let total = 0;
  let matched = false;
  let m;
  while ((m = lineRe.exec(text)) !== null) {
    const labelBlock = m[1] || '';
    const value = Number(m[2]);
    if (Number.isNaN(value)) continue;
    if (labels) {
      const ok = Object.keys(labels).every((k) =>
        labelBlock.includes(`${k}="${labels[k]}"`));
      if (!ok) continue;
      return value; // a specific labelled series is unique
    }
    total += value;
    matched = true;
  }
  return matched ? total : 0;
}

// metricDelta(before, after, name, labels?) -> after - before.
export function metricDelta(before, after, name, labels) {
  return parseCounter(after, name, labels) - parseCounter(before, name, labels);
}

// cacheHitRate(text, endpoint?) -> hits/(hits+misses). endpoint optional
// (global when omitted). Returns 0 when there is no traffic.
export function cacheHitRate(text, endpoint) {
  const labels = endpoint ? { endpoint } : undefined;
  const hits = parseCounter(text, 'cache_hits_total', labels);
  const misses = parseCounter(text, 'cache_misses_total', labels);
  const denom = hits + misses;
  return denom === 0 ? 0 : hits / denom;
}

// poolWaitMeanMs(before, after) -> 1000 * Δwait_duration_total / Δwait_count_total.
// Uses the db_pool_wait_duration_seconds_total / db_pool_wait_count_total
// counter pair. Returns 0 when the count delta is 0 (no waits, no div-by-0).
export function poolWaitMeanMs(before, after) {
  const dSeconds = metricDelta(before, after, 'db_pool_wait_duration_seconds_total');
  const dCount = metricDelta(before, after, 'db_pool_wait_count_total');
  if (dCount === 0) return 0;
  return (1000 * dSeconds) / dCount;
}
