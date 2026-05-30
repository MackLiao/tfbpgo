// tests/loadtest/k6/lib/config_pure.js
//
// PURE helpers — no k6 dependency. Importable by plain Node (--test) and by
// the k6-facing config.js. Do not add any k6 builtins here.

export const DEFAULTS = Object.freeze({
  BASE_URL: 'http://localhost:8080',
  ARTIFACT_KIND: 'fixture', // 'fixture' | 'real'
  TARGET_RATE: 50, // requests/sec target for open-model scenarios
  DURATION: '8m', // steady-state hold duration
  HIT_RATE: 0.85, // target warm-cache hit ratio for the action mix
  KEYSPACE_MODE: 'zipf', // 'zipf' | 'uniform'
  ZIPF_EXP: 1.1, // Zipfian skew exponent
});

// parseEnv is pure: it reads from an injected env object (k6 passes __ENV).
// Numbers are coerced; strings pass through; missing keys take DEFAULTS.
export function parseEnv(env) {
  const e = env || {};
  const num = (v, d) => {
    if (v === undefined || v === null || v === '') return d;
    const n = Number(v);
    return Number.isNaN(n) ? d : n;
  };
  return {
    BASE_URL: e.BASE_URL || DEFAULTS.BASE_URL,
    ARTIFACT_KIND: e.ARTIFACT_KIND || DEFAULTS.ARTIFACT_KIND,
    TARGET_RATE: num(e.TARGET_RATE, DEFAULTS.TARGET_RATE),
    DURATION: e.DURATION || DEFAULTS.DURATION,
    HIT_RATE: num(e.HIT_RATE, DEFAULTS.HIT_RATE),
    KEYSPACE_MODE: e.KEYSPACE_MODE || DEFAULTS.KEYSPACE_MODE,
    ZIPF_EXP: num(e.ZIPF_EXP, DEFAULTS.ZIPF_EXP),
  };
}

// apiBase joins the base URL and resolved artifact version into the
// version-pinned API prefix. Tolerates a trailing slash on baseUrl.
export function apiBase(baseUrl, version) {
  const base = String(baseUrl).replace(/\/+$/, '');
  return `${base}/api/v/${version}`;
}
