// Regression guard for the static component gallery (UI Step 10).
//
// component-gallery.html is a checked-in, no-build reference page: it loads
// the five real production stylesheets and shows every component family in
// its real states, so a reviewer (or a future change) can see the actual
// rendered system without spinning up Storybook — which this app deliberately
// does not have (no bundler; app.jsx is compiled in-browser by vendored
// Babel).
//
// The real regression risk here is DRIFT: the gallery silently stops loading
// the same stylesheets, in the same order, at the same cache-bust token as
// index.html, and nobody notices because the gallery is not part of any route
// or test that exercises the live app. This suite asserts that contract, plus
// the presence of every component family the gallery is required to cover.
//
// Discipline, inherited from ui_layout_containers_test.mjs and
// ui_overlays_test.mjs: assert resolved facts, never grep for a substring
// that a one-character edit defeats. This suite does NOT prove pixel
// geometry — nothing here lays out a document; only a browser does that. Each
// check below is followed by a mutation of the loaded content that proves the
// assertion actually fails when the thing it protects breaks.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const publicDir = fileURLToPath(new URL('../frontend/public/', import.meta.url));
const galleryPath = publicDir + 'component-gallery.html';
const indexPath = publicDir + 'index.html';

let passed = 0, failed = 0;
function check(name, run) {
  try { run(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n      ${e.message}`); }
}

// Extract the ordered list of `<link rel="stylesheet" href="...">` hrefs from
// an HTML string, in document order.
function stylesheetHrefs(html) {
  const out = [];
  for (const m of html.matchAll(/<link\b[^>]*rel=["']stylesheet["'][^>]*>/gi)) {
    const hrefMatch = m[0].match(/href=["']([^"']+)["']/i);
    if (hrefMatch) out.push(hrefMatch[1]);
  }
  return out;
}

const PRODUCTION_SHEETS = [
  'styles.css', 'arabtec-approved-ui.css', 'arabtec-design-system.css',
  'claude-system.css', 'arabtec-responsive.css',
];

/* ---------------------------------------------------------------------------
   The gallery exists.
   ------------------------------------------------------------------------ */
check('the gallery file exists', () => {
  assert.ok(fs.existsSync(galleryPath), `expected ${galleryPath} to exist`);
});

const indexHtml = fs.readFileSync(indexPath, 'utf8');
const galleryHtml = fs.readFileSync(galleryPath, 'utf8');

/* ---------------------------------------------------------------------------
   Stylesheets: same five, same order, same cache-bust token as index.html.
   This is the real regression this suite exists to catch.
   ------------------------------------------------------------------------ */
check('index.html itself still loads exactly the five expected stylesheets, in order (fixture sanity)', () => {
  const hrefs = stylesheetHrefs(indexHtml);
  const names = hrefs.map((h) => h.split('?')[0].replace(/^\//, ''));
  assert.deepEqual(names, PRODUCTION_SHEETS,
    `if this fails, PRODUCTION_SHEETS in this test is out of date with index.html, not the gallery`);
});

check('the gallery loads exactly the five production stylesheets, in the same order as index.html', () => {
  const hrefs = stylesheetHrefs(galleryHtml);
  const names = hrefs.map((h) => h.split('?')[0].replace(/^\//, ''));
  assert.deepEqual(names, PRODUCTION_SHEETS,
    `gallery stylesheet order was [${names.join(', ')}], expected [${PRODUCTION_SHEETS.join(', ')}]`);

  // Mutation check: reordering two sheets must be caught.
  const reordered = galleryHtml.replace(
    '<link rel="stylesheet" href="/styles.css?v=20260913c" />\n<link rel="stylesheet" href="/arabtec-approved-ui.css?v=20260913c" />',
    '<link rel="stylesheet" href="/arabtec-approved-ui.css?v=20260913c" />\n<link rel="stylesheet" href="/styles.css?v=20260913c" />',
  );
  assert.notEqual(reordered, galleryHtml, 'the reorder substitution did not match — fixture text drifted, fix the mutation');
  const mutatedNames = stylesheetHrefs(reordered).map((h) => h.split('?')[0].replace(/^\//, ''));
  assert.notDeepEqual(mutatedNames, PRODUCTION_SHEETS, 'sanity: the mutation should actually change the order');
});

check('every gallery stylesheet link carries the SAME ?v= token index.html uses', () => {
  const indexHrefs = stylesheetHrefs(indexHtml);
  const indexTokens = new Set(indexHrefs.map((h) => (h.split('?v=')[1] || null)));
  assert.equal(indexTokens.size, 1, 'index.html itself should use one consistent token (fixture sanity)');
  const token = [...indexTokens][0];
  assert.ok(token, 'index.html stylesheet links must carry a ?v= token');

  const galleryHrefs = stylesheetHrefs(galleryHtml);
  assert.equal(galleryHrefs.length, 5, 'expected 5 stylesheet links in the gallery');
  for (const href of galleryHrefs) {
    const t = href.split('?v=')[1];
    assert.equal(t, token, `${href} does not carry the current cache-bust token ${token} — the gallery has drifted from index.html`);
  }

  // Mutation check: a stale token on one sheet must be caught.
  const staleToken = token.slice(0, -1) + (token.slice(-1) === '0' ? '1' : '0');
  const staled = galleryHtml.replace(`arabtec-responsive.css?v=${token}`, `arabtec-responsive.css?v=${staleToken}`);
  assert.notEqual(staled, galleryHtml, 'the staling substitution did not match — fixture text drifted, fix the mutation');
  const staledHrefs = stylesheetHrefs(staled);
  assert.ok(staledHrefs.some((h) => h.split('?v=')[1] !== token),
    'sanity: the mutation should actually introduce a mismatched token');
});

/* ---------------------------------------------------------------------------
   Viewport meta + real shell structure.
   ------------------------------------------------------------------------ */
check('the gallery carries the mobile-correct viewport meta tag', () => {
  assert.match(galleryHtml, /<meta\s+name=["']viewport["']\s+content=["']width=device-width,\s*initial-scale=1\.0,\s*viewport-fit=cover["']\s*\/?>/,
    'without this meta tag, mobile widths render at the 980px layout viewport, not the device width');

  const stripped = galleryHtml.replace(/<meta\s+name=["']viewport["'][^>]*>/, '');
  assert.notEqual(stripped, galleryHtml, 'the viewport-meta removal did not match — fixture drifted');
  assert.doesNotMatch(stripped, /name=["']viewport["']/, 'sanity: the mutation actually removes the tag');
});

check('the gallery renders inside the real shell/sidebar/main/content structure', () => {
  // Order matters: shell must contain sidebar, which precedes a `.main`
  // ancestor that itself contains `.content` — this is the real nesting
  // app.jsx produces (Shell component), not an approximation.
  const shellIdx = galleryHtml.indexOf('class="shell"');
  assert.ok(shellIdx !== -1, 'missing .shell');
  const sidebarIdx = galleryHtml.indexOf('class="sidebar"', shellIdx);
  assert.ok(sidebarIdx !== -1 && sidebarIdx > shellIdx, '.sidebar must appear inside .shell');
  const mainIdx = galleryHtml.indexOf('class="main"', sidebarIdx);
  assert.ok(mainIdx !== -1 && mainIdx > sidebarIdx, '.main must appear after .sidebar');
  const contentIdx = galleryHtml.indexOf('class="content', mainIdx);
  assert.ok(contentIdx !== -1 && contentIdx > mainIdx, '.content must appear inside .main');

  // Mutation check: dropping the shell wrapper must be caught.
  const flattened = galleryHtml.replace('<div class="shell">', '<div class="not-shell-anymore">');
  assert.notEqual(flattened, galleryHtml, 'the shell-removal substitution did not match — fixture drifted');
  assert.ok(flattened.indexOf('class="shell"') === -1, 'sanity: the mutation actually removes the shell class');
});

/* ---------------------------------------------------------------------------
   Every required component family is present, by the class names that must
   appear (not by counting HTML elements, which a refactor could rearrange
   without actually dropping the component).
   ------------------------------------------------------------------------ */
const REQUIRED_CLASSES = [
  // Buttons
  'btn-secondary', 'btn-ghost', 'btn-danger', 'btn-sm', 'btn-xs', 'btn-block', 'icon-btn',
  'is-hover', 'is-focus', 'is-active',
  // Inputs
  'class="field"', 'class="toolbar"',
  // Badges / chips
  'class="chip"', 'badge-success', 'status-chip filled', 'status-chip rejected',
  'chip-filter', 'count-pill', 'tag-toggle', 'cvi-badge', 'score-badge',
  // Tabs
  'tabbar-btn', 'profile-tab', 'seg-tab', 'control-tab', 'view-toggle-btn', 'anyhelp-tabs',
  // Cards
  'class="card"', 'card-pad', 'card-head', 'dash-kpi', 'pcard',
  // Overlays
  'class="modal"', 'max-width:760px', 'cvrev-panel',
  // Toolbar
  'filter-toolbar', 'toolbar-secondary', 'toolbar-count',
  // Table states
  'table responsive-table candidates-table', 'table-busy', 'empty empty-neutral', 'class="skeleton"', 'list-skel',
];

for (const cls of REQUIRED_CLASSES) {
  check(`the gallery includes "${cls}"`, () => {
    assert.ok(galleryHtml.includes(cls), `"${cls}" was not found anywhere in component-gallery.html`);

    // Mutation check: if the ONE occurrence used to prove this is deleted,
    // the assertion above must fail. (Skip when the token legitimately
    // appears more than once — deleting one occurrence would still leave
    // the class covered, which is correct behavior, not a broken guard.)
    const count = galleryHtml.split(cls).length - 1;
    if (count === 1) {
      const withoutIt = galleryHtml.replace(cls, '');
      assert.ok(!withoutIt.includes(cls), `mutation sanity failed for "${cls}"`);
    }
  });
}

/* ---------------------------------------------------------------------------
   The gallery must show the product's OWN styling, never invent its own:
   no new colour literal, no font-family, no font-size inside this page's
   <style> block(s). (Content copied verbatim from app.jsx — like the
   decorative EmptyArt SVG, which hardcodes its own stroke colors in the
   product too — is not part of this check; only the gallery's own <style>
   tags are inspected.)
   ------------------------------------------------------------------------ */
function ownStyleBlocks(html) {
  return [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]);
}

check('the gallery\'s own <style> block declares no font-family', () => {
  const blocks = ownStyleBlocks(galleryHtml);
  assert.ok(blocks.length >= 1, 'expected at least one <style> block in the gallery');
  for (const css of blocks) {
    assert.doesNotMatch(css, /font-family\s*:/i, 'the gallery must inherit type from the product stylesheets, not declare its own');
  }

  // Mutation check.
  const mutated = galleryHtml.replace('</style>', '  body { font-family: Arial; }\n</style>');
  assert.notEqual(mutated, galleryHtml, 'the font-family injection did not match — fixture drifted');
  assert.ok(ownStyleBlocks(mutated).some((css) => /font-family\s*:/i.test(css)),
    'sanity: the mutation actually introduces a font-family declaration');
});

check('the gallery\'s own <style> block declares no font-size', () => {
  const blocks = ownStyleBlocks(galleryHtml);
  for (const css of blocks) {
    assert.doesNotMatch(css, /font-size\s*:/i, 'the gallery must inherit type scale from the product stylesheets, not declare its own');
  }

  const mutated = galleryHtml.replace('</style>', '  h2 { font-size: 22px; }\n</style>');
  assert.notEqual(mutated, galleryHtml, 'the font-size injection did not match — fixture drifted');
  assert.ok(ownStyleBlocks(mutated).some((css) => /font-size\s*:/i.test(css)),
    'sanity: the mutation actually introduces a font-size declaration');
});

// The five production stylesheets already hardcode plenty of literal colours
// themselves (e.g. `color: #fff` on ~100 button/badge rules) — copying one of
// those EXACT literals is transcription, not invention (this is exactly how
// the pseudo-class preview block reproduces the real `:hover` declaration for
// `.btn`, which itself hardcodes `color: #fff`). What must never appear is a
// colour literal that is NOT already present somewhere in the product's own
// five stylesheets — that would be the gallery choosing its own colour.
const productCss = PRODUCTION_SHEETS.map((f) => fs.readFileSync(publicDir + f, 'utf8')).join('\n');
function literalColorTokens(css) {
  const out = new Set();
  for (const m of css.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/g)) out.add(m[0].toLowerCase().replace(/\s+/g, ''));
  return out;
}
const productColorTokens = literalColorTokens(productCss);

function findForeignColorLiterals(html) {
  const offenders = [];
  for (const css of ownStyleBlocks(html)) {
    for (const m of css.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/g)) {
      const token = m[0].toLowerCase().replace(/\s+/g, '');
      if (!productColorTokens.has(token)) offenders.push(m[0]);
    }
  }
  return offenders;
}

check('the gallery\'s own <style> block introduces no colour literal that is foreign to the product stylesheets', () => {
  const offenders = findForeignColorLiterals(galleryHtml);
  assert.deepEqual(offenders, [],
    `found a colour literal in the gallery's own CSS that does not appear anywhere in the five product stylesheets (should be a var() token, or an EXACT copy of an existing literal, instead): ${offenders.join(' | ')}`);

  // Mutation check: a brand-new hex colour must be caught.
  const mutated = galleryHtml.replace('</style>', '  .gallery-divider { border-top-color: #ff00ff; }\n</style>');
  assert.notEqual(mutated, galleryHtml, 'the literal-colour injection did not match — fixture drifted');
  assert.ok(findForeignColorLiterals(mutated).length > 0,
    'sanity: the mutation should actually introduce a colour literal the guard catches');
});

console.log(`\n=== UI COMPONENT GALLERY: ${passed} passed, ${failed} failed ===`);
console.log('NOTE: this suite proves the gallery\'s markup/link/style CONTRACT. It does');
console.log('NOT prove pixel geometry, real :hover/:focus/:active rendering, or that no');
console.log('component overflows a real viewport — that was verified once by hand in a');
console.log('browser and is not re-checked by this process. That check, at');
console.log('1440/768/390: all five product stylesheets loaded at the same ?v=');
console.log('token; page horizontal overflow 0 at every width (scrollWidth ===');
console.log('clientWidth); buttons 40px on desktop and 44px on mobile. The only');
console.log('boxes wider than the viewport are the data table and the CV table,');
console.log('both inside their own scroll containers — the local-overflow');
console.log('ownership the product intends.');
if (failed) process.exit(1);
