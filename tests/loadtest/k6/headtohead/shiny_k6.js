// tests/loadtest/k6/headtohead/shiny_k6.js
//
// k6 entry point for the Shiny arm of the head-to-head ladder.
// Imports pure helpers from shiny_adapter.js (CJS/Node-testable) and k6
// builtins from the k6 runtime. This file is NOT unit-testable under Node
// (it imports 'k6/ws', 'k6/metrics', 'k6/http' which are k6-only builtins).
//
// Run with:
//   k6 run \
//     -e BASE_URL=https://legacy.tfbindingandperturbation.com \
//     -e SHINY_ACTION_TIMEOUT=30000 \
//     -e ARTIFACT_KIND=real \
//     tests/loadtest/k6/headtohead/shiny_k6.js
//
// Metrics emitted:
//   shiny_action_ok          (Rate)    — 1 per successful action, 0 per timeout/error
//   shiny_action_ms          (Trend)   — wall-ms per completed action
//   shiny_reconnects_total   (Counter) — WebSocket reconnect events
//
// See METHODOLOGY.md §3 for the arrival-rate ladder spec and §6 for the
// definition of "one action" on the Shiny side.

import ws from 'k6/ws';
import { Rate, Trend, Counter } from 'k6/metrics';
import http from 'k6/http';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.2/index.js';

// shiny_adapter.js is a CJS file. k6 can import CJS modules with createRequire
// or by using a compatibility shim. Since k6 v0.43+ supports CommonJS-style
// modules when they expose module.exports, we use a dynamic require() via the
// k6 compat-mode (default). If the k6 version does not support CJS imports,
// copy the pure-logic section into this file directly.
//
// k6 compat-mode=base (the default) supports require() for local CJS modules.
const adapter = require('./shiny_adapter.js');
const FRAMES  = require('./frames.js');

const {
  SHINY_ACTIONS, pickAction, framesReady, encodeUpdate, unwrapSockJS, matchOutput,
} = adapter;

// ---------------------------------------------------------------------------
// Custom k6 metrics
// ---------------------------------------------------------------------------
const shinyActionOk   = new Rate('shiny_action_ok');
const shinyActionMs   = new Trend('shiny_action_ms', true);
const shinyReconnects = new Counter('shiny_reconnects_total');

// ---------------------------------------------------------------------------
// Env-driven config (matches arrival_slo.js parameter naming)
// ---------------------------------------------------------------------------
const BASE_URL          = __ENV.BASE_URL || 'https://legacy.tfbindingandperturbation.com';
const ACTION_TIMEOUT_MS = parseInt(__ENV.SHINY_ACTION_TIMEOUT || '30000', 10);
const ARTIFACT_KIND     = __ENV.ARTIFACT_KIND || 'fixture';

// Arrival-rate ladder — MUST match the Go arm (see METHODOLOGY.md §3 + §8).
const RATES     = (__ENV.RATES || '5,40,80').split(',').map((s) => parseInt(s.trim(), 10));
const STEP_HOLD = __ENV.STEP_HOLD || '4m';
const RAMP      = __ENV.RAMP || '30s';
const PREALLOC  = parseInt(__ENV.PREALLOC_VUS || '50', 10);
const MAX_VUS_N = parseInt(__ENV.MAX_VUS || '400', 10);

function _buildStages(rates) {
  const stages = [];
  for (const r of rates) {
    stages.push({ target: r, duration: RAMP });
    stages.push({ target: r, duration: STEP_HOLD });
  }
  return stages;
}

// ---------------------------------------------------------------------------
// k6 options
// ---------------------------------------------------------------------------
export const options = {
  scenarios: {
    shiny_ladder: {
      executor: 'ramping-arrival-rate',
      startRate: RATES[0],
      timeUnit: '1s',
      preAllocatedVUs: PREALLOC,
      maxVUs: MAX_VUS_N,
      stages: _buildStages(RATES),
      exec: 'shinyVU',
      tags: { arm: 'shiny' },
    },
  },
  thresholds: {
    // Symmetric SLO with the Go arm (METHODOLOGY.md §7).
    shiny_action_ok: ARTIFACT_KIND === 'real'
      ? ['rate>=0.995']
      : ['rate>=0.8'],
    'shiny_action_ms{arm:shiny}': ARTIFACT_KIND === 'real'
      ? ['p(95)<200', 'p(99)<500']
      : ['p(95)<10000'],
    // Run validity gate (same as arrival_slo.js).
    dropped_iterations: ['count==0'],
  },
};

// ---------------------------------------------------------------------------
// setup(): validate frames + resolve regulator pool
// ---------------------------------------------------------------------------
export function setup() {
  // Hard gate: frames must be captured before any load run.
  if (!framesReady(FRAMES)) {
    throw new Error(
      'OPERATIONAL PREREQUISITE NOT MET: frames.js __CAPTURED__ is false. ' +
      'Follow ./CAPTURE.md to capture the Shiny SockJS frames before running.',
    );
  }

  if (ARTIFACT_KIND !== 'real') {
    console.warn(
      'WARNING: ARTIFACT_KIND=' + ARTIFACT_KIND + ' — shiny_k6.js is an ' +
      'AUTHORITATIVE perf scenario. Numbers are only valid with ARTIFACT_KIND=real ' +
      'on matched hardware (METHODOLOGY.md §2).',
    );
  }

  // Resolve regulator pool from the Go arm (canonical source of scientific data;
  // both arms query the same tfbp.duckdb artifact — METHODOLOGY.md §2).
  const goBase     = BASE_URL.replace(/legacy\./, '');
  const versionRes = http.get(goBase + '/api/version');
  let version = '1';
  try { version = JSON.parse(versionRes.body).apiVersion || '1'; } catch (_) {}

  const resolveUrl = goBase + '/api/v/' + version + '/regulators/resolve' +
    '?intersect=callingcards,harbison';
  const regRes    = http.get(resolveUrl);
  let regulators  = ['YAL001C', 'YBL093C', 'YBR049C']; // safe fallback
  try {
    const body = JSON.parse(regRes.body);
    if (Array.isArray(body) && body.length > 0) {
      // Take up to 20 regulators in stable API order (fixed seed per §8).
      regulators = body.slice(0, Math.min(20, body.length));
    }
  } catch (_) {}

  return { regulators: regulators, version: version };
}

