// tests/loadtest/k6/lib/config.js
//
// k6-facing config module. Imports 'k6/http' at the top level (init scope,
// required by k6 v2). PURE helpers live in config_pure.js and are
// re-exported here so scenarios only need one import.

import http from 'k6/http';
import { DEFAULTS, parseEnv, apiBase } from './config_pure.js';
export { DEFAULTS, parseEnv, apiBase };

// --- k6-runtime constants (evaluated at init scope) ------------------------
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
export function resolveVersion() {
  const res = http.get(`${BASE_URL}/api/version`);
  if (res.status !== 200) {
    throw new Error(`resolveVersion: GET ${BASE_URL}/api/version -> ${res.status}`);
  }
  return res.json().artifactVersion;
}
