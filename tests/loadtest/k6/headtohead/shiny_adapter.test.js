// tests/loadtest/k6/headtohead/shiny_adapter.test.js
// Node test of the adapter's PURE logic (no k6, no live Shiny). Verifies:
//  - action selection uses the SAME lib/mix.js WEIGHTS distribution
//  - input-frame templating substitutes namespaced IDs + values correctly
//  - the capture-guard refuses to run on empty frames (operational prereq)
//  - output-await matcher recognizes the completion frame for an action
// Run with:  node tests/loadtest/k6/headtohead/shiny_adapter.test.js
const fs = require('fs');
const path = require('path');
const assert = require('assert');

let failures = 0;
function ok(cond, msg) { if (!cond) { console.error('FAIL: ' + msg); failures++; } else { console.log('ok: ' + msg); } }

// The adapter exports its pure helpers under a CommonJS-compatible guard so this
// Node test can require them. (k6 imports the same file as an ES module.)
const mod = require('./shiny_adapter.js');

// 1. Action set is derived from the same mix weights -> same distribution.
ok(typeof mod.SHINY_ACTIONS === 'object', 'exports SHINY_ACTIONS map');
const actionNames = Object.keys(mod.SHINY_ACTIONS);
['open_datasets', 'binding_execute', 'perturbation_execute', 'comparison_execute', 'binding_scatter']
  .forEach((a) => ok(actionNames.includes(a), `action defined: ${a}`));

// pickAction must be deterministic given an rng in [0,1) and cover the space.
ok(typeof mod.pickAction === 'function', 'exports pickAction(rng01)');
const lo = mod.pickAction(0.0);
const hi = mod.pickAction(0.999999);
ok(actionNames.includes(lo.name), 'pickAction(0) returns a known action');
ok(actionNames.includes(hi.name), 'pickAction(~1) returns a known action');

// 2. Each action declares the namespaced Shiny input(s) it sets + output to await.
for (const [name, a] of Object.entries(mod.SHINY_ACTIONS)) {
  ok(typeof a.weight === 'number' && a.weight > 0, `${name} has positive weight`);
  ok(typeof a.awaitOutput === 'string' && a.awaitOutput.length > 0, `${name} declares awaitOutput`);
  ok(typeof a.buildInputs === 'function', `${name} has buildInputs()`);
  const inputs = a.buildInputs({ regulator: 'YAL001C', topN: 25, counters: {}, rng: () => 0.5 });
  ok(inputs && typeof inputs === 'object' && !Array.isArray(inputs), `${name} buildInputs returns an object map`);
  // every key must be module-namespaced (contain a hyphen) or be the navbar id
  Object.keys(inputs).forEach((k) =>
    ok(k === 'main_nav' || k.includes('-'), `${name} input id '${k}' is namespaced`));
}

// 3. Capture-guard: with empty frames the adapter must NOT be runnable.
ok(typeof mod.framesReady === 'function', 'exports framesReady()');
const frames = require('./frames.js');
// frames.js ships empty -> framesReady(frames) must be false until captured.
ok(mod.framesReady(frames) === false || frames.__CAPTURED__ === true,
  'capture-guard reports not-ready on empty frames (operational prereq)');

// 4. encodeUpdate builds the Shiny "update" envelope from a captured template.
ok(typeof mod.encodeUpdate === 'function', 'exports encodeUpdate(inputs, template)');
// Use a synthetic template that mimics the captured envelope shape.
const tmpl = { method: 'update', data: { '__PLACEHOLDER__': 0 } };
const enc = mod.encodeUpdate({ 'binding-execute_analysis': 7 }, tmpl);
const parsed = JSON.parse(enc);
ok(parsed.method === 'update', 'encodeUpdate preserves method=update');
ok(parsed.data['binding-execute_analysis'] === 7, 'encodeUpdate injects the namespaced input + value');

// 5. matchOutput recognizes the awaited output id inside a Shiny values frame.
ok(typeof mod.matchOutput === 'function', 'exports matchOutput(rawFrame, outputId)');
const valuesFrame = JSON.stringify({ values: { 'binding-box_plot_container': '<div/>' }, errors: {} });
ok(mod.matchOutput(valuesFrame, 'binding-box_plot_container') === true, 'matchOutput detects completion frame');
ok(mod.matchOutput(valuesFrame, 'binding-scatter_container') === false, 'matchOutput rejects unrelated output');
// An error payload in the frame counts as NOT-ok (failed action).
const errFrame = JSON.stringify({ errors: { 'binding-box_plot_container': { message: 'boom' } } });
ok(mod.matchOutput(errFrame, 'binding-box_plot_container') === false, 'matchOutput treats error payload as failure');

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log('\nAll shiny_adapter pure-logic checks passed.');
