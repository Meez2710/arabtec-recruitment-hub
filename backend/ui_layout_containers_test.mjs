// Source-level contract for cards and responsive containers (UI Step 8).
//
// These checks do NOT prove pixel geometry — nothing here lays out a document.
// The rendered numbers quoted below were measured in a browser against the five
// production stylesheets at 1600, 1441, 1440, 1366, 1280, 1200, 1024, 1023,
// 768, 430, 390 and 360. What is asserted here is the CSS contract that
// produced them, so the measured result cannot be silently undone.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const publicDir = fileURLToPath(new URL('../frontend/public/', import.meta.url));
const read = (f) => fs.readFileSync(publicDir + f, 'utf8');
const sheets = ['styles.css', 'arabtec-approved-ui.css', 'arabtec-design-system.css',
  'claude-system.css', 'arabtec-responsive.css'].map((f) => ({ name: f, css: read(f) }));

// Every `@media (...)` block matching `needle`, sliced by brace matching.
// claude-system.css alone carries three `(max-width: 640px)` blocks, so callers
// must consider all of them — assuming the first one silently passes over rules.
function mediaBlocks(css, needle) {
  const out = [];
  for (let at = css.indexOf(needle); at !== -1; at = css.indexOf(needle, at + 1)) {
    let depth = 0, end = at;
    for (let i = css.indexOf('{', at); i < css.length; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    out.push(css.slice(at, end));
  }
  return out;
}

// Is this offset inside any @media block? Counting `@media` against `\n}` is
// not good enough — nested rules close with their own brace and the count goes
// wrong, which is how an earlier version of this file mistook the phone card
// padding for the desktop one.
function insideMedia(css, index) {
  for (let at = css.indexOf('@media'); at !== -1; at = css.indexOf('@media', at + 1)) {
    const open = css.indexOf('{', at);
    if (open > index) break;
    let depth = 0, end = at;
    for (let i = open; i < css.length; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (index > open && index < end) return true;
  }
  return false;
}

let passed = 0, failed = 0;
function check(name, run) {
  try { run(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n      ${e.message}`); }
}

/* ---------------------------------------------------------------------------
   The laptop band no longer steps control height.
   ------------------------------------------------------------------------ */
check('the laptop band declares no control size at all', () => {
  const resp = read('arabtec-responsive.css');
  const bands = mediaBlocks(resp, '@media (min-width: 1024px) and (max-width: 1440px)');
  assert.equal(bands.length, 1, 'exactly one laptop band');
  const band = bands[0];

  // The first version of this guard tested for the two literal strings the
  // author had just deleted — `36px` and `32px`. An adversarial review then
  // reinstated the identical seam using 35px and a 28px icon button and the
  // suite stayed green. So do not look for values: assert that the band
  // declares NO size on anything that is a control, whatever the number.
  const CONTROL = /\.btn|\binput\b|\bselect\b|\btextarea\b|icon-btn|view-toggle|\.field/;
  const SIZING = /(?:^|;|\{)\s*(?:min-|max-)?(?:height|width)\s*:/;
  const offenders = [];
  for (const m of band.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const sel = m[1].trim(), body = m[2];
    if (!CONTROL.test(sel)) continue;
    if (SIZING.test(body)) offenders.push(`${sel.replace(/\s+/g, ' ').slice(0, 70)} -> ${body.trim().slice(0, 40)}`);
  }
  assert.deepEqual(offenders, [],
    `the laptop band may not size a control — that is what put a step at BOTH its edges:\n      ${offenders.join('\n      ')}`);

  // but the band survives for what it is actually for
  assert.match(band, /flex-wrap:\s*wrap/, 'it still wraps the toolbar');
  assert.match(band, /gap:\s*8px 12px/, 'and still gives the wrap real gaps');
  assert.match(band, /minmax\(150px, 1fr\)/, 'and still swaps rigid tracks for fluid ones');
});

check('control height comes from one token, and only the phone raises it', () => {
  const cl = read('claude-system.css');
  assert.match(cl, /--cl-ctl-lg:\s*40px/, 'the control token is 40px by default');
  const phones = mediaBlocks(cl, '@media (max-width: 640px)');
  assert.ok(phones.length >= 1, 'the phone blocks exist');
  assert.ok(phones.some((b) => /--cl-ctl-lg:\s*44px/.test(b)),
    `one of the ${phones.length} phone blocks raises it to the 44px touch target`);
  // A BASE declaration with a literal height is fine — every sheet layers on
  // the one before it. What may never come back is a VIEWPORT-SCOPED height
  // override, because that is precisely what produces a seam: the same control
  // rendering at two sizes depending on how wide the window happens to be.
  // The only sanctioned exception is the phone floor raising controls to 44px.
  const scopedOffenders = [];
  for (const { name, css } of sheets) {
    for (let at = css.indexOf('@media'); at !== -1; at = css.indexOf('@media', at + 1)) {
      const head = css.slice(at, css.indexOf('{', at));
      let depth = 0, end = at;
      for (let i = css.indexOf('{', at); i < css.length; i++) {
        if (css[i] === '{') depth++;
        else if (css[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
      }
      const body = css.slice(at, end);
      for (const m of body.matchAll(/\.btn[^{}]*\{[^}]*?\b(?:min-)?height:\s*(\d+)px/g)) {
        if (m[1] !== '44') scopedOffenders.push(`${name} ${head.trim()} -> ${m[0].trim().slice(0, 50)}`);
      }
    }
  }
  assert.deepEqual(scopedOffenders, [],
    `a viewport-scoped button height is a seam waiting to happen: ${scopedOffenders.join(' | ')}`);
});

/* ---------------------------------------------------------------------------
   Cards keep one rhythm without losing their separate identities.
   ------------------------------------------------------------------------ */
check('card padding resolves to the value the product actually uses', () => {
  // The first version asserted only the SHAPE (one value, not two), so
  // `padding: 3px` passed and every card in the product would have been
  // crushed. Resolve the winner and pin the VALUE.
  const decls = [];
  sheets.forEach(({ name, css }, sheetIndex) => {
    for (const m of css.matchAll(/([^{}]*\.card-pad[^{}]*)\{([^}]*)\}/g)) {
      const sel = m[1].trim(), body = m[2];
      const pad = body.match(/(?:^|;)\s*padding:\s*([^;]+)/);
      if (!pad) continue;
      decls.push({ name, sheetIndex, sel, value: pad[1].trim(),
        scoped: insideMedia(css, m.index) });
    }
  });
  const desktop = decls.filter((d) => !d.scoped);
  assert.ok(desktop.length >= 2, `.card-pad is declared in several sheets, found ${desktop.length}`);
  const winner = desktop[desktop.length - 1];
  assert.equal(winner.value, 'var(--cl-6)',
    `the winning card padding should be the spacing token, got "${winner.value}" from ${winner.name}`);
  const cl = read('claude-system.css');
  assert.match(cl, /--cl-6:\s*20px/, 'and --cl-6 is 20px');

  // every losing declaration must agree, so the answer never depends on which
  // sheet a reader happens to open
  for (const d of desktop) {
    assert.ok(/^(20px|var\(--cl-6\))$/.test(d.value),
      `${d.name} declares card padding "${d.value}" — every declaration must resolve to 20px`);
  }
});

check('distinct card types keep their own identity', () => {
  const all = sheets.map((s) => s.css).join('\n');
  // These are DIFFERENT surfaces and must not be flattened into one design.
  // Measured: generic card 20px / r14, KPI 16px / r14, pipeline card 14px / r10.
  for (const cls of ['.dash-kpi', '.pcard', '.login-card']) {
    assert.ok(all.includes(cls), `${cls} still exists as its own surface`);
  }
  assert.match(all, /\.pcard\s*\{[^}]*padding:\s*14px/,
    'the pipeline card keeps its tighter 14px padding');
});

/* ---------------------------------------------------------------------------
   UI Step 11 — sidebar wordmark keeps its two-line grid at <=1180px.

   The base rule (arabtec-design-system.css, outside any media query) sets
   `.side-txt { display: grid; }` so "Arabtec" stacks over "Recruitment Hub".
   A tablet-width band restores visibility after styles.css's old icon-rail
   design hid the text, but an earlier version of that restore flattened
   `.side-txt` into the same `display: block` used for `.nav-section` and the
   nav-item span — collapsing the grid and running the two lines together
   with a 0px gap ("ArabtecRECRUITMENT HUB"). Assert the exact selector-to-
   declaration mapping, not just that the string "grid" appears somewhere.
   ------------------------------------------------------------------------ */
check('sidebar wordmark keeps display:grid inside the 1180px restore band', () => {
  const ds = read('arabtec-design-system.css');
  const bands = mediaBlocks(ds, '@media (max-width: 1180px)');
  const band = bands.find((b) => /\.side-txt/.test(b));
  assert.ok(band, 'a 1180px band still touches .side-txt');

  // Parse every `selector-list { body }` in the band and find the one whose
  // selector list contains `.sidebar .side-txt` as its OWN entry — not
  // folded into a comma group with other selectors that share a different
  // intended display. Strip comments and the band's own leading `@media
  // (...) {` first — otherwise the naive brace-pairing below mistakes the
  // `@media` head for a selector, and any comment sitting right before a
  // real rule gets glommed into that rule's "selector" text.
  const cleanBand = band
    .replace(/^@media[^{]*\{/, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...cleanBand.matchAll(/([^{}]+)\{([^}]*)\}/g)].map((m) => ({
    selectors: m[1].replace(/\s+/g, ' ').trim().split(',').map((s) => s.trim()),
    body: m[2],
  }));
  const sideTxtRule = rules.find((r) => r.selectors.includes('.sidebar .side-txt'));
  assert.ok(sideTxtRule, '.sidebar .side-txt has its own entry in a selector list here');
  assert.match(sideTxtRule.body, /display:\s*grid/,
    `.side-txt must resolve to display: grid in this band, got "${sideTxtRule.body.trim()}"`);

  // And it must not ALSO still be grouped into a shared display:block rule
  // with .nav-section / the nav-item span — that grouping is the regression.
  const stillFlattened = rules.some((r) =>
    r.selectors.includes('.sidebar .side-txt') && /display:\s*block/.test(r.body));
  assert.ok(!stillFlattened,
    '.side-txt must not share a flat display:block declaration with nav-section/nav-item span');
});

/* ---------------------------------------------------------------------------
   UI Step 11 — KPI row rhythm matches the rest of the card system.

   arabtec-design-system.css already puts `.dash-kpi-row` gap and `.dash-kpi`
   padding on the approved 16px/20px rhythm, but claude-system.css loads
   after it and was still pinning both back to the old 12px/16px pair
   (--cl-4/--cl-5), so the KPI row sat on a different rhythm than the
   dash-grid-2 cards directly below it. Resolve the actual cascade winner
   (last non-media declaration, in sheet load order) and pin its value —
   mirroring the .card-pad check above, which caught the same class of bug.
   ------------------------------------------------------------------------ */
check('KPI row gap and card inset resolve to the shared 16px/20px card rhythm', () => {
  function resolve(exactSelector, prop) {
    const decls = [];
    sheets.forEach(({ name, css: sheetCss }) => {
      // Strip comments before matching, and keep using this same stripped
      // text (not the original) for insideMedia so offsets line up — a
      // comment sitting right before a rule otherwise gets glommed into
      // that rule's "selector" capture and the exact-match below misses it.
      const clean = sheetCss.replace(/\/\*[\s\S]*?\*\//g, (c) => ' '.repeat(c.length));
      for (const m of clean.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
        const parts = m[1].replace(/\s+/g, ' ').trim().split(',').map((s) => s.trim());
        if (!parts.includes(exactSelector)) continue;
        const pm = m[2].match(new RegExp(`(?:^|;)\\s*${prop}:\\s*([^;]+)`));
        if (!pm) continue;
        decls.push({ name, value: pm[1].trim(), scoped: insideMedia(clean, m.index) });
      }
    });
    return decls.filter((d) => !d.scoped);
  }

  const rowGap = resolve('.dash-kpi-row', 'gap');
  assert.ok(rowGap.length >= 1, '.dash-kpi-row declares a gap in at least one sheet');
  const rowGapWinner = rowGap[rowGap.length - 1];
  assert.equal(rowGapWinner.value, 'var(--cl-5)',
    `the winning .dash-kpi-row gap should be the 16px token, got "${rowGapWinner.value}" from ${rowGapWinner.name}`);

  const cardPad = resolve('.dash-kpi', 'padding');
  assert.ok(cardPad.length >= 1, '.dash-kpi declares a padding in at least one sheet');
  const cardPadWinner = cardPad[cardPad.length - 1];
  assert.equal(cardPadWinner.value, 'var(--cl-6)',
    `the winning .dash-kpi padding should be the 20px token, got "${cardPadWinner.value}" from ${cardPadWinner.name}`);

  const cl = read('claude-system.css');
  assert.match(cl, /--cl-5:\s*16px/, 'and --cl-5 is 16px');
  assert.match(cl, /--cl-6:\s*20px/, 'and --cl-6 is 20px');
});

/* ---------------------------------------------------------------------------
   Containers.
   ------------------------------------------------------------------------ */
check('page gutters only ever shrink as the viewport shrinks', () => {
  const cl = read('claude-system.css');
  // Measured: 24/32 desktop, 24 laptop, 20/16 tablet, 16/16 phone.
  assert.match(cl, /--sp-page-x:\s*var\(--sp-6\)/, 'desktop gutter is the largest step');
  assert.match(cl, /\.content \{ padding: var\(--sp-page-y\) var\(--sp-page-x\); \}/,
    'and .content takes its gutters from the tokens');
});

check('the min-width:0 floor is declared for the containers that need it', () => {
  const cl = read('claude-system.css');
  assert.match(cl, /\.shell > \.main, \.shell > \.content, \.main, \.content \{ min-width: 0; \}/,
    'the shell axes carry the floor');
  assert.match(cl, /\.card, \.card-pad, \.toolbar, \.filter-toolbar, \.page-head, \.form-grid, \.field \{ min-width: 0; \}/,
    'and so do the containers that hold free text');
});

check('local overflow ownership is unchanged and the page still never scrolls', () => {
  const cl = read('claude-system.css');
  const ds = read('arabtec-design-system.css');
  assert.match(cl, /\.table-wrap[^{]*\{[^}]*overflow-x:\s*auto/,
    'the table wrapper still owns its horizontal overflow');
  assert.match(ds, /html, body \{ max-width: 100%; overflow-x: hidden; \}/,
    'the global masking is left in place — dependent areas are not yet proven safe');
});

console.log(`\n=== UI LAYOUT CONTAINERS: ${passed} passed, ${failed} failed ===`);
if (failed) process.exit(1);
