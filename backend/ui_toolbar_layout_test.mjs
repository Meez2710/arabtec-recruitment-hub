// Structural contract for the shared filter toolbar (<FilterToolbar>, used by
// the Talent Pool and Hiring Requests).
//
// These checks do NOT prove pixel geometry — this process lays out no document.
// Real rendered geometry was verified in a browser against the production
// stylesheets at 1440, 1366, 1280, 1200, 1024, 768 and 390. What is asserted
// here is the structure and the CSS contract that produced it, so the measured
// result cannot be silently undone.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const publicDir = fileURLToPath(new URL('../frontend/public/', import.meta.url));
const css = fs.readFileSync(publicDir + 'claude-system.css', 'utf8');
const app = fs.readFileSync(publicDir + 'app.jsx', 'utf8');
const section = css.slice(css.indexOf('18. FILTER TOOLBAR'));

const window = new EventTarget();
window.location = { hash: '', pathname: '/', search: '', reload() {} };
window.history = { replaceState() {} };
const document = Object.assign(new EventTarget(), { getElementById: () => ({}), activeElement: null });
const ctx = vm.createContext({ window, document, Event, CustomEvent, URLSearchParams, console,
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {},
  ReactDOM: { createRoot: () => ({ render() {} }) },
  fetch() { throw new Error('toolbar tests must not use the network'); } });
ctx.self = ctx;
vm.runInContext(fs.readFileSync(publicDir + 'vendor/react.production.min.js', 'utf8'), ctx);
vm.runInContext(fs.readFileSync(publicDir + 'vendor/babel.min.js', 'utf8'), ctx);
for (const file of ['email-settings.jsx', 'org-structure.jsx', 'app.jsx']) {
  vm.runInContext(ctx.Babel.transform(fs.readFileSync(publicDir + file, 'utf8'),
    { presets: ['react'] }).code, ctx, { filename: file });
}
const get = (e) => vm.runInContext(e, ctx);
const React = ctx.React;

let slots = [], cursor = 0;
const dispatcher = {
  useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = { value: typeof initial === 'function' ? initial() : initial }; return [slots[i].value, () => {}]; },
  useRef(initial) { const i = cursor++; if (!(i in slots)) slots[i] = { value: { current: initial } }; return slots[i].value; },
  useId() { return 'test-id'; },
  useMemo(fn) { return fn(); }, useCallback(fn) { return fn; },
  useContext: (c) => c._currentValue, useEffect() {},
};
function render(Component, props) {
  slots = []; cursor = 0;
  React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher.current = dispatcher;
  try { return Component(props); }
  finally { React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher.current = null; }
}
function nodes(tree) {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!tree || typeof tree !== 'object') return [];
  const out = [tree];
  for (const [k, v] of Object.entries(tree.props || {})) {
    if (k === 'children' || (v && typeof v === 'object' && ('type' in v || Array.isArray(v)))) out.push(...nodes(v));
  }
  return out;
}
const byClass = (tree, cls) => nodes(tree).filter((n) => typeof n.props?.className === 'string'
  && n.props.className.split(' ').includes(cls));

