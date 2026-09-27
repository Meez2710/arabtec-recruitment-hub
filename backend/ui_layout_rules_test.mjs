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
rule('R10 emoji reach the screen only through the EMOJI map, in a Hint or the knowledge line (never a button, title, badge or cell)', () => {
  // Pictographic emoji only: ✓ and ○ are typographic marks and stay allowed.
  const emoji = /[\u{1F300}-\u{1FAFF}]|✅/u;
  const offenders = jsx.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => emoji.test(l) && !/^\s*(hint|leadership): '/.test(l));
  assert.deepEqual(offenders.map(([n]) => n), [], `emoji outside the EMOJI map on lines ${offenders.map(([n]) => n).join(', ')}`);
  assert.match(jsx, /function Hint\(\{ emoji = 'hint', children, action \}\)/);
  assert.match(jsx, /EMOJI\[line\.t\] && <span className="kl-emoji"/);
});
rule('R11 every page title carries its eyebrow with the brand dash, tracked and muted (the crumb is the eyebrow)', () => {
  const b = block('arabtec-design-system.css', '.page-head .breadcrumb::before, .dash-eyebrow::before {');
  assert.match(b, /width: 18px; height: 2px/); assert.match(b, /background: var\(--brand\)/);
  const t = block('claude-system.css', '.breadcrumb, .page-head .breadcrumb, .dash-eyebrow {');
  assert.match(t, /text-transform: uppercase/); assert.match(t, /letter-spacing: \.18em/);
});
rule('R12 the sidebar is charcoal with one red bar on the active item; buttons are one solid green action, badges never pills', () => {
  const ds = css['arabtec-design-system.css'].slice(css['arabtec-design-system.css'].indexOf('12. WORKFORCE'));
  assert.match(ds, /\.sidebar \{ background: var\(--sidebar-bg\); color: #fff;/);
  assert.match(ds, /--sidebar-bg: #1A1A1A/);
  assert.match(ds, /\.nav-item\.active::before \{[^}]*background: var\(--brand\)/s);
  assert.match(ds, /\.btn \{ background: var\(--green-700\); color: #fff;/);
  assert.match(ds, /\.badge, \.status-chip \{ border-radius: 6px;/);
  assert.equal(/border-width|min-height|padding: 0/.test(ds.slice(ds.indexOf('/* Buttons'), ds.indexOf('/* Badges'))), false, 'button colour rules never touch the box');
});
rule('R13 headers, toolbars and tabs never stack as bordered surfaces above the working content (three rectangles before the table)', () => {
  const cl = css['claude-system.css']; const sec = cl.slice(cl.indexOf('18b. COMPACT COMPOSITION'), cl.indexOf('19. COMPACT STATE COMPONENTS'));
  assert.match(sec, /\.toolbar \{[^}]*padding: 0;[^}]*border-width: 0;/s, 'the toolbar has no surface of its own');
  assert.match(sec, /\.seg-tabs \{[^}]*border-width: 0 0 1px;/s, 'tabs are an underline row');
  assert.match(sec, /\.ticket-header-card \{[^}]*border-width: 0 0 1px;/s, 'the request head sits on the canvas');
  assert.match(sec, /\.card\.profile-shell \{[^}]*border-width: 0 0 1px;/s, 'the candidate head sits on the canvas');
  assert.match(sec, /\.dash-kpi, \.kpi \{[^}]*min-height: 0;/s, 'stat tiles do not reserve height');
  const ds = css['arabtec-design-system.css'].slice(css['arabtec-design-system.css'].indexOf('12b. Compact composition'));
  assert.match(ds, /\.toolbar, \.toolbar\.ask-bar \{ background: transparent; border-color: transparent; \}/);
  assert.match(jsx, /className="card profile-shell"/); assert.match(jsx, /className="card card-pad profile-overview"/);
});
rule('R14 the phone shell has its own composition: one scrolling action row, no count chip in the filter bar, one board stage per screen', () => {
  const mb = css['arabtec-mobile.css'].slice(css['arabtec-mobile.css'].indexOf('PHONE COMPOSITION SYSTEM'));
  assert.match(mb, /\.shell-phone \.page-head-actions, \.shell-phone \.dash-actions \{[^}]*flex-wrap: nowrap;[^}]*overflow-x: auto;/s);
  assert.match(mb, /\.shell-phone \.filter-toolbar > \.toolbar-count \{ display: none; \}/);
  assert.match(mb, /\.shell-phone \.kanban \{[^}]*scroll-snap-type: x mandatory;/s);
  assert.match(mb, /\.shell-phone \.kan-col \{[^}]*flex: 0 0 84%;[^}]*scroll-snap-align: start;/s);
  assert.match(mb, /padding-top: calc\(var\(--ats-mtop-h\) \+ 12px\)/, 'the content still clears the fixed top bar');
});
rule('R15 a conditional render never prints a bare zero (`x && y.length` rendered "0" above the board)', () => {
  const hits = jsx.match(/\(\w+ && \w+\.length\)\) &&/g) || [];
  assert.deepEqual(hits, [], `found ${hits.join(', ')}`);
});
rule('R9 an in-card error state is the shared Empty/LoadError, never a hand-rolled red box', () => {
  assert.equal((jsx.match(/style=\{\{[^}]*background: ?'#FFF8F8'/g) || []).length, 0, 'inline error surfaces');
});

const { offScale, SHEETS } = await import('./test-support/spacing-scan.mjs');
rule('R16 no new margin, padding or gap off the 4/8/12/16/24/32 scale; the legacy list only shrinks', () => {
  const legacy = JSON.parse(fs.readFileSync(new URL('../docs/audits/spacing-legacy.json', import.meta.url), 'utf8')).declarations;
  const now = offScale();
  const left = [...legacy];
  const added = [];
  for (const d of now) { const k = left.indexOf(d); if (k === -1) added.push(d); else left.splice(k, 1); }
  assert.equal(SHEETS.length, 6, 'the scan reads the six product sheets');
  assert.deepEqual(added, [], 'off-scale spacing added (use --sp-1..--sp-6 or 4/8/12/16/24/32px):\n        ' + added.join('\n        '));
  assert.deepEqual(left, [], 'these legacy declarations were fixed; delete them from docs/audits/spacing-legacy.json:\n        ' + left.join('\n        '));
});
rule('R17 one button spec: no page-scoped .btn height or padding outside claude-system.css, and no stretched head buttons', () => {
  const sheets = ['styles.css', 'arabtec-approved-ui.css', 'arabtec-design-system.css', 'arabtec-responsive.css'];
  // Bare component selectors are the base layers claude-system.css overrides;
  // anything with an ancestor or page scope is a per-page override.
  const base = /^\.btn(-sm|-block|\.small)?$/;
  const bad = [];
  for (const f of sheets) {
    const src = fs.readFileSync(pub + f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of src.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const parts = m[1].trim().split(',').map((p) => p.trim()).filter((p) => /\.btn\b/.test(p) && !base.test(p));
      if (parts.length && /(^|;)\s*(min-height|height|padding(-left|-right|-inline)?)\s*:/.test(m[2])) bad.push(`${f}: ${parts.join(', ')}`);
    }
  }
  assert.deepEqual(bad, [], 'page-scoped .btn box overrides');
  const resp = css['arabtec-responsive.css'];
  assert.doesNotMatch(resp, /\.upload-cta\s*\{\s*display:\s*contents/, 'no display: contents trick in the Talent Pool head');
  assert.doesNotMatch(resp.replace(/\/\*[\s\S]*?\*\//g, ''), /page-head-actions > \.btn[^{]*\{[^}]*flex:\s*1 1/, 'head buttons never grow');
  assert.match(jsx, /<button className="btn btn-secondary" onClick=\{\(\) => setCreating\(true\)\} title="Enter a candidate by hand/, 'Add manually is a secondary, not a ghost');
  assert.doesNotMatch(jsx, /className="upload-cta"/, 'no wrapper box around Bulk Upload');
});
console.log(`\n=== UI LAYOUT RULES: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed ? 1 : 0);
