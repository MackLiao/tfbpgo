// tests/loadtest/k6/headtohead/methodology_lint.test.js
// Plain Node test (no k6) — asserts the pinned-methodology doc contains every
// load-bearing section the adapter (Task 25) and the run (Task 26) depend on.
// Run with:  node tests/loadtest/k6/headtohead/methodology_lint.test.js
const fs = require('fs');
const path = require('path');

const DOC = path.join(__dirname, 'METHODOLOGY.md');
let failures = 0;
function check(cond, msg) {
  if (!cond) { console.error('FAIL: ' + msg); failures++; }
  else { console.log('ok: ' + msg); }
}

check(fs.existsSync(DOC), 'METHODOLOGY.md exists');
const txt = fs.existsSync(DOC) ? fs.readFileSync(DOC, 'utf8') : '';

// Required headings / anchors (these are referenced by Task 25 + Task 26).
const requiredHeadings = [
  '# Head-to-Head Methodology',
  '## 1. Why this is pinned BEFORE running',
  '## 2. Matched environment',
  '## 3. Matched workload (arrival-rate ladder)',
  '## 4. Go REST endpoint -> Shiny reactive-action mapping',
  '## 5. WebSocket-vs-REST fairness caveats',
  '## 6. What "one action" means on each side',
  '## 7. Pass criterion (the crossover)',
  '## 8. Pinned parameter table (frozen before run)',
];
requiredHeadings.forEach((h) => check(txt.includes(h), `contains heading: ${h}`));

// The mapping table must name every Go endpoint the mix (lib/mix.js) drives,
// each paired with a concrete Shiny action.
const mappedEndpoints = [
  'GET /api/v/{v}/datasets',
  'GET /api/v/{v}/binding',
  'GET /api/v/{v}/binding/corr',
  'GET /api/v/{v}/perturbation',
  'GET /api/v/{v}/comparison/topn',
  'GET /api/v/{v}/regulators/resolve',
];
mappedEndpoints.forEach((e) => check(txt.includes(e), `mapping table row for: ${e}`));

// Concrete Shiny namespaced input IDs the adapter sends (proves the mapping is
// concrete, not vague). These are the module-namespaced reactive inputs.
const shinyInputs = [
  'select_datasets-apply_pending',
  'binding-execute_analysis',
  'perturbation-execute_analysis',
  'comparison-execute_analysis',
  'main_nav',
];
shinyInputs.forEach((i) => check(txt.includes(i), `names Shiny input: ${i}`));

// Pass criterion must be stated in the exact terms the assembled summary uses.
check(txt.includes('availabilityThresholds'), 'references availabilityThresholds');
check(txt.includes('arrival_slo.js'), 'references arrival_slo.js as the Go driver');
check(txt.includes('shiny_adapter.js'), 'references shiny_adapter.js as the Shiny driver');
check(/req\/s.{0,40}crossover/i.test(txt) || txt.includes('req/s-at-SLO crossover'),
  'states the req/s-at-SLO crossover deliverable');

// Fairness caveats must explicitly name the asymmetries so the comparison is honest.
['render', 'gzip', 'compute-on-server', 'think time', 'SockJS', 'reconnect']
  .forEach((w) => check(txt.toLowerCase().includes(w.toLowerCase()),
    `caveats mention: ${w}`));

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log('\nAll methodology-doc checks passed.');
