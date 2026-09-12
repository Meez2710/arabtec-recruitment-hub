// Source-level contract for overlays (UI Step 9): dialogs, the stacked parse
// review, and the new CV review side panel.
//
// These checks do NOT prove pixel geometry — nothing here lays out a document.
// The rendered numbers quoted in the messages below were measured in a browser
// against the five production stylesheets in load order, with markup copied
// verbatim out of app.jsx, at 1440, 1280, 1024, 768, 430, 390 and 360. What is
// asserted here is the CSS and JSX contract that PRODUCED those numbers, so the
// measured result cannot be silently undone.
//
// Discipline, inherited from ui_layout_containers_test.mjs: resolve VALUES,
// never grep for a substring. An earlier guard elsewhere in this suite tested
// for the literal strings the author had just deleted, and an adversarial
// review reinstated the same seam with different numbers while the suite
// stayed green. Every check below therefore resolves the declaration that
// actually wins at a stated viewport width, and every group ends with a
// meta-assertion that feeds the guard a MUTATED stylesheet and proves the
// guard fails on it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const publicDir = fileURLToPath(new URL('../frontend/public/', import.meta.url));
const backendDir = fileURLToPath(new URL('./', import.meta.url));
const SHEET_NAMES = ['styles.css', 'arabtec-approved-ui.css', 'arabtec-design-system.css',
  'claude-system.css', 'arabtec-responsive.css'];
const readPublic = (f) => fs.readFileSync(publicDir + f, 'utf8');
const app = readPublic('app.jsx');
const candidatesRoute = fs.readFileSync(backendDir + 'src/routes/candidates.js', 'utf8');

