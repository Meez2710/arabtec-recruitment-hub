// Layout rules the product has already paid for once. Each rule below is a
// defect that was found on a real screen, fixed, and must not come back:
// the check reads the shipped CSS/JSX and fails the build if the fix is gone.
// Static on purpose — it runs in CI with no browser — so each rule names the
// exact declaration that carries the fix. See docs/audits/ui-rules.md.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const pub = fileURLToPath(new URL('../frontend/public/', import.meta.url));
const css = Object.fromEntries(['styles.css', 'arabtec-design-system.css', 'claude-system.css', 'arabtec-responsive.css', 'arabtec-mobile.css']
  .map((f) => [f, fs.readFileSync(pub + f, 'utf8')]));
const jsx = fs.readFileSync(pub + 'app.jsx', 'utf8');
let passed = 0, failed = 0;
const rule = (name, fn) => { try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { failed++; console.error(`  ✗ ${name}\n      ${e.message}`); } };
// The block a selector's declarations live in, within one file.
const block = (file, selector) => { const i = css[file].indexOf(selector); assert.notEqual(i, -1, `${selector} missing from ${file}`); return css[file].slice(i, css[file].indexOf('}', i)); };
// Everything inside a phone media query of a file.
const phoneScope = (file) => { const i = css[file].indexOf('@media (max-width: 640px)'); assert.notEqual(i, -1, `${file} has no 640px phone block`); return css[file].slice(i); };

rule('R1 a filter select never clips its own label on wide toolbars (was "All statu" at 1440)', () => {
  const wide = css['claude-system.css'].slice(css['claude-system.css'].indexOf('@media (min-width: 641px)'));
  assert.match(wide, /\.toolbar-secondary > select \{ min-width: max-content; \}/);
});
rule('R2 the phone candidate header is a grid with the actions on their own row (name wrapped letter by letter)', () => {
  const scope = phoneScope('arabtec-responsive.css');
  assert.match(scope, /\.profile-header \{[^}]*display: grid;[^}]*grid-template-columns: auto minmax\(0, 1fr\)/s);
  assert.match(scope, /\.profile-header > :last-child \{[^}]*grid-column: 1 \/ -1/s);
});
rule('R3 a card title never wraps under its subtitle on a phone', () => {
  const scope = phoneScope('arabtec-responsive.css');
  assert.match(scope, /\.card-head \{[^}]*flex-wrap: wrap/s);
  assert.match(scope, /\.card-head > \.dash-headnote \{[^}]*flex-basis: 100%/s);
});
rule('R4 buttons on the brand-coloured bulk bar keep readable labels (white-on-white Clear, green-on-green Move)', () => {
  const b = block('arabtec-design-system.css', '.bulk-bar .btn {'); assert.match(b, /background: #fff/); assert.match(b, /color: var\(--green-700\)/);
  const g = block('arabtec-design-system.css', '.bulk-bar .btn-ghost {'); assert.match(g, /color: #fff/); assert.match(g, /border-color: rgba\(255, 255, 255/);
});
rule('R5 five pipeline columns fit the 1440 content column, and the board shows its scrollbar below that', () => {
  const k = block('claude-system.css', '.kanban {');
  const min = Number((k.match(/grid-auto-columns: minmax\((\d+)px/) || [])[1]);
  const gap = Number((k.match(/gap: (\d+)px/) || [])[1]);
  assert.ok(min && gap, 'kanban declares a px column minimum and a px gap');
  assert.ok(5 * min + 4 * gap <= 1128, `5 × ${min} + 4 × ${gap} = ${5 * min + 4 * gap}px must fit 1128px`);
  assert.match(k, /scrollbar-width: thin/);
});
rule('R6 no form value is read back through document.getElementById (bulk destination was a DOM lookup)', () => {
  const reads = jsx.match(/document\.getElementById\([^)]*\)\.value/g) || [];
  assert.equal(reads.length, 0, `found ${reads.length}: ${reads.join(', ')}`);
});
rule('R7 every dashboard KPI tile can withhold its number (a zero must never stand in for a failed read)', () => {
  assert.match(jsx, /function KpiCard\(\{[^}]*unavailable[^}]*\}\)/);
  assert.match(jsx, /unavailable \? '—' : value/);
});
rule('R8 a disabled control uses the product\'s one opacity, never a local value', () => {
  for (const [file, text] of Object.entries(css)) {
    const local = [...text.matchAll(/:disabled[^{]*\{[^}]*opacity:\s*([\d.]+)/g)].map((m) => m[1]).filter((v) => v !== '.45' && v !== '0.45');
    assert.equal(local.length, 0, `${file} declares disabled opacity ${local.join(', ')}`);
  }
});
rule('R9 an in-card error state is the shared Empty/LoadError, never a hand-rolled red box', () => {
  assert.equal((jsx.match(/style=\{\{[^}]*background: ?'#FFF8F8'/g) || []).length, 0, 'inline error surfaces');
});

console.log(`\n=== UI LAYOUT RULES: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed ? 1 : 0);
