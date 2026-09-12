// Structural contract for the compact state components — badges, chips and the
// tab families that share their geometry (section 19 of claude-system.css).
//
// These checks do NOT prove pixel geometry — this process lays out no document.
// Real rendered geometry was verified in a browser against all five production
// stylesheets, with the real markup from app.jsx and real Arabtec data, at
// 1440, 1366, 1280, 1200, 1024, 768, 430, 390 and 360. What is asserted here is
// the structure and the CSS contract that produced those numbers, so the
// measured result cannot be silently undone.
//
// The three defects this suite guards, all measured at 1440 before the fix:
//   .tabbar-btn         active label 106.49px -> 113.47px, four tabs shoved 6.98px
//   .profile-tab        active label  82.35px ->  86.27px, four tabs shoved 3.92px
//   .anyhelp-tabs .on   58.46px -> 61.46px in both axes, neighbour shoved 3px
// and, at 360, the one that broke a component in half:
//   .tag-toggle         `display: inline`, so the real project name
//                       "I-City New Cairo — Lagoon Beach Park" rendered as two
//                       fragments (104.99px + 139.78px), each drawing its own
//                       border and background, 19px apart on a 28px box.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const publicDir = fileURLToPath(new URL('../frontend/public/', import.meta.url));
const read = (f) => fs.readFileSync(publicDir + f, 'utf8');

// The five sheets in the order index.html loads them. Cascade order matters for
// every assertion below: the geometry layer only wins because it loads 4th.
const SHEETS = ['styles.css', 'arabtec-approved-ui.css', 'arabtec-design-system.css',
  'claude-system.css', 'arabtec-responsive.css'];
const claude = read('claude-system.css');
const app = read('app.jsx');
const section = claude.slice(claude.indexOf('19. COMPACT STATE COMPONENTS'));

/* --------------------------------------------------------------------------
   A minimal CSS reader. Walks braces so rules nested in @media are seen too,
   and returns every rule in document order, per sheet, in LOAD order — which
   is what "who wins" means here.
   -------------------------------------------------------------------------- */
function rules(css, sheet) {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  let depth = 0, start = 0, selStart = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '{') {
      if (depth === 0) { start = i; }
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0) {
        const sel = src.slice(selStart, start).trim();
        const body = src.slice(start + 1, i);
        if (sel.startsWith('@')) {
          // A conditional group: re-read its contents one level in.
          for (const r of rules(body, sheet)) out.push({ ...r, media: sel });
        } else if (sel) {
          out.push({ sel, body, media: '', sheet });
        }
        selStart = i + 1;
      }
    }
  }
  return out;
}
const ALL = SHEETS.flatMap((f) => rules(read(f), f));

// Every rule whose selector list contains exactly `target` as one of its parts.
const matching = (target) => ALL.filter((r) =>
  r.sel.split(',').some((p) => p.trim() === target));

const decls = (body) => [...body.matchAll(/([-a-z]+)\s*:\s*([^;]+)/g)]
  .map((m) => [m[1].trim(), m[2].trim()]);

// Last declared value of one property for a selector, in load order. Media
// queries are reported alongside so a mobile-only override is visible.
function finalValue(target, prop) {
  let found = null;
  for (const r of matching(target)) {
    for (const [p, v] of decls(r.body)) if (p === prop) found = { value: v, media: r.media, sheet: r.sheet };
  }
  return found;
}

// Border WIDTH is the half of a border that moves the layout; border COLOUR is
// not. Resolve the four widths a selector ends up with, expanding the
// shorthands the product actually uses (`border: 0`, `border: 1.5px solid X`,
// `border-bottom: 2px solid transparent`, `border-width`).
const LEN = /(-?[\d.]+)(px|em|rem)?/;
function borderWidths(target) {
  const w = { top: null, right: null, bottom: null, left: null };
  const len = (v) => {
    if (/^(none|hidden)\b/.test(v)) return 0;
    const m = v.match(LEN);
    return m ? Number(m[1]) : null;
  };
  for (const r of matching(target)) {
    for (const [p, v] of decls(r.body)) {
      if (p === 'border') { const n = len(v); if (n !== null) for (const k of Object.keys(w)) w[k] = n; }
      else if (p === 'border-width') {
        const parts = v.split(/\s+/).map(len);
        if (parts.every((n) => n !== null)) {
          const [a, b = a, c = a, d = b] = parts;
          Object.assign(w, { top: a, right: b, bottom: c, left: d });
        }
      } else {
        const m = p.match(/^border-(top|right|bottom|left)(-width)?$/);
        if (m) { const n = len(v); if (n !== null) w[m[1]] = n; }
      }
    }
  }
  return w;
}

