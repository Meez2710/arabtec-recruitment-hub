// Structural contract for the form controls — buttons, inputs, selects and
// textareas (section 20 of claude-system.css, and the one focus rule in
// arabtec-design-system.css).
//
// These checks do NOT prove pixel geometry — this process lays out no document.
// Real rendered geometry was verified in a browser against all five production
// stylesheets, with the real markup from app.jsx, at 1440, 1366, 1280, 1200,
// 1024, 768, 430, 390 and 360. Every button variant and every input context was
// driven through hover, focus, focus-visible, active and disabled and
// re-measured along with its next sibling. What is asserted here is the
// structure and the CSS contract that produced those numbers, so the measured
// result cannot be silently undone.
//
// WHAT WAS MEASURED CLEAN AND IS ONLY GUARDED FROM HERE ON:
//   no state changes any control's box, at any of the nine widths — width,
//   height, padding, border-width, font-size, font-weight and gap identical in
//   every state, and no neighbour moved. `:active`'s `transform:
//   translateY(.5px)` is the one thing that does move, and it moves only the
//   painted pixels: dw 0.000, dh 0.000, neighbour dx/dy 0.000. Kept.
//
// THE FOUR DEFECTS THIS SUITE GUARDS, all measured before the fix:
//   .btn.small               32px tall on `7px 13px` — the only button in the
//                            product with VERTICAL padding, and a third
//                            horizontal value against the compact 12px
//   .anyhelp-empty select    38px at 360 and 390 (under the 44px touch floor)
//                            on a 999px pill radius, while every other select
//                            is on 8px
//   .anyhelp-composer textarea  a 12px radius, the only value in the product
//                            off the 4/6/8/10/14/18/22/26 ramp
//   :focus-visible           four conflicting declarations. A `.btn` resolved
//                            to an outline AND a 3px halo — two rings. Every
//                            `.field`/`.toolbar` input, select and textarea
//                            resolved to `outline-style: none`, because
//                            `.field input:focus { outline: none }` is (0,2,1)
//                            and the rule meant to restore it,
//                            `input:focus-visible`, is (0,1,1) — leaving a
//                            #E6F4F0 halo on white, about 1.1:1.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const publicDir = fileURLToPath(new URL('../frontend/public/', import.meta.url));
const read = (f) => fs.readFileSync(publicDir + f, 'utf8');

// The five sheets in the order index.html loads them. Cascade order matters for
// every assertion below.
const SHEETS = ['styles.css', 'arabtec-approved-ui.css', 'arabtec-design-system.css',
  'claude-system.css', 'arabtec-responsive.css'];
const claude = read('claude-system.css');
const app = read('app.jsx');
// Slice from the OPENING of the banner comment, not from the marker inside it,
// so that stripping comments below really removes the prose.
const section = claude.slice(claude.lastIndexOf('/*', claude.indexOf('20. FORM CONTROLS')));

/* --------------------------------------------------------------------------
   A minimal CSS reader. Walks braces so rules nested in @media are seen too,
   and returns every rule in document order, per sheet, in LOAD order.
   -------------------------------------------------------------------------- */
function rules(css, sheet) {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  let depth = 0, start = 0, selStart = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '{') { if (depth === 0) start = i; depth++; }
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        const sel = src.slice(selStart, start).trim();
        const body = src.slice(start + 1, i);
        if (sel.startsWith('@')) { for (const r of rules(body, sheet)) out.push({ ...r, media: r.media || sel }); }
        else if (sel) out.push({ sel, body, media: '', sheet });
        selStart = i + 1;
      }
    }
  }
  return out;
}
// order = position in the whole cascade, which is sheet order then source order.
const ALL = SHEETS.flatMap((f) => rules(read(f), f)).map((r, i) => ({ ...r, order: i }));

const decls = (body) => [...body.matchAll(/([-a-z]+)\s*:\s*([^;]+)/g)]
  .map((m) => [m[1].trim(), m[2].trim()]);