let passed = 0, failed = 0;
function check(name, run) {
  try { run(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n      ${e.message}`); }
}

/* ---------------------------------------------------------------------------
   A MINIMAL CASCADE RESOLVER.

   Substring searches are what this file exists to avoid, so the checks below
   ask "what value wins for this selector at this width", which means actually
   walking the sheets. The resolver handles what these sheets use: top-level
   rules and one level of `@media`, with `(max-width: Npx)` / `(min-width: Npx)`
   conditions joined by `and`. It deliberately does NOT implement selector
   matching — a caller names an EXACT selector string, and a separate check
   below proves that no other selector in any sheet can reach the same elements,
   which is what makes "highest specificity, then last one wins" sound here.
   ------------------------------------------------------------------------ */

function stripComments(css) { return css.replace(/\/\*[\s\S]*?\*\//g, ''); }

// Every rule in a sheet, flattened, each tagged with the media conditions it
// sits under and its position in the load order.
function parseSheet(name, css, sheetIndex) {
  const src = stripComments(css);
  const rules = [];
  let i = 0, order = 0;
  function blockEnd(open) {
    let depth = 0;
    for (let k = open; k < src.length; k++) {
      if (src[k] === '{') depth++;
      else if (src[k] === '}') { depth--; if (depth === 0) return k; }
    }
    return src.length;
  }
  function walk(from, to, media) {
    let p = from;
    while (p < to) {
      const open = src.indexOf('{', p);
      if (open === -1 || open >= to) break;
      const prelude = src.slice(p, open).trim();
      const close = blockEnd(open);
      if (/^@media/i.test(prelude)) {
        walk(open + 1, close, media.concat(prelude.replace(/^@media/i, '').trim()));
      } else if (prelude.startsWith('@')) {
        // @supports / @keyframes / @font-face — not used by these checks.
      } else if (prelude) {
        rules.push({
          sheet: name, sheetIndex, order: order++, media,
          selectors: prelude.split(',').map((s) => s.trim()).filter(Boolean),
          body: src.slice(open + 1, close),
        });
      }
      p = close + 1;
    }
  }
  walk(0, src.length, []);
  return rules;
}

function loadRules(overrides = {}) {
  const out = [];
  SHEET_NAMES.forEach((name, idx) => {
    const css = Object.prototype.hasOwnProperty.call(overrides, name) ? overrides[name] : readPublic(name);
    out.push(...parseSheet(name, css, idx));
  });
  return out;
}

// Does every condition in this @media prelude hold at `width`?
function mediaApplies(prelude, width) {
  for (const cond of prelude.split(/\s+and\s+/i)) {
    const m = /\(\s*(max|min)-width\s*:\s*(\d+(?:\.\d+)?)px\s*\)/i.exec(cond);
    if (!m) return false;          // anything exotic: treat as not applying
    const n = Number(m[2]);
    if (m[1].toLowerCase() === 'max' ? !(width <= n) : !(width >= n)) return false;
  }
  return true;
}

function specificity(sel) {
  const ids = (sel.match(/#[\w-]+/g) || []).length;
  const cls = (sel.match(/\.[\w-]+|\[[^\]]+\]|:[a-z-]+(?:\([^)]*\))?/gi) || []).length;
  const els = (sel.replace(/[.#[][^\s>+~]*/g, ' ').match(/\b[a-z][\w-]*\b/gi) || []).length;
  return ids * 10000 + cls * 100 + els;
}

// Declarations for `prop` in a rule body, in source order (last wins inside a
// block). Shorthands are not expanded; callers name the property they wrote.
function declsIn(body, prop) {
  const out = [];
  const re = new RegExp(`(?:^|;|\\})\\s*${prop}\\s*:\\s*([^;}]+)`, 'gi');
  for (const m of body.matchAll(re)) out.push(m[1].trim().replace(/\s*!important$/i, ''));
  return out;
}

/**
 * The value that wins for an EXACT selector string at a given viewport width.
 * Returns null when nothing declares it — which is itself an assertable fact.
 */
function resolve(rules, selector, prop, width) {
  const wanted = selector.trim();
  const candidates = [];
  for (const r of rules) {
    if (!r.selectors.includes(wanted)) continue;
    if (!r.media.every((m) => mediaApplies(m, width))) continue;
    const vals = declsIn(r.body, prop);
    if (vals.length) candidates.push({ r, value: vals[vals.length - 1], spec: specificity(wanted) });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => (a.spec - b.spec) || (a.r.sheetIndex - b.r.sheetIndex) || (a.r.order - b.r.order));
  return candidates[candidates.length - 1].value;
}

/** Every selector across the five sheets that mentions a class token. */
function selectorsMentioning(rules, token) {
  const out = new Set();
  for (const r of rules) for (const s of r.selectors) if (s.includes(token)) out.add(s);
  return [...out].sort();
}

const RULES = loadRules();

/* ===========================================================================
   0. THE RESOLVER ITSELF — if this is wrong, nothing below means anything.
   ======================================================================== */
check('the resolver reads the real cascade, and reports absence as absence', () => {
  // A value every one of these sheets agrees on, resolved from scratch.
  assert.equal(resolve(RULES, '.cvrev-panel', 'flex-direction', 1440), 'column');
  // A selector that does not exist must resolve to null, not to something.
  assert.equal(resolve(RULES, '.cvrev-panel-does-not-exist', 'width', 1440), null);
  // A property nobody declares on that selector must resolve to null too.
  assert.equal(resolve(RULES, '.cvrev-panel', 'letter-spacing', 1440), null);
  // Media gating actually gates: the stacked rule is invisible at 1440.
  assert.equal(resolve(RULES, '.cvrev-details', 'min-height', 1440), '0');
  assert.notEqual(resolve(RULES, '.cvrev-details', 'min-height', 390), '0');
});

check('the resolver honours specificity, not just source order', () => {
  // `.modal-overlay` sets padding in styles.css; `.modal-overlay.cvrev-overlay`
  // is more specific and must win even though both are base (non-media) rules.
  assert.equal(resolve(RULES, '.modal-overlay', 'padding', 1440), '20px');
  assert.equal(resolve(RULES, '.modal-overlay.cvrev-overlay', 'padding', 1440), '0');
  assert.ok(specificity('.modal-overlay.cvrev-overlay') > specificity('.modal-overlay'));
});

/* ===========================================================================
   1. THE CV REVIEW PANEL FITS — at 430, 390 and 360 nothing may extend beyond
      the usable viewport.
   ======================================================================== */
check('nothing but the panel itself can style a .cvrev-* element', () => {
  // "Highest specificity, then last wins" is only sound if the set of rules
  // that can reach these elements is the set this file knows about. Assert the
  // whole universe of selectors carrying the token, so a rule added in a sheet
  // this file does not read would break the guard rather than slip past it.
  const seen = selectorsMentioning(RULES, 'cvrev');
  assert.deepEqual(seen, [
    '.cvrev-body',
    '.cvrev-cv',
    '.cvrev-cv > .parse-review-cv',
    '.cvrev-cv-state',
    '.cvrev-col-title',
    '.cvrev-details',
    '.cvrev-foot',
    '.cvrev-head',
    '.cvrev-head-id',
    '.cvrev-head-id h3',
    '.cvrev-head-sub',
    '.cvrev-note',
    '.cvrev-note-hint',
    '.cvrev-note-label',
    '.cvrev-note-row',
    '.cvrev-note-row .btn',
    '.cvrev-note-row textarea',
    '.cvrev-panel',
    '.cvrev-section-row td',
    '.cvrev-table',
    '.cvrev-table td',
    '.cvrev-table td:first-child',
    '.cvrev-table td:last-child',
    '.modal-overlay.cvrev-overlay',
  ].sort());
});

check('the panel can never be wider than the viewport, at any width', () => {
  // Measured: panel width 1040 at 1440 and 1280, and exactly the viewport width
  // (1024 / 768 / 430 / 390 / 360) at and below 1024, with the document's
  // horizontal overflow measured at 0 at all seven widths.
  // Do NOT assert the literal `min(1040px, 100%)` — the number is a design
  // choice and may move. Assert the SHAPE that makes the panel fit: a cap that
  // is bounded by 100% of its container. A bare `1040px`, a `1040px` with a
  // `max-width` bolted on somewhere else, or a `min(1040px, 110vw)` all fail.
  for (const w of [1440, 1280, 1024, 768, 430, 390, 360]) {
    const width = resolve(RULES, '.cvrev-panel', 'width', w);
    assert.ok(width, `.cvrev-panel declares no width at ${w}`);
    const m = /^min\(\s*([^,]+?)\s*,\s*100%\s*\)$/.exec(width);
    assert.ok(m, `at ${w} the panel width is "${width}" — it must be min(<cap>, 100%) so it cannot exceed its container`);
    assert.ok(/^\d+(?:\.\d+)?px$/.test(m[1]), `the cap "${m[1]}" must be an absolute px cap, not a viewport unit`);
    // And nothing may reintroduce a floor that beats that cap.
    assert.equal(resolve(RULES, '.cvrev-panel', 'min-width', w), null,
      `.cvrev-panel declares a min-width at ${w}; a min-width outranks the width cap and is how a panel overflows a phone`);
  }
});

check('the overlay releases its centring padding so the panel hugs the edge', () => {
  for (const w of [1440, 768, 360]) {
    assert.equal(resolve(RULES, '.modal-overlay.cvrev-overlay', 'padding', w), '0');
    assert.equal(resolve(RULES, '.modal-overlay.cvrev-overlay', 'place-items', w), 'stretch');
  }
});

check('neither grid track can be widened by its own content', () => {
  // A grid track's default `min-width: auto` is its content's minimum, so one
  // long unbroken value — an email, a LinkedIn URL — would push the track and
  // the panel wider than the viewport. Both tracks must be floored at 0.
  const cols = resolve(RULES, '.cvrev-body', 'grid-template-columns', 1440);
  const tracks = cols.split(/\)\s*,?\s*(?=minmax|\d|min|max|auto|fit-content)/).map((t) => (t.endsWith(')') ? t : t + ')'));
  assert.equal(tracks.length, 2, `expected two desktop tracks, got ${cols}`);
  for (const t of tracks) {
    assert.ok(/^minmax\(\s*0(?:px)?\s*,/.test(t.trim()),
      `track "${t.trim()}" is not floored at 0 — its content can widen the panel`);
  }
  // Stacked: exactly one track, still floored at 0.
  const stacked = resolve(RULES, '.cvrev-body', 'grid-template-columns', 390);
  assert.ok(/^minmax\(\s*0(?:px)?\s*,[^,]*\)$/.test(stacked.trim()),
    `stacked layout must be a single 0-floored track, got "${stacked}"`);
});

/* ===========================================================================
   2. THE CV AND THE DETAILS ARE GENUINELY SIDE BY SIDE, AND STACK SENSIBLY.
   ======================================================================== */
check('desktop: two columns, each owning its own scroller', () => {
  // Measured at 1440: details 519.5px wide at x=401..920.5, CV 519.5px at
  // x=920.5..1440 — adjacent, same top, no overlap. The details pane scrolls
  // itself (516px of its content was below the fold and reachable).
  for (const w of [1440, 1280, 1024]) {
    assert.equal(resolve(RULES, '.cvrev-body', 'display', w), 'grid');
    assert.equal(resolve(RULES, '.cvrev-body', 'overflow', w), 'hidden');
    assert.equal(resolve(RULES, '.cvrev-details', 'overflow-y', w), 'auto');
    assert.equal(resolve(RULES, '.cvrev-details', 'min-height', w), '0');
  }
});

check('stacked: ONE scroller, and neither pane may collapse under its content', () => {
  // THE BUG THIS GUARDS. A grid item whose `overflow` is not `visible` has an
  // automatic minimum size of ZERO. Measured at 390 with the pane keeping its
  // own scroller: the details row collapsed to 25px with 1127px of table
  // painting straight over the CV beneath it. With `overflow: visible` AND
  // `min-height: auto` the row sizes to its content — measured 1163.71px at
  // 390, 1204.3px at 360, 1056.95px at 768, with 0px hidden — and the BODY is
  // the single scroller.
  for (const w of [900, 768, 430, 390, 360]) {
    assert.equal(resolve(RULES, '.cvrev-body', 'overflow-y', w), 'auto',
      `at ${w} the stacked body is not the scroller`);
    assert.equal(resolve(RULES, '.cvrev-details', 'overflow', w), 'visible',
      `at ${w} the details pane still owns a scroller, which zeroes its automatic minimum size`);
    const minH = resolve(RULES, '.cvrev-details', 'min-height', w);
    assert.equal(minH, 'auto',
      `at ${w} the details pane resolves min-height: ${minH} — anything but \`auto\` lets the row collapse under its content`);
  }
});

