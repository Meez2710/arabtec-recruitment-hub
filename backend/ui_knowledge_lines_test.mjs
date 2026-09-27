// The knowledge line at the foot of every page: a curated, attributed list
// that must stay short, unique and honest, and a component that never breaks
// a page when the list is missing.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
const pub = fileURLToPath(new URL('../frontend/public/', import.meta.url));
let passed = 0, failed = 0;
const check = (name, fn) => { try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { failed++; console.error(`  ✗ ${name}\n      ${e.message}`); } };
const win = {}; vm.runInNewContext(fs.readFileSync(pub + 'knowledge-lines.js', 'utf8'), { window: win });
const lines = win.ARABTEC_KNOWLEDGE_LINES;
check('at least 100 lines, each with a quote and an attribution', () => {
  assert.ok(Array.isArray(lines) && lines.length >= 100, `got ${lines?.length}`);
  for (const l of lines) { assert.ok(typeof l.q === 'string' && l.q.trim().length > 10, JSON.stringify(l)); assert.ok(typeof l.by === 'string' && l.by.trim().length > 1, JSON.stringify(l)); }
});
check('every line fits one footer row: 160 characters or fewer, no line breaks', () => {
  const long = lines.filter((l) => l.q.length > 160 || /\n/.test(l.q));
  assert.equal(long.length, 0, long.map((l) => `${l.q.length}: ${l.by}`).join('; '));
});
check('no duplicate quotes', () => { assert.equal(new Set(lines.map((l) => l.q.trim().toLowerCase())).size, lines.length); });
check('the script is loaded before the app, so the list exists when the footer first renders', () => {
  const html = fs.readFileSync(pub + 'index.html', 'utf8');
  const list = html.indexOf('src="/knowledge-lines.js'), app = html.indexOf('src="/app.jsx');
  assert.ok(list !== -1 && app !== -1 && list < app, `script order: list at ${list}, app at ${app}`);
});
check('the footer is rendered in both page shells and re-drawn per route', () => {
  const jsx = fs.readFileSync(pub + 'app.jsx', 'utf8');
  assert.equal((jsx.match(/<KnowledgeLine key=\{route\} \/>/g) || []).length, 2);
  assert.match(jsx, /if \(!Array\.isArray\(lines\) \|\| !lines\.length\) return null;/, 'a missing list renders nothing rather than throwing');
});
console.log(`\n=== UI KNOWLEDGE LINES: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed ? 1 : 0);