let passed = 0, failed = 0;
function check(name, run) {
  try { run(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n      ${e.message}`); }
}

/* ===========================================================================
   1. THE GEOMETRY LAYER STAYS A GEOMETRY LAYER
   ======================================================================== */

check('section 19 exists and introduces no colour, background or typeface', () => {
  assert.ok(claude.includes('19. COMPACT STATE COMPONENTS'), 'claude-system.css carries section 19');
  assert.equal(/#[0-9a-fA-F]{3,8}\b|rgb\(|hsl\(|oklch\(/.test(section), false,
    'no colour literal');
  assert.equal(/font-family/.test(section), false, 'no typeface');
  assert.equal(/background\s*:/.test(section), false, 'no background literal');
  assert.equal(/!important/.test(section), false, 'no !important');
});

check('no font SIZE is used as a fitting mechanism', () => {
  // Rule (6) of the layout integrity contract: a font size is a typographic
  // decision, never a way to make a label fit its box.
  assert.equal(/font-size/.test(section), false,
    'section 19 must not change any rendered font size');
});

/* ===========================================================================
   2. CONTAINMENT, EXTENDED TO THE FAMILIES SECTION 14 DID NOT NAME
   ======================================================================== */

check('every compact label family now has a width ceiling and a flex floor', () => {
  // Section 14 gave .chip/.badge/.status-chip/.src-chip/.meta-chip/.code-pill/
  // .count-pill `max-width: 100%; min-width: 0`. These four had `max-width:
  // none`, so their content — not their container — decided how wide a row got.
  for (const sel of ['.chip', '.badge', '.status-chip', '.count-pill',
                     '.chip-filter', '.cvi-badge', '.preview-status-badge', '.tag-toggle']) {
    const mw = finalValue(sel, 'max-width');
    assert.ok(mw && mw.value === '100%', `${sel} caps its width at its container (got ${mw && mw.value})`);
    const mn = finalValue(sel, 'min-width');
    assert.ok(mn && parseFloat(mn.value) === 0, `${sel} may shrink below min-content (got ${mn && mn.value})`);
  }
});

check('a compact label truncates on one line; it never wraps or breaks mid-word', () => {
  for (const sel of ['.chip', '.badge', '.status-chip',
                     '.chip-filter', '.cvi-badge', '.preview-status-badge', '.tag-toggle']) {
    const ws = finalValue(sel, 'white-space');
    assert.ok(ws && ws.value === 'nowrap', `${sel} stays on one line (got ${ws && ws.value})`);
    const ov = finalValue(sel, 'overflow');
    assert.ok(ov && ov.value === 'hidden', `${sel} clips inside its own edge (got ${ov && ov.value})`);
  }
});

check('.tag-toggle is a block box, which is the only way its ellipsis renders', () => {
  // It was `display: inline`, so a long name wrapped BETWEEN WORDS like running
  // text and the pill was drawn twice, cut open in the middle of the name.
  // `inline-block` — not `inline-flex`: on a flex container a bare text child
  // becomes an anonymous flex item, which does not inherit `text-overflow`, so
  // the label would be guillotined mid-glyph instead of ellipsised.
  const d = finalValue('.tag-toggle', 'display');
  assert.ok(d && d.value === 'inline-block', `.tag-toggle renders as inline-block (got ${d && d.value})`);
  const to = finalValue('.tag-toggle', 'text-overflow');
  assert.ok(to && to.value === 'ellipsis', '.tag-toggle ellipsises rather than clipping');
  // The <span> form inherited the body's 1.45 line-height while the <button>
  // form resolved to the UA's `normal`. Invisible while it was `display:
  // inline`; a 28.5px / 32.13px split the moment it became a block box.
  const lh = finalValue('.tag-toggle', 'line-height');
  assert.ok(lh && lh.value === 'normal',
    `both forms of .tag-toggle share one height (line-height ${lh && lh.value})`);
});

check('the filter chip truncates its label and keeps its remove button', () => {
  assert.match(section, /\.chip-filter > \.chip-filter-label \{[^}]*text-overflow:\s*ellipsis/,
    'the label has its own block box so the ellipsis can render');
  assert.match(section, /\.chip-filter > \.chip-filter-label \{[^}]*min-width:\s*0/,
    'and may shrink below its min-content width');
  assert.match(section, /\.chip-filter > button \{[^}]*flex:\s*0 0 auto/,
    'truncation eats the label, never the control');
});

check('the intake badges ellipsise for the same reason', () => {
  const d = finalValue('.cvi-badge', 'display');
  assert.ok(d && d.value === 'inline-block', `.cvi-badge renders as inline-block (got ${d && d.value})`);
  for (const sel of ['.cvi-badge', '.preview-status-badge']) {
    const to = finalValue(sel, 'text-overflow');
    assert.ok(to && to.value === 'ellipsis', `${sel} ellipsises`);
  }
});

/* ===========================================================================
   3. A STATE CHANGE MUST NOT MOVE ANYTHING
   ======================================================================== */

const TAB_FAMILIES = [
  ['.tabbar-btn', '.tabbar-btn.active'],
  ['.profile-tab', '.profile-tab.active'],
  ['.seg-tab', '.seg-tab.active'],
  ['.control-tab', '.control-tab.active'],
  ['.view-toggle-btn', '.view-toggle-btn.active'],
  ['.anyhelp-tabs button', '.anyhelp-tabs button.on'],
];

check('selecting a tab cannot change its own width — no weight shift, any family', () => {
  // 500 -> 600 widened the selected label and shoved every tab after it
  // sideways. Emphasis is colour, background and lift; never metrics.
  for (const [base, active] of TAB_FAMILIES) {
    const b = finalValue(base, 'font-weight');
    const a = finalValue(active, 'font-weight');
    if (!a) continue;                       // no active weight declared at all
    assert.ok(b, `${base} declares a base weight to compare against`);
    assert.equal(a.value, b.value,
      `${active} is ${a.value} (${a.sheet}) against ${b.value} (${b.sheet}) on ${base}`);
  }
});

check('selecting a tab cannot change its own box — no border-width shift, any family', () => {
  // .anyhelp-tabs button had `border: 0` and .on added `border: 1.5px solid`,
  // so the selected tab grew 3px in both axes and pushed its neighbour.
  // A border has two halves: the WIDTH is geometry and lives in this layer,
  // the COLOUR stays in the design system and simply paints nothing.
  // An UNdeclared side on the active rule simply keeps the base width, which
  // can never shift anything; only a width the active state declares for
  // itself can. `.view-toggle-btn` is the case that proves it: the base sets
  // `border-width: 1px` in the geometry layer and the active rule sets none, so
  // both states carry the same box (and the same 0px used width, because
  // `border: 0` earlier in the cascade left the style at `none` — browser
  // verified).
  for (const [base, active] of TAB_FAMILIES) {
    const b = borderWidths(base), a = borderWidths(active);
    for (const side of ['top', 'right', 'bottom', 'left']) {
      if (a[side] === null) continue;
      const bw = b[side] ?? 0;
      assert.equal(a[side], bw,
        `${active} declares border-${side} ${a[side]}px against ${bw}px on ${base} — the width must already be reserved`);
    }
  }
});

check('no hover, focus or selected rule anywhere declares a layout property', () => {
  const LAYOUT = /^(padding|margin|border|border-width|font|font-size|font-weight|letter-spacing|line-height|text-transform|width|height|min-width|min-height|max-width|max-height)(-(top|right|bottom|left))?(-width)?$/;
  const BASES = ['.chip', '.badge', '.status-chip', '.chip-filter', '.cvi-badge', '.score-badge',
    '.rq-link-chip', '.preview-status-badge', '.hist-badge-btn', '.chip-warn', '.tag-toggle',
    '.tabbar-btn', '.profile-tab', '.seg-tab', '.control-tab', '.view-toggle-btn'];
  const offenders = [];
  for (const r of ALL) {
    for (const part of r.sel.split(',')) {
      const s = part.trim();
      const base = BASES.find((b) => s.startsWith(b) && /^(:hover|:focus|:focus-visible|:active)$/.test(s.slice(b.length)));
      if (!base) continue;
      for (const [p] of decls(r.body)) {
        // An outline is painted outside the box and reserves nothing, so it is
        // the only safe way to draw a focus ring.
        if (LAYOUT.test(p)) offenders.push(`${s} { ${p} } in ${r.sheet}`);
      }
    }
  }
  assert.deepEqual(offenders, [], 'hover/focus must not resize a compact component');
});

/* ===========================================================================
   4. THE MARKUP THAT THE CSS CONTRACT DEPENDS ON
   ======================================================================== */

check('both filter-chip rows render the label box and the full text as a tooltip', () => {
  // The label is free text — "Request: R-0041 · <request title>", an owner
  // name, a raw search term — so this is the one chip whose content really has
  // no upper bound, and the one place truncation genuinely hides something.
  const uses = [...app.matchAll(/className="chip-filter"([^>]*)>\s*\n?\s*<span className="chip-filter-label">/g)];
  assert.equal(uses.length, 2, `both pages wrap the label (found ${uses.length})`);
  for (const m of uses) {
    assert.match(m[1], /title=\{label\}/, 'and put the untruncated label in a title');
  }
});

check('.tag-toggle carries a tooltip wherever it renders company data', () => {
  // Roles, projects, sites and interviewer names all come from the database and
  // all now truncate. Fixed UI labels (Message / Post a CV / Feedback) do not.
  for (const key of ['title={r.name}', 'title={p.name}', 'title={s.name}', 'title={u.name}']) {
    assert.ok(app.includes(key), `the user editor passes ${key} to its .tag-toggle`);
  }
});

check('unbounded .chip content is recoverable when it truncates', () => {
  // Candidate tags, required skills, attachment file names and panel members
  // are all free text inside a chip that section 14 clips at its own edge.
  const titled = (app.match(/className="chip" title=\{/g) || []).length;
  assert.ok(titled >= 5, `at least five .chip sites carry a title (found ${titled})`);
  assert.ok(app.includes('c.tags.slice(0, 3).map((t) => <span key={t} className="chip" title={t}>'),
    'the Talent Pool id-cell tags carry theirs');
});

check('the Users role chip is still the shared .chip, not a bespoke label', () => {
  // The reference case. `Recruitment Manager` is the longest of the nine role
  // names in backend/src/lib/permissions.js and measures 133.38px; the Role(s)
  // column never drops below 160.38px, because the Users table carries a 680px
  // min-width floor and owns its own horizontal scroll inside .card. It FITS at
  // every measured width, so the decision is fit, not truncate-with-tooltip —
  // and section 14's containment stays underneath it as the safety floor.
  const page = app.slice(app.indexOf('function UsersPage'));
  assert.match(page, /u\.roles\.map\(\(r\) => <span className="chip" key=\{r\.code\}>\{r\.name\}<\/span>\)/,
    'the role cell composes .chip so it inherits the containment contract');
});

check('the tab families still compose the shared tab components', () => {
  for (const [cls, group] of [['tabbar-btn', 'tabbar'], ['profile-tab', 'profile-tabs'],
    ['seg-tab', 'seg-tabs'], ['control-tab', 'control-tabs'], ['view-toggle-btn', 'view-toggle']]) {
    assert.ok(app.includes(`'${cls}' + (`), `${cls} is still toggled by class, not by inline style`);
    assert.ok(app.includes(`className="${group}"`) || app.includes(`className={'${group}`),
      `${group} is still the track`);
  }
  // Geometry comes from classes; a tab must never carry an inline size.
  assert.equal(/className=\{'(tabbar-btn|profile-tab|seg-tab|control-tab|view-toggle-btn)[^}]*\} style=/.test(app), false,
    'no tab carries inline geometry');
});

console.log(`\n=== UI BADGE / CHIP / TAB: ${passed} passed, ${failed} failed ===`);
if (failed) process.exit(1);