check('the CV pane keeps a real height when stacked, so it is never a blank strip', () => {
  // Measured CV pane heights when stacked: 614.4 at 768, 559.2 at 430,
  // 506.4 at 390, 480 at 360 — all at the declared 60vh floor or above.
  for (const w of [768, 430, 390, 360]) {
    const floor = resolve(RULES, '.cvrev-cv', 'min-height', w);
    assert.ok(floor, `no CV height floor at ${w}`);
    const m = /^(\d+(?:\.\d+)?)(vh|px)$/.exec(floor);
    assert.ok(m, `the CV floor "${floor}" is not a resolvable length`);
    assert.ok(Number(m[1]) > 0, 'the CV floor must be greater than zero');
    assert.equal(resolve(RULES, '.cvrev-cv', 'overflow', w), 'visible');
  }
  // On desktop it takes its height from the row instead, and clips its own box.
  assert.equal(resolve(RULES, '.cvrev-cv', 'min-height', 1440), '0');
  assert.equal(resolve(RULES, '.cvrev-cv', 'overflow', 1440), 'hidden');
});

check('the reused CvFilePreview is told to fill the cell rather than being re-implemented', () => {
  assert.equal(resolve(RULES, '.cvrev-cv > .parse-review-cv', 'flex', 1440), '1 1 auto');
  assert.equal(resolve(RULES, '.cvrev-cv > .parse-review-cv', 'min-height', 1440), '0');
  // Both directions: the child rule must outrank the stacked `.parse-review-cv`
  // floor, or the preview would be pinned to 60vh inside a taller cell.
  assert.ok(specificity('.cvrev-cv > .parse-review-cv') > specificity('.parse-review-cv'));
});

