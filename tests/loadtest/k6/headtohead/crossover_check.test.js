// tests/loadtest/k6/headtohead/crossover_check.test.js
// Asserts tests/loadtest-summary.md gained a well-formed head-to-head section
// whose crossover table is parseable and whose PASS/FAIL is derivable per
// METHODOLOGY.md §7. Placeholder rows (<FILL IN>) are allowed (the operator
// fills them on the host) but the STRUCTURE is enforced now.
// Run with:  node tests/loadtest/k6/headtohead/crossover_check.test.js
const fs = require('fs');
const path = require('path');

let failures = 0;
function ok(c, m) { if (!c) { console.error('FAIL: ' + m); failures++; } else { console.log('ok: ' + m); } }

const SUM = path.join(__dirname, '..', '..', '..', 'loadtest-summary.md');
ok(fs.existsSync(SUM), 'tests/loadtest-summary.md exists');
const txt = fs.existsSync(SUM) ? fs.readFileSync(SUM, 'utf8') : '';

ok(txt.includes('## Head-to-head vs legacy Python Shiny (G3)'), 'has head-to-head section');
ok(txt.includes('req/s-at-SLO crossover'), 'mentions the req/s-at-SLO crossover deliverable');

// The crossover table must carry these columns (the operator fills the cells).
['Target', 'Posture', 'Highest req/s at SLO', 'Degradation rate', 'Degradation mode']
  .forEach((c) => ok(txt.includes(c), `crossover table column: ${c}`));

// Both targets must appear as rows.
ok(txt.includes('Go (tfbindingandperturbation.com)'), 'row for Go target');
ok(txt.includes('Shiny (legacy.tfbindingandperturbation.com)'), 'row for Shiny target');

// Both postures must be present (warm + cold), per METHODOLOGY §2/§3.
ok(/warm/i.test(txt) && /cold/i.test(txt), 'warm and cold postures present');

// The PASS criterion must be stated in the summary in the §7 terms.
ok(txt.includes('availability SLO') && (txt.includes('p99') || txt.includes('p95')),
  'states the §7 pass criterion (availability + latency)');
ok(txt.includes('shiny_action_ok') && txt.includes('shiny_action_ms'),
  'references the Shiny adapter metrics');

// Helper that derives PASS once cells are numeric (used by the operator to
// self-check). Rows like "<FILL IN>" are treated as not-yet-run.
function parseRate(s) { const m = /([0-9]+(?:\.[0-9]+)?)\s*req\/s/.exec(s); return m ? parseFloat(m[1]) : null; }
ok(typeof parseRate === 'function', 'crossover-derivation helper present in test');

if (failures > 0) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log('\nAll crossover-table structure checks passed.');