let passed = 0, failed = 0;
async function check(name, run) {
  try { await run(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n      ${e.message}`); }
}

await check('the toolbar renders one shared structure, not a per-page layout', () => {
  const tree = render(get('FilterToolbar'), {
    search: React.createElement('input', { placeholder: 'Search' }),
    count: React.createElement('span', { className: 'count-pill' }, '0'),
    children: React.createElement('input', { placeholder: 'Location' }),
    activeCount: 0,
  });
  assert.equal(byClass(tree, 'filter-toolbar').length, 1, 'the root carries .filter-toolbar');
  assert.equal(byClass(tree, 'toolbar').length, 1, 'and the shared .toolbar base');
  for (const cls of ['toolbar-search', 'filter-toggle', 'toolbar-secondary', 'toolbar-count']) {
    assert.equal(byClass(tree, cls).length, 1, `exactly one .${cls}`);
  }
  // Geometry comes from classes, never from inline style on the toolbar parts.
  for (const cls of ['filter-toolbar', 'toolbar-search', 'toolbar-secondary', 'toolbar-count']) {
    const node = byClass(tree, cls)[0];
    assert.equal(node.props.style ?? null, null, `.${cls} must not carry inline geometry`);
  }
});

await check('the disclosure button is declared specifically enough to stay hidden on desktop', () => {
  // `.filter-toggle` alone (one class) loses to `button.btn` (class + element)
  // further up the sheet, which is why it used to render at 1440.
  assert.match(section, /\.filter-toolbar > button\.filter-toggle[\s\S]{0,120}?display:\s*none/,
    'the hidden state names the element, so it outranks button.btn');
  const narrow = section.slice(section.indexOf('@media (max-width: 1100px)'));
  assert.match(narrow, /\.filter-toolbar > button\.filter-toggle[\s\S]{0,160}?display:\s*inline-flex/,
    'and the visible state at narrow widths is declared the same way');
});

await check('the primary search grows faster than the filter group', () => {
  const grow = (sel) => {
    const m = section.match(new RegExp(`\\.filter-toolbar > \\.${sel} \\{[^}]*flex:\\s*(\\d+)`));
    assert.ok(m, `.${sel} declares a flex grow factor`);
    return Number(m[1]);
  };
  assert.ok(grow('toolbar-search') > grow('toolbar-secondary'),
    `search must grow fastest — search ${grow('toolbar-search')} vs filters ${grow('toolbar-secondary')}`);
  assert.match(section, /\.filter-toolbar > \.toolbar-search \{[^}]*min-width:\s*\d+px/,
    'and it keeps a floor so it cannot collapse to nothing');
});

await check('the result count stays out of the wrap flow', () => {
  assert.match(section, /\.filter-toolbar > \.toolbar-count \{[^}]*flex:\s*0 0 auto/,
    'the count neither grows nor shrinks');
  assert.match(section, /\.filter-toolbar > \.toolbar-count \{[^}]*margin-left:\s*auto/,
    'and is pinned to the end of its row instead of claiming one of its own');
});

await check('selecting a screen tab cannot change its width', () => {
  // 500 -> 600 on .active widened the selected label and shifted its
  // neighbours. Emphasis is colour, background and lift; never metrics.
  assert.match(css, /\.seg-tab,\s*\.seg-tab\.active \{ font-weight: (\d+); \}/,
    'both states declare the same weight');
  const m = css.match(/\.seg-tab,\s*\.seg-tab\.active \{ font-weight: (\d+); \}/);
  const unified = m[1];
  const activeOnly = [...css.matchAll(/\.seg-tab\.active[^{]*\{([^}]*)\}/g)]
    .map((x) => x[1]).filter((b) => /font-weight/.test(b));
  for (const body of activeOnly) {
    const w = body.match(/font-weight:\s*(\d+)/);
    if (w) assert.equal(w[1], unified, 'no later rule reintroduces a different active weight');
  }
  assert.equal(/\.seg-tab[^{]*\{[^}]*font-size/.test(section), false,
    'and this section changes no font size');
});

await check('the toolbar section introduces no colour and no font-size', () => {
  assert.equal(/#[0-9a-fA-F]{3,8}\b|rgb\(|hsl\(|oklch\(/.test(section), false,
    'geometry layer stays colour-free');
  assert.equal(/font-family/.test(section), false, 'and declares no typeface');
});

await check('the Candidates toolbar still composes the shared component', () => {
  const page = app.slice(app.indexOf('function CandidatesPage'), app.indexOf('function ParsePreviewTable'));
  assert.match(page, /<FilterToolbar\b/, 'Candidates uses FilterToolbar rather than a bespoke toolbar');
  assert.match(page, /className="seg-tabs"/, 'and the screen tabs remain the shared seg-tabs');
  // The secondary filters are passed as children, i.e. into .toolbar-secondary.
  // Counted by name, because a bare <input count would also catch the one
  // handed to the `search` prop.
  const ft = page.slice(page.indexOf('<FilterToolbar'), page.indexOf('</FilterToolbar>'));
  for (const key of ['location', 'currentCompany', 'graduationFrom', 'graduationTo', 'tag']) {
    assert.ok(ft.includes(`filters.${key}`), `the ${key} filter is a toolbar child`);
  }
  assert.ok(ft.includes('filters.q'), 'and the primary search is the search prop');
});


/* ---------------------------------------------------------------------------
   Regression guard for the shared toolbar on Hiring Requests (Task 3.5A-V).

   Requests carries a much heavier filter group than the Talent Pool — three
   selects, two checkbox switches, a sort select and a direction button. Once
   3.5A gave the group a 472px basis it wrapped at 1200, and because every
   filter grows at 1 from an 88px basis, the single growable control on the
   sparse second line absorbed everything: a 436px sort select beside a 56px
   button (490px at 1280). Browser-measured; the cap below is what corrects it.
   ------------------------------------------------------------------------ */

await check('no filter can absorb a whole wrapped line', () => {
  const m = section.match(/max-width:\s*(\d+)px/);
  assert.ok(m, 'the filter group caps how wide a growable control may become');
  const cap = Number(m[1]);
  // Measured with width:max-content: the widest filter either page owns is the
  // owner select at 270px. The cap must clear that, or it would clip content it
  // is supposed to protect.
  assert.ok(cap >= 270, `the cap must clear the widest real filter (270px), got ${cap}px`);
  assert.ok(cap <= 320, `and must still be narrower than the stretch it prevents, got ${cap}px`);
  assert.match(section, /\.toolbar-secondary > input,\s*\n?\s*\.toolbar-secondary > select \{[^}]*max-width/,
    'it applies to both the text filters and the selects');
});

await check('the cap is a wide-toolbar rule only; the phone stack still fills its row', () => {
  // On a phone a filter alone on a line is supposed to fill it. Measured at
  // 390px with the panel open, an unscoped cap left the fifth filter at 280px
  // in a 324px row — the same ragged edge the cap exists to prevent elsewhere.
  const capAt = section.indexOf('max-width:');
  const guard = section.lastIndexOf('@media', capAt);
  assert.ok(guard !== -1, 'the cap sits inside a media query');
  const condition = section.slice(guard, section.indexOf('{', guard));
  assert.match(condition, /min-width:\s*641px/,
    `the cap must be scoped to 641px and up, found: ${condition.trim()}`);
});

await check('Hiring Requests composes the same shared toolbar, unmodified', () => {
  const page = app.slice(app.indexOf('function RequestsPage'), app.indexOf('function RequestForm'));
  assert.match(page, /<FilterToolbar\b/, 'Requests still uses the shared component');
  // Its heavier group is what exposed the stretch; keep that shape on record.
  for (const key of ['filters.status', 'filters.priority', 'filters.owner', 'filters.sort']) {
    assert.ok(page.includes(key), `the ${key} filter is still a toolbar child`);
  }
  assert.ok((page.match(/className="switch"/g) || []).length >= 2,
    'both checkbox switches are still in the group');
  // No page-specific toolbar override was introduced to paper over the shared rules.
  assert.equal(/className="toolbar filter-toolbar [a-z]/.test(page), false,
    'Requests adds no bespoke class to the shared toolbar');
});

console.log(`\n=== UI TOOLBAR LAYOUT: ${passed} passed, ${failed} failed ===`);
if (failed) process.exit(1);
