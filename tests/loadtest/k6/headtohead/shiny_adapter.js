// tests/loadtest/k6/headtohead/shiny_adapter.js
//
// PURE LOGIC for the Shiny WebSocket/SockJS head-to-head k6 adapter.
//
// This module has ZERO k6 imports so it is safely require()-able under plain
// Node.js for unit testing. The k6 entry points (options / setup / shinyVU)
// live in shiny_k6.js which imports this file as an ES module.
//
// Usage from tests:
//   const mod = require('./shiny_adapter.js');
//
// Usage from k6 (via shiny_k6.js):
//   import { SHINY_ACTIONS, pickAction, framesReady,
//            encodeUpdate, unwrapSockJS, matchOutput } from './shiny_adapter.js';
//
// IMPORTANT: Before running shiny_k6.js, the frame-capture step must be
// completed. See ./CAPTURE.md for exact step-by-step instructions. With
// frames.js __CAPTURED__ = false the adapter refuses to run (framesReady()).
//
// Architecture notes:
//   - Actions and weights mirror lib/mix.js WEIGHTS so the workload distribution
//     is equivalent to the Go arm (see METHODOLOGY.md §4).
//   - One persistent WebSocket connection per VU (matches real browser behavior).
//   - Each VU loops: pick action -> send update frame -> await output frame.
//   - SockJS framing is handled via FRAMES.sockjsFraming (see frames.js).
//
// Metrics emitted (by shiny_k6.js):
//   shiny_action_ok          (Rate)    — 1 per successful action, 0 per failure/timeout
//   shiny_action_ms          (Trend)   — wall-ms per completed action
//   shiny_reconnects_total   (Counter) — WS reconnect events (high = session churn)

// ---------------------------------------------------------------------------
// Action definitions (mirror lib/mix.js WEIGHTS + METHODOLOGY.md §4 mapping)
// ---------------------------------------------------------------------------

// SHINY_ACTIONS: map of actionName -> { weight, awaitOutput, buildInputs(ctx) }
//
// Each action names the Shiny namespaced output id it awaits (awaitOutput) and
// provides buildInputs() that returns the {inputId: value} map to send in the
// update frame. Counters for execute_analysis inputs are incremented per VU via
// ctx.counters so each button click is distinct (Shiny ignores duplicate values).
//
// Input ids must be module-namespaced (contain a hyphen) or be the top-level
// navbar id 'main_nav'. See METHODOLOGY.md §4 for the mapping rationale.
const SHINY_ACTIONS = {
  open_datasets: {
    weight: 4,
    awaitOutput: 'select_datasets-regulator_list',
    buildInputs(ctx) {
      return { main_nav: 'Select Datasets' };
    },
  },
  resolve_regulators: {
    weight: 8,
    awaitOutput: 'select_datasets-regulator_list',
    buildInputs(ctx) {
      ctx.counters['select_datasets-apply_pending'] =
        (ctx.counters['select_datasets-apply_pending'] || 0) + 1;
      return {
        'select_datasets-apply_pending': ctx.counters['select_datasets-apply_pending'],
      };
    },
  },
  binding_execute: {
    weight: 34,
    awaitOutput: 'binding-box_plot_container',
    buildInputs(ctx) {
      ctx.counters['binding-execute_analysis'] =
        (ctx.counters['binding-execute_analysis'] || 0) + 1;
      const reg = _pickFromPool(ctx.regulators, ctx.rng());
      return {
        main_nav: 'Binding',
        'binding-regulator': reg,
        'binding-execute_analysis': ctx.counters['binding-execute_analysis'],
      };
    },
  },
  binding_scatter: {
    weight: 12,
    awaitOutput: 'binding-scatter_container',
    buildInputs(ctx) {
      ctx.counters['binding-execute_analysis'] =
        (ctx.counters['binding-execute_analysis'] || 0) + 1;
      const reg = _pickFromPool(ctx.regulators, ctx.rng());
      return {
        main_nav: 'Binding',
        'binding-regulator': reg,
        'binding-view': 'scatter',
        'binding-execute_analysis': ctx.counters['binding-execute_analysis'],
      };
    },
  },
  perturbation_execute: {
    weight: 22,
    awaitOutput: 'perturbation-volcano_container',
    buildInputs(ctx) {
      ctx.counters['perturbation-execute_analysis'] =
        (ctx.counters['perturbation-execute_analysis'] || 0) + 1;
      const reg = _pickFromPool(ctx.regulators, ctx.rng());
      return {
        main_nav: 'Perturbation',
        'perturbation-regulator': reg,
        'perturbation-execute_analysis': ctx.counters['perturbation-execute_analysis'],
      };
    },
  },
  comparison_execute: {
    weight: 14,
    awaitOutput: 'comparison-topn_container',
    buildInputs(ctx) {
      ctx.counters['comparison-execute_analysis'] =
        (ctx.counters['comparison-execute_analysis'] || 0) + 1;
      const topNs = [10, 25, 50, 100];
      const topN = topNs[Math.floor(ctx.rng() * topNs.length)];
      return {
        main_nav: 'Comparison',
        'comparison-top_n': topN,
        'comparison-execute_analysis': ctx.counters['comparison-execute_analysis'],
      };
    },
  },
};

