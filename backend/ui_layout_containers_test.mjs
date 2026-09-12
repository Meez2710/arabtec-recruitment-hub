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

let passed = 0, failed = 0;
function check(name, run) {
  try { run(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n      ${e.message}`); }
}

/* ---------------------------------------------------------------------------
   The laptop band no longer steps control height.
   ------------------------------------------------------------------------ */
check('the laptop band sets no control height at either of its edges', () => {
  const resp = read('arabtec-responsive.css');
  const bands = mediaBlocks(resp, '@media (min-width: 1024px) and (max-width: 1440px)');
  assert.equal(bands.length, 1, 'exactly one laptop band');
  const band = bands[0];
  // It used to pin 36px/32px here, which put a step at BOTH edges — 1441 -> 40,
  // 1440 -> 36, and 1024 -> 36, 1023 -> 40. Controls were smallest in the
  // MIDDLE of the range, so a 1023px tablet got larger controls than a 1280px
  // laptop. A control may never shrink as the viewport does.
  assert.equal(/min-height:\s*36px/.test(band), false, 'no 36px control height');
  assert.equal(/height:\s*32px/.test(band), false, 'no 32px compact height');
  assert.equal(/\.icon-btn\s*\{\s*width:\s*32px/.test(band), false, 'no 32px icon button');
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
check('card padding resolves to one value, not three', () => {
  // `.card-pad` is declared in three sheets. The resolved value was already
  // 20px, but styles.css said `20px 22px` — the only asymmetric card padding in
  // the system — so the answer depended on which sheet you read.
  const decls = sheets.flatMap(({ name, css }) =>
    [...css.matchAll(/\.card-pad[^{}]*\{([^}]*)\}/g)]
      .map((m) => ({ name, body: m[1] })))
    .filter((d) => /padding:/.test(d.body));
  assert.ok(decls.length >= 2, `.card-pad is declared in several sheets, found ${decls.length}`);
  for (const d of decls) {
    const pad = d.body.match(/padding:\s*([^;]+)/)[1].trim();
    const parts = pad.split(/\s+/);
    assert.ok(parts.length === 1,
      `${d.name} declares an asymmetric card padding "${pad}" — card padding is one value`);
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
