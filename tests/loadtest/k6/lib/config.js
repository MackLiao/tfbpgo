// tests/loadtest/k6/lib/config.js
//
// Shared k6 load-test configuration. The PURE helpers (apiBase, parseEnv,
// DEFAULTS) have no k6-runtime dependency and are unit-tested under
// __tests__/ with plain Node (node --test). The k6-runtime-only piece
// (resolveVersion -> http.get) lazily imports 'k6/http' inside the function
// body so that Node can `import` this module without choking on the k6
// builtin. resolveVersion() is only ever called from a scenario's setup(),
// which always runs inside k6, so the dynamic import always resolves there.

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

// --- k6-runtime constants (evaluated lazily; safe under Node import) -------
// __ENV is a k6 global. Under Node it is undefined, so we fall back to {}.
const _env = typeof __ENV !== 'undefined' ? __ENV : {};
const _cfg = parseEnv(_env);

export const BASE_URL = _cfg.BASE_URL;
export const ARTIFACT_KIND = _cfg.ARTIFACT_KIND;
export const TARGET_RATE = _cfg.TARGET_RATE;
export const DURATION = _cfg.DURATION;
export const HIT_RATE = _cfg.HIT_RATE;
export const KEYSPACE_MODE = _cfg.KEYSPACE_MODE;
export const ZIPF_EXP = _cfg.ZIPF_EXP;

// resolveVersion() GETs BASE_URL/api/version and returns artifactVersion.
// Call this from every scenario's setup() — NEVER hard-code a version.
// 'k6/http' is imported dynamically so Node can import this module for the
// pure helpers above without resolving the k6 builtin.
export function resolveVersion() {
  // eslint-disable-next-line no-undef
  const http = require('k6/http');
  const res = http.get(`${BASE_URL}/api/version`);
  if (res.status !== 200) {
    throw new Error(`resolveVersion: GET ${BASE_URL}/api/version -> ${res.status}`);
  }
  return res.json().artifactVersion;
}