// Stable order + cumulative weight table for pickAction().
const _ACTION_ORDER = Object.keys(SHINY_ACTIONS);
const _ACTION_TOTAL = _ACTION_ORDER.reduce(
  function(s, k) { return s + SHINY_ACTIONS[k].weight; }, 0,
);
const _ACTION_CUMULATIVE = (function() {
  var acc = 0;
  return _ACTION_ORDER.map(function(k) {
    acc += SHINY_ACTIONS[k].weight;
    return acc;
  });
})();

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Pick an action from SHINY_ACTIONS given a uniform random in [0, 1).
 * Returns { name, weight, awaitOutput, buildInputs } (the full action object
 * augmented with its name).
 */
function pickAction(rng01) {
  var r = Math.min(rng01 <= 0 ? 0 : rng01, 0.999999) * _ACTION_TOTAL;
  for (var i = 0; i < _ACTION_ORDER.length; i++) {
    if (r < _ACTION_CUMULATIVE[i]) {
      var name = _ACTION_ORDER[i];
      return Object.assign({ name: name }, SHINY_ACTIONS[name]);
    }
  }
  // fallback: last action
  var last = _ACTION_ORDER[_ACTION_ORDER.length - 1];
  return Object.assign({ name: last }, SHINY_ACTIONS[last]);
}

/**
 * Returns true if the frames object has been populated by the operator.
 * The adapter refuses to run until this returns true.
 */
function framesReady(frames) {
  if (!frames || frames.__CAPTURED__ !== true) return false;
  if (!frames.wsPath) return false;
  if (!Array.isArray(frames.initSend) || frames.initSend.length === 0) return false;
  if (!frames.readyMarker) return false;
  return true;
}

/**
 * Encode a Shiny "update" envelope: clone the captured template and replace
 * .data with the provided inputs map. Returns a JSON string ready to send.
 */
function encodeUpdate(inputs, template) {
  var envelope = Object.assign({}, template, {
    data: Object.assign({}, inputs),
  });
  return JSON.stringify(envelope);
}

/**
 * Unwrap a SockJS-framed server message. SockJS wraps messages as:
 *   a["<escaped-json>"]
 * Returns the inner JSON string, or rawFrame if not SockJS-framed.
 * Pass framing = null or omit messageArrayPrefix to skip unwrapping.
 */
function unwrapSockJS(rawFrame, framing) {
  if (!framing || !framing.messageArrayPrefix) return rawFrame;
  var prefix = framing.messageArrayPrefix + '[';
  if (typeof rawFrame === 'string' && rawFrame.startsWith(prefix)) {
    // a["<escaped>"] -> strip prefix/suffix and parse inner array
    var inner = rawFrame.slice(prefix.length, rawFrame.length - 1);
    try {
      var arr = JSON.parse('[' + inner + ']');
      return arr[0] || rawFrame;
    } catch (_) {
      return rawFrame;
    }
  }
  return rawFrame;
}

/**
 * Returns true if the server frame (a JSON string) contains the awaited
 * outputId under `.values` AND does NOT carry an error for that output.
 * Returns false if the output appears under `.errors` (action failed server-side).
 */
function matchOutput(rawFrame, outputId) {
  var parsed;
  try {
    parsed = JSON.parse(rawFrame);
  } catch (_) {
    return false;
  }
  // An error for this output = failure, not success.
  if (parsed.errors && Object.prototype.hasOwnProperty.call(parsed.errors, outputId)) {
    return false;
  }
  return !!(parsed.values && Object.prototype.hasOwnProperty.call(parsed.values, outputId));
}

// Internal: pick a random element from pool using rng01.
function _pickFromPool(pool, rng01) {
  if (!pool || pool.length === 0) return 'YAL001C'; // safe fallback
  return pool[Math.min(pool.length - 1, Math.floor(rng01 * pool.length))];
}

// ---------------------------------------------------------------------------
// Module exports — CommonJS (for Node unit tests) + ES module (for k6)
// ---------------------------------------------------------------------------

// CommonJS export (Node require()).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    SHINY_ACTIONS: SHINY_ACTIONS,
    pickAction: pickAction,
    framesReady: framesReady,
    encodeUpdate: encodeUpdate,
    unwrapSockJS: unwrapSockJS,
    matchOutput: matchOutput,
  };
}

// ES module export (k6 / shiny_k6.js import). Placed at the bottom after the
// CJS guard so Node's CJS loader processes module.exports first and never
// reaches the `export` keyword (which would be a syntax error in CJS mode).
// k6's ES module loader hoists these regardless of placement.
//
// Note: k6 runs this file as an ES module via shiny_k6.js's import statement.
// The `export` keyword here makes the pure helpers available to that import.
// Node's `require()` does NOT execute past the `module.exports` block above
// because Node exits the CJS module after processing — the `export` line
// below is never reached in the CJS execution path.
//
// HOWEVER: if Node detects `export` in a .js file it will treat the entire
// file as an ES module and reject require(). To avoid this, the k6 ES module
// exports are declared in shiny_k6.js itself (which re-exports from this
// file). This file intentionally contains NO top-level `export` or `import`
// keywords — it is plain CJS/CommonJS. k6 can still use it via import() or
// by having shiny_k6.js require() it with createRequire.