/* ===========================================================================
   3. THE NOTE COMPOSER IS REACHABLE — it is pinned, not scrolled away.
   ======================================================================== */
check('the note sits outside the scroller and is pinned to the bottom', () => {
  // Measured bottom edge of the composer against the viewport height:
  // 827/900, 727/800, 695/768, 951/1024, 863/932, 775/844, 731/800 — inside at
  // all seven widths, with the footer below it.
  for (const w of [1440, 1280, 1024, 768, 430, 390, 360]) {
    assert.equal(resolve(RULES, '.cvrev-note', 'flex', w), '0 0 auto',
      `at ${w} the composer is not pinned — a flexible composer is the one that scrolls away`);
    assert.equal(resolve(RULES, '.cvrev-foot', 'flex', w), '0 0 auto');
  }
  // It is a sibling of the body in the JSX, not a child of it — a composer
  // inside the scroller cannot be pinned however it is styled.
  const panel = app.slice(app.indexOf('function CvReviewPanel'), app.indexOf('function CvReviewHost'));
  const bodyStart = panel.indexOf('className="cvrev-body"');
  const bodyEnd = panel.indexOf('className="cvrev-note"');
  assert.ok(bodyStart > 0 && bodyEnd > bodyStart, 'the panel must render the body before the note');
  const between = panel.slice(bodyStart, bodyEnd);
  // brace-free proof that the note is not nested inside the body element
  const opens = (between.match(/<div/g) || []).length;
  const closes = (between.match(/<\/div>/g) || []).length;
  assert.equal(opens, closes, 'the note composer is nested inside .cvrev-body — it would scroll with it');
});

