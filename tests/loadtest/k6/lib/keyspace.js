// tests/loadtest/k6/lib/keyspace.js
//
// k6-facing keyspace module. Imports 'k6/http' at the top level (init scope,
// required by k6 v2). PURE helpers live in keyspace_pure.js and are
// re-exported here so scenarios only need one import.

import http from 'k6/http';
import {
  STATIC_REGULATORS, makeZipf, makeUniform, datasetCombos,
  validFilter, filterToParam, parseRegulators,
} from './keyspace_pure.js';
export {
  STATIC_REGULATORS, makeZipf, makeUniform, datasetCombos,
  validFilter, filterToParam, parseRegulators,
};

// loadRegulators(version, datasets) -> string[]. k6-runtime only: GETs
// /datasets/{db}/regulators for the first dataset against the REAL manifest
// and falls back to STATIC_REGULATORS when empty/unreachable.
export function loadRegulators(version, datasets) {
  // eslint-disable-next-line no-undef
  const baseUrl = (typeof __ENV !== 'undefined' && __ENV.BASE_URL) || 'http://localhost:8080';
  const db = (datasets && datasets[0]) || 'callingcards';
  const res = http.get(`${baseUrl}/api/v/${version}/datasets/${db}/regulators`);
  if (res.status !== 200) return STATIC_REGULATORS;
  let body = null;
  try {
    body = res.json();
  } catch (_e) {
    return STATIC_REGULATORS;
  }
  return parseRegulators(body, STATIC_REGULATORS);
}