// ---------------------------------------------------------------------------
// shinyVU(): per-VU function — one persistent WebSocket session
// ---------------------------------------------------------------------------
export function shinyVU(data) {
  const framing = FRAMES.sockjsFraming;
  const wsUrl   = BASE_URL.replace(/^http/, 'ws') + FRAMES.wsPath;

  // Per-VU mutable state.
  const counters    = {};
  let sessionReady  = false;
  let pendingOutput = null;   // { outputId } | null
  let actionStartMs = 0;

  // LCG RNG seeded per VU+iteration for reproducible but varied requests.
  let _rngState = (__VU * 1000 + __ITER) >>> 0;
  function rng() {
    _rngState = (_rngState * 1664525 + 1013904223) >>> 0;
    return (_rngState >>> 0) / 4294967296;
  }

  const ctx = { regulators: data.regulators, counters: counters, rng: rng };

  ws.connect(wsUrl, {}, function onConnect(socket) {
    // ---- on open: send captured init handshake ----
    socket.on('open', function() {
      for (let i = 0; i < FRAMES.initSend.length; i++) {
        socket.send(FRAMES.initSend[i]);
      }
    });

    // ---- on message: init gate then action matching ----
    socket.on('message', function(rawMsg) {
      const msg = unwrapSockJS(rawMsg, framing);

      if (!sessionReady) {
        // Wait for the ready marker before dispatching actions.
        if (typeof msg === 'string' && FRAMES.readyMarker && msg.includes(FRAMES.readyMarker)) {
          sessionReady = true;
        }
        return;
      }

      if (pendingOutput) {
        const outputId = pendingOutput.outputId;

        // Success: output appears in values.
        if (matchOutput(msg, outputId)) {
          shinyActionMs.add(Date.now() - actionStartMs);
          shinyActionOk.add(1);
          pendingOutput = null;
          return;
        }

        // Failure: output appears in errors.
        let parsed;
        try { parsed = JSON.parse(msg); } catch (_) { return; }
        if (parsed && parsed.errors &&
            Object.prototype.hasOwnProperty.call(parsed.errors, outputId)) {
          shinyActionOk.add(0);
          pendingOutput = null;
        }
      }
    });

    // ---- on error: record failure ----
    socket.on('error', function() {
      if (pendingOutput) { shinyActionOk.add(0); pendingOutput = null; }
    });

    // ---- on close: record reconnect ----
    socket.on('close', function() {
      if (pendingOutput) { shinyActionOk.add(0); pendingOutput = null; }
      shinyReconnects.add(1);
    });

    // ---- action loop (non-blocking, driven by socket.setTimeout) ----
    socket.setTimeout(function actionLoop() {
      // Wait for session init.
      if (!sessionReady) { socket.setTimeout(actionLoop, 200); return; }

      // Check for action timeout.
      if (pendingOutput) {
        if (Date.now() - actionStartMs > ACTION_TIMEOUT_MS) {
          shinyActionOk.add(0);
          pendingOutput = null;
        } else {
          socket.setTimeout(actionLoop, 50);
          return;
        }
      }

      // Pick and send next action.
      const action  = pickAction(rng());
      const inputs  = action.buildInputs(ctx);
      const frame   = encodeUpdate(inputs, FRAMES.updateTemplate);
      actionStartMs = Date.now();
      pendingOutput = { outputId: action.awaitOutput };
      socket.send(frame);
      socket.setTimeout(actionLoop, 50);
    }, 500); // initial delay: let session init settle
  });
}

// ---------------------------------------------------------------------------
// handleSummary
// ---------------------------------------------------------------------------
export function handleSummary(data) {
  const shinyOk = data.metrics.shiny_action_ok
    ? data.metrics.shiny_action_ok.values.rate : null;
  const dropped = data.metrics.dropped_iterations
    ? data.metrics.dropped_iterations.values.count : 0;

  const verdictLines = [];
  verdictLines.push('ARTIFACT_KIND=' + ARTIFACT_KIND);
  verdictLines.push('dropped_iterations=' + dropped + '  (MUST be 0 for a valid run)');
  if (dropped > 0) {
    verdictLines.push('VERDICT: INVALID RUN — load generator could not keep up.');
  } else if (shinyOk !== null) {
    verdictLines.push(
      'VERDICT: ' + (shinyOk >= 0.995 ? 'PASS' : 'FAIL') +
      '  (shiny_action_ok rate=' + (shinyOk * 100).toFixed(2) + '%)',
    );
  }

  return {
    stdout: textSummary(data, { indent: ' ', enableColors: true }) +
      '\n\n=== SHINY SLO VERDICT ===\n' + verdictLines.join('\n') + '\n',
    'shiny_adapter.summary.json': JSON.stringify({
      artifactKind: ARTIFACT_KIND,
      rates: RATES,
      metrics: data.metrics,
    }, null, 2),
  };
}