check('the composer button never drops under the touch floor', () => {
  // Measured button height: 40px at 1440/1280/1024/768 and 44px at 430/390/360
  // — the floor the readiness release set, inherited from --cl-ctl-lg. That is
  // only inherited while nothing in the panel declares its own control size.
  const CONTROL = /\.btn|textarea|input|select/;
  const SIZING = /(?:^|;|\{)\s*(?:min-|max-)?height\s*:/;
  const offenders = [];
  for (const r of RULES) {
    for (const sel of r.selectors) {
      if (!sel.includes('cvrev') || !CONTROL.test(sel)) continue;
      if (SIZING.test(r.body)) offenders.push(`${sel} -> ${r.body.trim().slice(0, 60)}`);
    }
  }
  assert.deepEqual(offenders, [],
    `a .cvrev-* control declares its own height, which is how a control falls under the 44px floor:\n      ${offenders.join('\n      ')}`);
});

/* ===========================================================================
   4. THE STACKED PARSE REVIEW — the same collapse, in the overlay that already
      shipped.
   ======================================================================== */
check('the stacked parse review is one scroller with content-sized panes', () => {
  // Measured at 390 BEFORE: results were a 334px window onto 771px of content
  // and the CV sat in a 293px box. Letting the body scroll alone made it worse
  // — the results row collapsed to 81px, because a pane that keeps its own
  // scroller has an automatic minimum size of zero. AFTER: results 772.4px with
  // nothing hidden, CV 506.4px, body the single scroller.
  for (const w of [900, 768, 430, 390, 360]) {
    assert.equal(resolve(RULES, '.parse-review-body', 'overflow-y', w), 'auto', `stacked body must scroll at ${w}`);
    assert.equal(resolve(RULES, '.parse-review-results', 'overflow', w), 'visible', `results pane must release its scroller at ${w}`);
    assert.equal(resolve(RULES, '.parse-review-results', 'min-height', w), 'auto', `results pane must size to content at ${w}`);
  }
});

check('above 900 the parse review is unchanged — each column still scrolls itself', () => {
  for (const w of [901, 1024, 1280, 1440]) {
    assert.equal(resolve(RULES, '.parse-review-body', 'overflow', w), 'hidden');
    assert.equal(resolve(RULES, '.parse-review-body', 'overflow-y', w), null,
      `an overflow-y override leaked above the stacking breakpoint at ${w}`);
    assert.equal(resolve(RULES, '.parse-review-results', 'overflow-y', w), 'auto');
    assert.equal(resolve(RULES, '.parse-review-results', 'min-height', w), null);
  }
});

/* ===========================================================================
   5. GEOMETRY AND COLOUR STAY IN THEIR OWN SHEETS.
   ======================================================================== */
const FORBIDDEN_IN_GEOMETRY = ['color', 'background', 'background-color', 'font-family', 'font-size'];
function paintDeclsFor(rules, token, sheet) {
  const found = [];
  for (const r of rules) {
    if (r.sheet !== sheet) continue;
    if (!r.selectors.some((s) => s.includes(token))) continue;
    for (const prop of FORBIDDEN_IN_GEOMETRY) {
      for (const v of declsIn(r.body, prop)) found.push(`${r.selectors.join(',')} { ${prop}: ${v} }`);
    }
  }
  return found;
}

check('claude-system.css declares no paint for the panel, and the design system does', () => {
  assert.deepEqual(paintDeclsFor(RULES, 'cvrev', 'claude-system.css'), [],
    'claude-system.css is geometry-only — colour, background, font-family and font-size belong in the design system');
  // Both directions: the same scan must be able to SEE such declarations, or it
  // is proving nothing. The design system is where they actually live.
  const painted = paintDeclsFor(RULES, 'cvrev', 'arabtec-design-system.css');
  assert.ok(painted.length >= 8,
    `the paint scanner found only ${painted.length} colour/type declarations for .cvrev-* in the design system — the scan is not reaching them`);
});

check('the panel introduces no new hue — every colour is an existing token', () => {
  const literals = [];
  for (const r of RULES) {
    if (r.sheet !== 'arabtec-design-system.css') continue;
    if (!r.selectors.some((s) => s.includes('cvrev'))) continue;
    for (const m of r.body.matchAll(/#[0-9a-f]{3,8}\b|\brgba?\(/gi)) literals.push(`${r.selectors.join(',')}: ${m[0]}`);
  }
  assert.deepEqual(literals, [],
    `the panel hard-codes a colour instead of using a token:\n      ${literals.join('\n      ')}`);
});

/* ===========================================================================
   6. META — feed the guards a mutated stylesheet and prove they fail on it.
   ======================================================================== */
function guardFailsOn(mutatedRules, run) {
  try { run(mutatedRules); return false; } catch { return true; }
}

check('META: the guards fail when the fix is undone, however it is undone', () => {
  const cs = readPublic('claude-system.css');

  // (a) the details pane's min-height put back to zero — the 25px collapse.
  const zeroed = loadRules({ 'claude-system.css': cs.replace('.cvrev-details { overflow: visible; min-height: auto; }', '.cvrev-details { overflow: visible; min-height: 0; }') });
  assert.ok(guardFailsOn(zeroed, (R) => assert.equal(resolve(R, '.cvrev-details', 'min-height', 390), 'auto')),
    'reinstating min-height: 0 on the stacked details pane did NOT fail the guard');

  // (b) the same collapse reached by a DIFFERENT route — leaving the pane's own
  //     scroller on. A guard that only watched min-height would miss this.
  const scrollerKept = loadRules({ 'claude-system.css': cs.replace('.cvrev-details { overflow: visible; min-height: auto; }', '.cvrev-details { overflow: auto; min-height: auto; }') });
  assert.ok(guardFailsOn(scrollerKept, (R) => assert.equal(resolve(R, '.cvrev-details', 'overflow', 390), 'visible')),
    'keeping the pane scroller did NOT fail the guard');

  // (c) the panel width made absolute — the phone-overflow route.
  const fixedWidth = loadRules({ 'claude-system.css': cs.replace('width: min(1040px, 100%);', 'width: 1040px;') });
  assert.ok(guardFailsOn(fixedWidth, (R) => {
    const v = resolve(R, '.cvrev-panel', 'width', 360);
    assert.ok(/^min\(\s*[^,]+,\s*100%\s*\)$/.test(v), v);
  }), 'an absolute panel width did NOT fail the guard');

  // (d) the panel width kept as min() but re-floored by a min-width, which is
  //     the sneaky version of (c) and is why the guard checks min-width too.
  const refloored = loadRules({ 'claude-system.css': cs.replace('width: min(1040px, 100%);', 'width: min(1040px, 100%); min-width: 900px;') });
  assert.ok(guardFailsOn(refloored, (R) => assert.equal(resolve(R, '.cvrev-panel', 'min-width', 360), null)),
    'a min-width floor beating the width cap did NOT fail the guard');

  // (e) the composer unpinned so it scrolls away with the body.
  const unpinned = loadRules({ 'claude-system.css': cs.replace('.cvrev-note { flex: 0 0 auto;', '.cvrev-note { flex: 1 1 auto;') });
  assert.ok(guardFailsOn(unpinned, (R) => assert.equal(resolve(R, '.cvrev-note', 'flex', 390), '0 0 auto')),
    'unpinning the composer did NOT fail the guard');

  // (f) a track un-floored, so a long email can widen the panel.
  const unfloored = loadRules({ 'claude-system.css': cs.replace('grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);', 'grid-template-columns: 1fr 1fr;') });
  assert.ok(guardFailsOn(unfloored, (R) => {
    const cols = resolve(R, '.cvrev-body', 'grid-template-columns', 1440);
    for (const t of cols.split(/\s+/)) assert.ok(/^minmax\(0/.test(t), cols);
  }), 'un-flooring the grid tracks did NOT fail the guard');

  // (g) a colour smuggled into the geometry sheet.
  const painted = loadRules({ 'claude-system.css': cs.replace('.cvrev-foot { flex: 0 0 auto; }', '.cvrev-foot { flex: 0 0 auto; background: #fff; }') });
  assert.ok(guardFailsOn(painted, (R) => assert.deepEqual(paintDeclsFor(R, 'cvrev', 'claude-system.css'), [])),
    'a background in the geometry sheet did NOT fail the guard');

  // (h) a control given its own height, which is how the 44px floor is lost.
  const sized = loadRules({ 'claude-system.css': cs.replace('.cvrev-note-row .btn { flex: 0 0 auto; }', '.cvrev-note-row .btn { flex: 0 0 auto; min-height: 36px; }') });
  assert.ok(guardFailsOn(sized, (R) => {
    const bad = [];
    for (const r of R) for (const sel of r.selectors) {
      if (sel.includes('cvrev') && /\.btn/.test(sel) && /(?:^|;|\{)\s*(?:min-)?height\s*:/.test(r.body)) bad.push(sel);
    }
    assert.deepEqual(bad, []);
  }), 'a hard-coded control height did NOT fail the guard');
});

/* ===========================================================================
   7. EVERY ENTRY POINT REACHES THE PANEL — and none of them downloads instead.
   ======================================================================== */
function slice(from, to) {
  const a = app.indexOf(from);
  assert.notEqual(a, -1, `could not find ${from} in app.jsx`);
  const b = app.indexOf(to, a + from.length);
  assert.notEqual(b, -1, `could not find ${to} after ${from} in app.jsx`);
  return app.slice(a, b);
}

check('no view path downloads the résumé any more, and download still exists elsewhere', () => {
  // The whole complaint: opening a CV pushed the file at the browser. Every one
  // of those call sites used api.download on the resume endpoint.
  const viewDownloads = [...app.matchAll(/api\.download\(([^)]*)\)/g)]
    .map((m) => m[1]).filter((arg) => /resume/.test(arg));
  assert.deepEqual(viewDownloads, [],
    `a view path still calls api.download on the résumé: ${viewDownloads.join(' | ')}`);
  // Both directions: api.download is still the mechanism for OTHER files, so
  // the assertion above is about the résumé and not about an empty file.
  const otherDownloads = [...app.matchAll(/api\.download\(([^)]*)\)/g)].map((m) => m[1]);
  assert.ok(otherDownloads.length >= 3,
    `only ${otherDownloads.length} api.download call(s) left in app.jsx — the guard above may be passing vacuously`);
});

check('every named entry point opens the panel', () => {
  const entries = {
    'Talent Pool CV column': slice('data-label="CV" className="cell-actions"', '</td>'),
    'candidate action menu': slice('function CandidateActionMenu', 'function CandidatesPage'),
    'CandidateQuickView': slice('function CandidateQuickView', 'function AssessmentPanel'),
    'CandidateCvTab (profile CV tab)': slice('function CandidateCvTab', 'const ACT_CATS'),
    'request pipeline candidate card': slice('function cvReviewOpener', 'function PipelineCard'),
  };
  const missing = Object.entries(entries).filter(([, src]) => !/openCvReview\s*\(/.test(src)).map(([k]) => k);
  assert.deepEqual(missing, [], `these entry points do not open the CV review panel: ${missing.join(', ')}`);

  // The pipeline card only offers the item when the caller supplied a handler,
  // and the helper that supplies it is permission-gated.
  const opener = entries['request pipeline candidate card'];
  assert.ok(/can\(\s*user\s*,\s*'candidate\.view'\s*\)/.test(opener),
    'the pipeline opener is not gated on candidate.view');
  const card = slice('function PipelineCard', 'function TalentPipeline');
  assert.ok(/\{onReviewCv && <button/.test(card),
    'the pipeline card renders its Review CV item unconditionally');
});

check('Download survives as a secondary action, in the panel and beside it', () => {
  const panel = slice('function CvReviewPanel', 'function CvReviewHost');
  assert.ok(/downloadResume\(/.test(panel), 'the panel offers no Download action');
  // And the one-click download the Talent Pool row menu already had is intact.
  const menu = slice('function CandidateActionMenu', 'function CandidatesPage');
  assert.ok(/downloadResume\(candidate, toast\)/.test(menu),
    'the action menu lost its Download CV item');
  const cvTab = slice('function CandidateCvTab', 'const ACT_CATS');
  assert.ok(/downloadResume\(c, toast\)/.test(cvTab),
    'the profile CV tab lost its Download button');
});

check('the panel is mounted once, at the shell, not per page', () => {
  const shell = slice('function Shell(', 'function BarChart(');
  assert.ok(/<CvReviewHost user=\{user\} \/>/.test(shell), 'CvReviewHost is not mounted in the Shell');
  const mounts = (app.match(/<CvReviewHost/g) || []).length;
  assert.equal(mounts, 1, `CvReviewHost is mounted ${mounts} times; two hosts would open two panels on one event`);
});

/* ===========================================================================
   8. THE BLOB URL IS REVOKED — a leaked object URL pins the whole file.
   ======================================================================== */
check('the object URL the preview uses is revoked on close and on switch', () => {
  const panel = slice('function CvReviewPanel', 'function CvReviewHost');
  const creates = (panel.match(/URL\.createObjectURL/g) || []).length;
  const revokes = (panel.match(/URL\.revokeObjectURL/g) || []).length;
  // The helper creates; the panel revokes — on the effect's cleanup AND on the
  // late-arrival path where the fetch resolves after the panel has closed.
  assert.equal(creates, 0, 'the panel creates object URLs itself instead of going through fetchResumeBlobUrl');
  assert.equal(revokes, 2,
    `the panel revokes ${revokes} time(s); it must revoke on the effect cleanup and on a response that arrives after close`);
  assert.ok(/return\s*\(\)\s*=>\s*\{[^}]*revokeObjectURL/.test(panel),
    'the effect that creates the URL has no cleanup that revokes it');
  assert.ok(/if\s*\(!alive\)\s*\{\s*URL\.revokeObjectURL/.test(panel),
    'a response arriving after close leaks its object URL');
  // The helper is the only creator and has exactly one caller.
  const helper = slice('async function fetchResumeBlobUrl', '/** Open the CV review panel');
  assert.equal((helper.match(/URL\.createObjectURL/g) || []).length, 1);
  assert.equal((app.match(/fetchResumeBlobUrl\(/g) || []).length, 2,
    'fetchResumeBlobUrl must have exactly one caller besides its declaration');
  // It sends the Authorization header — a bare URL 401s in an iframe.
  assert.ok(/Authorization:\s*'Bearer '\s*\+\s*api\.token/.test(helper),
    'the résumé fetch does not send the bearer token, so the preview would be empty');
});

/* ===========================================================================
   9. THE NOTE — the existing endpoint, the existing permission.
   ======================================================================== */
check('the note saves through the endpoint that already exists', () => {
  const panel = slice('function CvReviewPanel', 'function CvReviewHost');
  const post = /api\.post\(`\/candidates\/\$\{candidateId\}\/notes`,\s*\{([^}]*)\}/.exec(panel);
  assert.ok(post, 'the note does not POST to /candidates/:id/notes');
  assert.ok(/noteType:\s*'note'/.test(post[1]),
    `the note sends an unknown noteType: ${post[1].trim()}`);
  // Both directions — the server really does accept that shape at that path,
  // under that permission. A front-end-only assertion would not catch a rename.
  assert.ok(/router\.post\('\/:id\/notes',\s*requirePermission\('candidate\.note'\)/.test(candidatesRoute),
    'the notes route is not where, or not what, the panel assumes');
  assert.ok(/d\.noteType \|\| 'note'/.test(fs.readFileSync(backendDir + 'src/lib/models.js', 'utf8')),
    "the model no longer defaults note_type to 'note'");
});

check('the composer is absent, not broken, without candidate.note', () => {
  const panel = slice('function CvReviewPanel', 'function CvReviewHost');
  assert.ok(/const canNote = can\(user, 'candidate\.note'\);/.test(panel),
    'the panel does not read the candidate.note permission');
  assert.ok(/\{canNote \? \(/.test(panel),
    'the composer is not gated on the permission');
  // Without it the panel still renders — a hint, not a disabled control that 403s.
  const elseBranch = panel.slice(panel.indexOf('{canNote ? ('));
  assert.ok(/\) : \(\s*<div className="cvrev-note">/.test(elseBranch),
    'there is no permission-less branch — the panel must still open without the note composer');
  assert.ok(!/disabled=\{!canNote\}/.test(panel),
    'the composer is shown-but-disabled rather than absent');
});

/* ===========================================================================
   10. DIALOG SEMANTICS ARE JOINED, NOT WEAKENED (ui_readiness_test owns these).
   ======================================================================== */
check('the new panel is a real dialog on the shared hook', () => {
  const panel = slice('function CvReviewPanel', 'function CvReviewHost');
  assert.ok(/useDialogFocus\(onClose\)/.test(panel), 'the panel does not use the shared focus hook');
  assert.ok(/ref=\{dialogRef\}/.test(panel));
  assert.ok(/role="dialog" aria-modal="true" aria-labelledby=\{titleId\}/.test(panel));
  assert.ok(/onKeyDown=\{onDialogKeyDown\}/.test(panel));
  assert.ok(/aria-label="Close dialog"/.test(panel));
  assert.ok(/tabIndex="-1"/.test(panel));
  // Both directions: the hook it leans on still does all four things.
  const hook = slice('function useDialogFocus', 'function Modal(');
  for (const needed of ["e.key === 'Escape'", "e.key !== 'Tab'", 'last.focus()', 'first.focus()', 'previous?.isConnected']) {
    assert.ok(hook.includes(needed), `useDialogFocus no longer does: ${needed}`);
  }
});

/* ===========================================================================
   11. THE REQUEST PICKER POPOVER — measured, and left alone deliberately.
   ======================================================================== */
check('the picker re-anchors on scroll and resize, which is why it was not changed', () => {
  // MEASURED, at 1024 with a horizontally scrolling candidates table: with the
  // shipped listeners the trigger moved -300px and the panel moved with it to
  // a gap of exactly 0. With the listeners removed — the counterfactual — the
  // trigger moved -300px and the panel did not move at all, leaving a 214px
  // gap. The reported detachment is what the code WITHOUT these two lines
  // does; the shipped hook already handles it, so nothing here was touched.
  const hook = slice('function useViewportAnchor', 'function RequestPickList');
  assert.ok(/window\.addEventListener\('scroll', place, true\)/.test(hook),
    'the capture-phase scroll listener is gone — the panel will detach from its trigger when the table scrolls');
  assert.ok(/window\.addEventListener\('resize', place\)/.test(hook));
  assert.ok(/window\.removeEventListener\('scroll', place, true\)/.test(hook)
    && /window\.removeEventListener\('resize', place\)/.test(hook),
    'the hook leaks its listeners');
  // And it clamps into the viewport, which is what keeps a 320px panel on a
  // 360px phone: measured left 72, right 352 at 360 wide.
  assert.ok(/Math\.min\(Math\.max\(8, b\.left\), window\.innerWidth - width - 8\)/.test(hook),
    'the horizontal clamp is gone; the panel can be placed off-screen');
  // Both consumers go through the hook rather than placing themselves.
  // Three references: the declaration, and the two `.rq-pop` owners that call
  // it. Neither owner may place itself.
  const refs = (app.match(/useViewportAnchor\(/g) || []).length;
  assert.equal(refs, 3, `expected the hook plus its two .rq-pop callers, found ${refs} reference(s)`);
  const popOwners = (app.match(/className="rq-pop"/g) || []).length;
  assert.equal(popOwners, 2, `expected two .rq-pop panels, found ${popOwners}`);
  assert.equal((app.match(/const anchor = useViewportAnchor\(open, wrapRef/g) || []).length, 2,
    'a .rq-pop owner stopped taking its position from the shared hook');
});

console.log(`\n=== UI OVERLAYS: ${passed} passed, ${failed} failed ===`);
process.exit(failed ? 1 : 0);