/* ===========================================================================
   A REAL LITTLE CASCADE

   The badge/chip suite compares "the last declared value in load order". That
   is right for the selectors it deals with, which are all single classes of
   equal weight. It is WRONG here, and wrongly reassuring: the compact button's
   real height comes from `.btn.btn-sm` (0,2,0) in the geometry layer, while
   `.btn-sm` (0,1,0) is declared three more times AFTER it in earlier sheets and
   twice with a different number. A "last wins" reader would report 34px for a
   button that renders 32px.

   So this resolver does what a browser does, for the selector shapes these five
   sheets actually use: descendant combinators over compounds of a tag, classes
   and pseudo-classes. Specificity first, source order second. Anything it
   cannot parse is recorded in SKIPPED, and a meta-check below asserts that
   nothing in the control family ended up there.
   ======================================================================== */
const SKIPPED = [];
const UNSUPPORTED = /[>+~*]|::|:has\(|:nth|:is\(|:where\(/;

// Two spellings that carry ordinary weight and must not be dropped:
// `.btn[disabled]` is the attribute form of `.btn:disabled`, and the long
// `input[type=...]` list in section 7 of claude-system.css IS the shared input
// geometry rule — losing it would leave every input resolving from the wrong
// sheet. `input:not([type])` is the bare-input arm of that same list.
const normalise = (sel) => sel.replace(/\[disabled\]/g, ':disabled')
  .replace(/:not\(\[type\]\)/g, '[type=__none__]');

function parseCompound(text) {
  const attrs = [];
  const bare = text.replace(/\[([-\w]+)\s*=\s*"?([-\w]+)"?\]/g, (_, k, v) => {
    attrs.push([k, v]); return '';
  });
  if (/[[\]]/.test(bare)) return null;
  const m = bare.match(/^([a-z][a-z0-9]*)?((?:[.:][-\w]+)*)$/i);
  if (!m) return null;
  const tag = m[1] || null;
  const cls = [], pseudo = [];
  for (const tok of (m[2] || '').match(/[.:][-\w]+/g) || []) {
    if (tok[0] === '.') cls.push(tok.slice(1)); else pseudo.push(tok.slice(1));
  }
  return { tag, cls, pseudo, attrs };
}

function parseSelector(sel) {
  if (UNSUPPORTED.test(sel)) return null;
  const parts = sel.trim().split(/\s+/).map(parseCompound);
  return parts.every(Boolean) ? parts : null;
}

const specificity = (parts) => {
  let a = 0, b = 0;
  for (const p of parts) { a += p.cls.length + p.pseudo.length + p.attrs.length; b += p.tag ? 1 : 0; }
  return a * 1000 + b;                     // no ids anywhere in these sheets
};

// A probe is an ancestor chain: [{tag, cls}, ..., {tag, cls}] outermost first.
function compoundMatches(part, node, states) {
  if (part.tag && part.tag !== node.tag) return false;
  if (!part.cls.every((c) => node.cls.includes(c))) return false;
  for (const [k, v] of part.attrs || []) {
    const has = node.attrs && node.attrs[k] !== undefined;
    if (v === '__none__') { if (has) return false; }   // the :not([type]) arm
    else if (!has || node.attrs[k] !== v) return false;
  }
  return part.pseudo.every((p) => states.includes(p));
}
function selectorMatches(parts, probe, states) {
  // last compound must match the element itself; the rest match ancestors, in
  // order, as a subsequence.
  if (!compoundMatches(parts[parts.length - 1], probe[probe.length - 1], states)) return false;
  let i = probe.length - 2;
  for (let j = parts.length - 2; j >= 0; j--) {
    while (i >= 0 && !compoundMatches(parts[j], probe[i], [])) i--;
    if (i < 0) return false;
    i--;
  }
  return true;
}

// Only the two width forms these sheets use.
function mediaApplies(media, width) {
  if (!media) return true;
  if (/prefers-reduced-motion|print|hover:/.test(media)) return false;
  let ok = true;
  for (const m of media.matchAll(/\((min|max)-width:\s*([\d.]+)px\)/g)) {
    if (m[1] === 'min') ok = ok && width >= Number(m[2]);
    else ok = ok && width <= Number(m[2]);
  }
  return ok;
}

/* Resolve one property for one probe, in one state set, at one viewport. */
function resolve(probe, prop, { states = [], width = 1441 } = {}) {
  let best = null;
  for (const r of ALL) {
    if (!mediaApplies(r.media, width)) continue;
    let value = null;
    for (const [p, v] of decls(r.body)) if (p === prop) value = v;
    if (value === null) continue;
    for (const raw of r.sel.split(',')) {
      const sel = normalise(raw.trim());
      if (!sel) continue;
      const parts = parseSelector(sel);
      if (!parts) { SKIPPED.push({ sel, sheet: r.sheet, prop }); continue; }
      if (!selectorMatches(parts, probe, states)) continue;
      const spec = specificity(parts);
      if (!best || spec > best.spec || (spec === best.spec && r.order >= best.order)) {
        best = { value, spec, order: r.order, sheet: r.sheet, sel, media: r.media };
      }
    }
  }
  return best;
}

// The five properties that decide whether two controls share a box, plus the
// two that a state must never touch.
const BOX = ['min-height', 'padding', 'border-radius', 'border-width', 'font-size', 'font-weight', 'gap'];
// `padding` is a shorthand; these sheets also use the longhands.
function boxOf(probe, opt) {
  const o = {};
  for (const p of [...BOX, 'padding-left', 'padding-right', 'padding-top', 'padding-bottom', 'height', 'border']) {
    const r = resolve(probe, p, opt);
    if (r) o[p] = r.value;
  }
  return o;
}

const el = (tag, ...cls) => ({ tag, cls, attrs: {} });
const typed = (t) => ({ tag: 'input', cls: [], attrs: { type: t } });
const btn = (...cls) => [el('div', 'card-pad'), el('button', 'btn', ...cls)];

let passed = 0, failed = 0;
function check(name, run) {
  try { run(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n      ${e.message}`); }
}

/* ===========================================================================
   0. THE RESOLVER IS WORTH TRUSTING
   ======================================================================== */

check('the resolver reproduces the two numbers a "last declared wins" reader gets wrong', () => {
  // Browser-measured at 1441+: the compact button is 32px on `0 12px`, and it
  // is `.btn.btn-sm` in claude-system.css that says so — even though `.btn-sm`
  // is declared later in earlier sheets, twice, with 30px and 34px.
  const sm = resolve(btn('btn-sm'), 'min-height', { width: 1441 });
  assert.equal(sm.value, 'var(--cl-ctl-sm)',
    `.btn.btn-sm resolves its height in the geometry layer (got ${sm.value} from ${sm.sheet} via ${sm.sel})`);
  assert.equal(sm.sheet, 'claude-system.css');
  // And the losing declarations really are present, or this check proves nothing.
  const losers = ALL.filter((r) => r.sel.split(',').some((p) => p.trim() === '.btn-sm')
    && /min-height/.test(r.body));
  assert.ok(losers.length >= 2,
    `the lower-specificity .btn-sm heights are still in the sheets (found ${losers.length})`);
  assert.ok(losers.some((r) => /34px|30px/.test(r.body)),
    'including one that a naive reader would have reported');
});

check('the resolver skipped nothing that belongs to the control family', () => {
  // Honesty check on the parser: a selector it cannot read is a selector whose
  // declaration silently never enters the comparison.
  const family = SKIPPED.filter((s) => /\.btn|\binput\b|\bselect\b|\btextarea\b|icon-btn/.test(s.sel));
  const unique = [...new Set(family.map((s) => s.sel))];
  // The ask-bar scope is built on `:has()` and `+`, which is exactly what this
  // parser does not read — so it is named here rather than pretended away.
  const known = unique.filter((s) => /:has\(|\+ \.ask-bar|~ \*|\.tp-/.test(s));
  assert.deepEqual(unique.filter((s) => !known.includes(s)), [],
    'every unparsed control selector is one of the documented scoped forms');
});

/* ===========================================================================
   1. THE GEOMETRY LAYER STAYS A GEOMETRY LAYER
   ======================================================================== */

// The prose in this section quotes the colours and sizes it is explaining, so
// the purity checks look at the DECLARATIONS, with comments stripped.
const sectionCode = section.replace(/\/\*[\s\S]*?\*\//g, '');

check('section 20 exists and introduces no colour, background or typeface', () => {
  assert.ok(claude.includes('20. FORM CONTROLS'), 'claude-system.css carries section 20');
  assert.ok(sectionCode.includes('.anyhelp-empty select'), 'and the stripped code is not empty');
  assert.equal(/#[0-9a-fA-F]{3,8}\b|rgb\(|hsl\(|oklch\(/.test(sectionCode), false, 'no colour literal');
  assert.equal(/font-family/.test(sectionCode), false, 'no typeface');
  assert.equal(/background\s*:/.test(sectionCode), false, 'no background literal');
  assert.equal(/!important/.test(sectionCode), false, 'no !important');
});

check('section 20 changes no rendered font size', () => {
  // Rule (6) of the layout integrity contract. The composer picker and
  // `.btn.small` both keep the font size they had; only their boxes moved.
  assert.equal(/font-size/.test(sectionCode), false,
    'section 20 must not change any rendered font size');
});

check('the outline COLOUR is not declared in the geometry layer', () => {
  // The same split the border already has: width and style here, colour in the
  // design system.
  assert.match(sectionCode, /outline-style:\s*solid/, 'the geometry layer owns the ring style');
  assert.match(sectionCode, /outline-width:\s*2px/, 'and its width');
  assert.equal(/outline-color/.test(sectionCode), false, 'and never its colour');
});

/* ===========================================================================
   2. ONE DEFAULT BOX, ONE COMPACT BOX
   ======================================================================== */

const DEFAULT_VARIANTS = ['', 'btn-secondary', 'btn-ghost', 'btn-danger', 'btn-danger-solid',
  'btn-success', 'btn-navy', 'btn-outline-blue', 'btn-primary-solid', 'btn-block'];
const COMPACT_VARIANTS = ['btn-sm', 'btn-xs', 'small'];

check('every default button variant resolves to the same box', () => {
  // Browser-measured at 1441+: 40px tall, `0 16px`, 8px radius, 1px border,
  // 14px / 500, 6px gap — identical for all ten. `.btn-block` differs in WIDTH
  // by design (100%), which is not part of this comparison.
  const base = boxOf(btn(), { width: 1441 });
  for (const v of DEFAULT_VARIANTS.filter(Boolean)) {
    const b = boxOf(btn(v), { width: 1441 });
    for (const p of BOX) {
      assert.equal(b[p], base[p], `.${v} resolves ${p}: ${b[p]} against ${base[p]} on .btn`);
    }
  }
});

check('every compact button variant resolves to the same box', () => {
  // `.btn.small` is the one that did not: `7px 13px`, vertical padding and all,
  // because the compact rule in section 6 lists `.btn.btn-sm` and `.btn.btn-xs`
  // but not `.btn.small`. Section 20 pins its padding.
  const base = boxOf(btn('btn-sm'), { width: 1441 });
  for (const v of COMPACT_VARIANTS.filter((x) => x !== 'btn-sm')) {
    const b = boxOf(btn(v), { width: 1441 });
    for (const p of ['min-height', 'padding', 'border-radius', 'border-width', 'gap',
      'padding-left', 'padding-right', 'padding-top', 'padding-bottom']) {
      assert.equal(b[p], base[p], `.${v} resolves ${p}: ${b[p]} against ${base[p]} on .btn-sm`);
    }
  }
});

check('a compact button carries no vertical padding', () => {
  // The specific shape of the .btn.small defect: a min-height control with
  // vertical padding is a box whose height depends on its font, which is the
  // mechanism section 14 rule (6) exists to forbid.
  for (const v of COMPACT_VARIANTS) {
    const p = resolve(btn(v), 'padding', { width: 1441 });
    assert.ok(p, `.${v} declares a padding`);
    assert.match(p.value, /^0\s/, `.${v} padding starts at 0 vertical (got ${p.value})`);
  }
});

/* ===========================================================================
   3. NO STATE MAY CHANGE A CONTROL'S BOX
   ======================================================================== */

const CONTROLS = [
  ['.btn', btn()],
  ['.btn-secondary', btn('btn-secondary')],
  ['.btn-ghost', btn('btn-ghost')],
  ['.btn-danger', btn('btn-danger')],
  ['.btn-danger-solid', btn('btn-danger-solid')],
  ['.btn-success', btn('btn-success')],
  ['.btn-sm', btn('btn-sm')],
  ['.btn-ghost.btn-sm', btn('btn-ghost', 'btn-sm')],
  ['.icon-btn', [el('div', 'modal-head'), el('button', 'icon-btn')]],
  ['.field input', [el('div', 'field'), el('input')]],
  ['.field select', [el('div', 'field'), el('select')]],
  ['.field textarea', [el('div', 'field'), el('textarea')]],
  ['.toolbar input', [el('div', 'toolbar'), el('input')]],
  ['.toolbar select', [el('div', 'toolbar'), el('select')]],
  ['.anyhelp-composer textarea', [el('form', 'anyhelp-composer'), el('textarea')]],
  ['.anyhelp-empty select', [el('div', 'anyhelp-empty'), el('select')]],
  ['.modal-foot .btn', [el('div', 'modal-foot'), el('button', 'btn')]],
];
const STATES = [['hover'], ['focus'], ['focus-visible'], ['focus', 'focus-visible'],
  ['active'], ['disabled']];

check('no hover, focus, active or disabled state resolves to a different box', () => {
  // Emphasis is colour, background and OUTLINE. An outline is painted outside
  // the border box and reserves nothing, which is why it is not in this list;
  // a border's WIDTH is, because half of a border is geometry.
  const offenders = [];
  for (const [name, probe] of CONTROLS) {
    for (const width of [1441, 1200, 390]) {
      const base = boxOf(probe, { width });
      for (const states of STATES) {
        const s = boxOf(probe, { states, width });
        for (const p of [...BOX, 'padding-left', 'padding-right', 'padding-top',
          'padding-bottom', 'height', 'border']) {
          if (s[p] !== base[p]) {
            offenders.push(`${name}:${states.join(':')} @${width} resolves ${p}: ${s[p]} against ${base[p]}`);
          }
        }
      }
    }
  }
  assert.deepEqual(offenders, [], 'a state must keep the control\'s resting box');
});

check('the state sweep really reached the state rules', () => {
  // The guard is only worth having if it looked at anything. Count the rules in
  // the five sheets that carry both a control base and a state token.
  const STATE_TOK = /(:hover|:focus(-visible)?|:active|:disabled|\[disabled\])(?![-\w])/;
  const seen = ALL.filter((r) => r.sel.split(',').some((p) =>
    STATE_TOK.test(p) && /\.btn|\.icon-btn|\binput\b|\bselect\b|\btextarea\b/.test(p)));
  assert.ok(seen.length >= 20,
    `the control family really does declare states in these sheets (found ${seen.length})`);
  // And that at least one of them declares a LAYOUT property, so the comparison
  // above is doing work rather than trivially passing on empty rules.
  assert.ok(seen.some((r) => decls(r.body).some(([p]) => /^(padding|border|font|min-height)/.test(p))),
    'at least one state rule declares a layout property to be checked against its base');
});

/* ===========================================================================
   4. ONE FOCUS TREATMENT
   ======================================================================== */

check('every control resolves the same focus ring, and none resolves to none', () => {
  // What actually won before: `.btn` got an outline AND a 3px halo; every
  // `.field`/`.toolbar` control got `outline-style: none` from
  // `.field input:focus { outline: none }` at (0,2,1), which the (0,1,1)
  // `input:focus-visible` could not beat.
  const FV = { states: ['focus', 'focus-visible'], width: 1441 };
  for (const [name, probe] of CONTROLS) {
    const style = resolve(probe, 'outline-style', FV) || resolve(probe, 'outline', FV);
    assert.ok(style, `${name} resolves a focus outline`);
    assert.equal(/\bnone\b/.test(style.value), false,
      `${name} must not resolve its focus outline to none (got ${style.value} from ${style.sheet})`);
    const width = resolve(probe, 'outline-width', FV) || resolve(probe, 'outline', FV);
    assert.match(width.value, /\b2px\b/, `${name} focus ring is 2px (got ${width.value})`);
    const off = resolve(probe, 'outline-offset', FV);
    assert.ok(off && off.value === '2px', `${name} focus ring sits at 2px offset (got ${off && off.value})`);
  }
});

check('the focus ring is ONE ring, not an outline plus a halo', () => {
  // The test is not "there is no shadow" — it is "focus does not ADD one".
  // `.icon-btn` never had a focus shadow and resolves none at all, which is the
  // same answer, reached differently.
  const FV = { states: ['focus', 'focus-visible'], width: 1441 };
  for (const [name, probe] of CONTROLS) {
    const rest = resolve(probe, 'box-shadow', { width: 1441 });
    const sh = resolve(probe, 'box-shadow', FV);
    const restVal = rest ? rest.value : 'none';
    const fvVal = sh ? sh.value : 'none';
    assert.equal(fvVal === 'none' || fvVal === restVal, true,
      `${name} adds a second ring on focus: ${fvVal} against ${restVal} at rest (${sh && sh.sheet})`);
  }
});

check('the design system owns the focus colour and names the scoped forms', () => {
  const ds = read('arabtec-design-system.css');
  const rule = ds.slice(ds.indexOf('.btn:focus-visible, .login-card .btn:focus-visible'));
  assert.ok(rule.startsWith('.btn:focus-visible'), 'the one focus rule is where it says it is');
  for (const sel of ['.field input:focus-visible', '.field select:focus-visible',
    '.field textarea:focus-visible', '.toolbar input:focus-visible',
    '.toolbar select:focus-visible', '.login-card .btn:focus-visible']) {
    assert.ok(rule.slice(0, rule.indexOf('{')).includes(sel),
      `${sel} is spelled out, so it matches the (0,2,1) \`outline: none\` it has to beat`);
  }
  assert.match(rule.slice(0, rule.indexOf('}') + 1), /outline:\s*2px solid var\(--at-action\)/,
    'and it carries the colour');
});

/* ===========================================================================
   5. ONE DISABLED VALUE
   ======================================================================== */

check('every disabled button rule declares the same opacity', () => {
  // Three values used to be in the sheets — .45, .5 and .55 — so the resolved
  // one depended on which sheet you happened to read.
  const found = [];
  for (const r of ALL) {
    if (!r.sel.split(',').some((p) => /\.btn/.test(p) && /:disabled|\[disabled\]/.test(p))) continue;
    for (const [p, v] of decls(r.body)) if (p === 'opacity') found.push({ v, sheet: r.sheet, sel: r.sel });
  }
  assert.ok(found.length >= 3, `all the disabled-button rules are still present (found ${found.length})`);
  const values = [...new Set(found.map((f) => f.v))];
  assert.deepEqual(values, ['.45'],
    `one disabled opacity across the product (found ${found.map((f) => f.v + ' in ' + f.sheet).join(', ')})`);
});

check('a disabled control changes nothing but its opacity and cursor', () => {
  for (const r of ALL) {
    if (!r.sel.split(',').some((p) => /:disabled|\[disabled\]/.test(p))) continue;
    for (const [p] of decls(r.body)) {
      assert.equal(/^(padding|margin|min-height|height|width|font-size|font-weight|border-width|gap)/.test(p), false,
        `${r.sel} (${r.sheet}) declares ${p} on a disabled state`);
    }
  }
});

/* ===========================================================================
   6. THE INVARIANTS THIS STEP WAS NOT ALLOWED TO MOVE
   ======================================================================== */

check('the 44px mobile touch floor is intact, and now reaches the composer picker', () => {
  // Browser-measured at 360 and 390: every control in the harness is >= 44px
  // except `.decision-select`, which belongs to the review table and is
  // deliberately out of this step's scope.
  assert.match(claude, /@media \(max-width: 640px\) \{\s*\n\s*:root \{ --cl-ctl-lg: 44px; \}/,
    'the geometry layer still steps the control token to 44px below 640');
  // `.btn.small` is in this list because pinning its compact height is exactly
  // the kind of change that can outrank the floor: declared after the 640px
  // block instead of before it, it measured 32px at 360, 390 and 430.
  for (const probe of [btn(), btn('btn-sm'), btn('btn-xs'), btn('small'),
    [el('div', 'field'), el('input')],
    [el('div', 'toolbar'), el('select')],
    [el('div', 'anyhelp-empty'), el('select')]]) {
    const h = resolve(probe, 'min-height', { width: 390 });
    assert.ok(h && /44px|--cl-ctl-lg/.test(h.value),
      `a control resolves to the touch floor at 390 (got ${h && h.value} from ${h && h.sheet})`);
  }
  // The picker inherits the token rather than restating a number, which is what
  // makes the floor reach it at all.
  assert.match(section, /\.anyhelp-empty select \{[^}]*min-height:\s*var\(--cl-ctl-lg\)/,
    '.anyhelp-empty select takes its height from the token');
});

check('control height is monotonic — no step at either edge of the laptop band', () => {
  // Step 8 closed this. The band used to set .btn / .toolbar input to 36px and
  // .icon-btn to 32x32 across 1024-1440 ONLY, which put a step at BOTH edges:
  //   1441 -> 40px, 1440 -> 36px   and   1024 -> 36px, 1023 -> 40px
  // Controls were smallest in the MIDDLE of the range and grew towards both
  // ends, so a tablet at 1023px got larger controls than a laptop at 1280px.
  // A control must never shrink as the viewport does — it is walking towards
  // the 44px touch target, not away from it.
  const widths = [1600, 1441, 1440, 1366, 1280, 1200, 1024, 1023, 768];
  const heights = widths.map((width) => ({
    width, h: resolve(btn(), 'min-height', { width }).value,
  }));
  const distinct = [...new Set(heights.map((x) => x.h))];
  assert.equal(distinct.length, 1,
    `every width from 641 up must resolve to ONE control height, got ${JSON.stringify(heights)}`);

  // It resolves to the token, not a literal — which is the point: one source of
  // truth. The step that used to exist was a literal 36px overriding it.
  assert.match(distinct[0], /var\(--cl-ctl-lg\)/,
    `and it must be the control token, got ${distinct[0]}`);

  // The phone floor works by REDEFINING that token, so source-level resolution
  // sees the same declaration at 390 — the change is in the custom property.
  // Both values are pinned here; the rendered pixels (40 above 640, 44 below)
  // were measured in a browser at 1600/1441/1440/1280/1024/1023/768/390/360.
  const cl = read('claude-system.css');
  assert.match(cl, /--cl-ctl-lg:\s*40px/, 'the control token is 40px by default');
  // claude-system.css has THREE `@media (max-width: 640px)` blocks, so search
  // all of them rather than assuming the first — the redefinition lives in the
  // second. (Two earlier attempts here failed on exactly that assumption: a
  // fixed character window, then the first block only.)
  const phoneBlocks = [];
  for (let at = cl.indexOf('@media (max-width: 640px)'); at !== -1;
       at = cl.indexOf('@media (max-width: 640px)', at + 1)) {
    let depth = 0, end = at;
    for (let i = cl.indexOf('{', at); i < cl.length; i++) {
      if (cl[i] === '{') depth++;
      else if (cl[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    phoneBlocks.push(cl.slice(at, end));
  }
  assert.ok(phoneBlocks.length >= 1, 'at least one phone block exists');
  assert.ok(phoneBlocks.some((b) => /--cl-ctl-lg:\s*44px/.test(b)),
    `one of the ${phoneBlocks.length} phone blocks must raise the control token to 44px`);

  // the band itself survives — only the heights left it
  const resp = read('arabtec-responsive.css');
  assert.match(resp, /@media \(min-width: 1024px\) and \(max-width: 1440px\)/,
    'the laptop band still exists for its wrap/gap/fluid-grid rules');
  const band = resp.slice(resp.indexOf('@media (min-width: 1024px) and (max-width: 1440px)'));
  const bandEnd = band.indexOf('\n}');
  const body = band.slice(0, bandEnd);
  assert.equal(/min-height:\s*36px/.test(body), false,
    'and no longer overrides control height');
  assert.match(body, /flex-wrap:\s*wrap/,
    'while keeping the wrapping it exists for');
});

check('.ask-input keeps the min-width release that makes it usable on a phone', () => {
  // `arabtec-approved-ui.css` sets `min-width: 260px`; `arabtec-responsive.css`
  // releases it. Measured computed `min-width: 0px` and a 336px rendered width
  // at 390 — the release IS live, because PageHead renders `.page-head`
  // immediately followed by `.toolbar.ask-bar`. Not a defect; guarded so the
  // release is not removed as dead.
  const resp = read('arabtec-responsive.css');
  assert.match(resp, /\.page-head:has\(\+ \.ask-bar\) \+ \.ask-bar \.ask-input,[\s\S]{0,80}min-width:\s*0/,
    'the release selector is still there');
  // PageHead's `actions` prop is a long JSX block, so the anchor is the close
  // of the element, not a character budget.
  const i = app.indexOf('<div className="toolbar ask-bar">');
  assert.ok(i > 0, 'the ask bar is still rendered');
  const before = app.slice(0, i);
  assert.match(before.slice(-4000), /<PageHead[\s\S]*\/>\s*$/,
    'and it is still the element immediately after the PageHead, which is what the :has() release matches');
});

check('the pill radius is gone from the selects and the ramp is respected', () => {
  // `.anyhelp-empty select` was the last 999px control outside the count pills.
  for (const [name, probe] of [
    ['.anyhelp-empty select', [el('div', 'anyhelp-empty'), el('select')]],
    ['.anyhelp-composer textarea', [el('form', 'anyhelp-composer'), el('textarea')]],
    ['.field select', [el('div', 'field'), el('select')]],
    ['.field textarea', [el('div', 'field'), el('textarea')]]]) {
    const r = resolve(probe, 'border-radius', { width: 1441 });
    assert.ok(r && r.value === 'var(--cl-r-md)',
      `${name} sits on the 8px step of the ramp (got ${r && r.value} from ${r && r.sheet})`);
  }
});

/* ===========================================================================
   7. THE MARKUP THE CSS CONTRACT DEPENDS ON
   ======================================================================== */

check('the composer request picker is real markup, not a dead selector', () => {
  // Section 20 (2) only matters if `.anyhelp-empty` really renders a <select>.
  const panel = app.slice(app.indexOf('className="anyhelp-empty"'));
  assert.match(panel.slice(0, 900), /<select id="anyhelp-request"/,
    'the team-chat hiring-request picker is a <select> inside .anyhelp-empty');
});

check('.pcard-actions still holds no .btn, which is why its rules are dead', () => {
  // styles.css gives `.pcard-actions .btn` a 28px box and its own disabled
  // opacity. Both are unreachable. Recorded here so the next person does not
  // "fix" a rule nothing uses — and so that if a .btn is ever put there, this
  // fails and the box question gets asked.
  for (const f of ['app.jsx', 'cv-intake.jsx', 'intake-review.jsx', 'email-settings.jsx', 'org-structure.jsx']) {
    const src = read(f);
    const i = src.indexOf('className="pcard-actions"');
    if (i < 0) continue;
    const block = src.slice(i, i + 400);
    assert.equal(/className="btn|className=\{'btn/.test(block), false,
      `${f}: .pcard-actions still contains no .btn`);
  }
});

check('no button carries inline geometry', () => {
  // Geometry comes from classes. One site passes a style to a .btn and it is
  // `cursor: pointer` on the file-upload label, which is not geometry.
  // `btn[^"]*` also matches `btn-row`, which is a container, not a button, so
  // the class list is split and checked properly.
  const inline = [...app.matchAll(/className="([^"]*)" style=\{\{([^}]*)\}\}/g)]
    .filter((m) => m[1].split(/\s+/).includes('btn'));
  assert.ok(inline.length >= 3, `there really are inline-styled buttons to check (found ${inline.length})`);
  for (const m of inline) {
    const style = m[2].trim();
    // (a) A box dimension never belongs in an inline style on a shared button.
    assert.equal(/\b(width|height|padding)\s*:/.test(style), false,
      `a .btn carries inline geometry: ${style}`);
    // (b) The real defect is a CONDITIONAL metric — one button, two boxes. A
    //     conditional colour is fine and a conditional border is fine as long as
    //     both arms reserve the same WIDTH, which is the same border-width /
    //     border-colour split the badge suite established. Font size is exempt
    //     from being CHANGED by this step, but a font size that flips with state
    //     is still a width change and is checked.
    for (const d of style.split(/,(?![^(]*\))/)) {
      const [prop, ...rest] = d.split(':');
      const value = rest.join(':');
      if (!value.includes('?')) continue;
      const name = prop.trim();
      if (/^border/.test(name)) {
        const widths = [...value.matchAll(/(-?[\d.]+)px/g)].map((x) => x[1]);
        assert.ok(widths.length >= 2 && new Set(widths).size === 1,
          `a .btn changes its border WIDTH with its state (${name}: ${value.trim()})`);
        continue;
      }
      assert.equal(/^(fontWeight|fontSize|letterSpacing|lineHeight|padding|width|height|gap|textTransform)$/.test(name), false,
        `a .btn changes a metric with its state (${name}: ${value.trim()})`);
    }
  }
});

console.log(`\n=== UI FORM CONTROLS: ${passed} passed, ${failed} failed ===`);
if (failed) process.exit(1);
