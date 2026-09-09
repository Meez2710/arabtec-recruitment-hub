// Source-level contract for the mobile reflow layer. The production SPA has no
// bundler or DOM harness, so these checks guard the structural guarantees that
// must survive future stylesheet edits: stacked tables become columns, long
// values wrap, and chrome clears the bottom navigation / anyhelp launcher.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, '../frontend/public');
const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
const responsive = fs.readFileSync(path.join(publicDir, 'arabtec-responsive.css'), 'utf8');
const design = fs.readFileSync(path.join(publicDir, 'arabtec-design-system.css'), 'utf8');
const claude = fs.readFileSync(path.join(publicDir, 'claude-system.css'), 'utf8');

function between(source, start, end) {
  const a = source.indexOf(start);
  const b = source.indexOf(end, a + start.length);
  return a >= 0 && b >= 0 ? source.slice(a, b) : '';
}

function ruleHas(source, selector, declaration) {
  const selectorAt = source.indexOf(selector);
  if (selectorAt < 0) return false;
  const open = source.indexOf('{', selectorAt);
  const close = source.indexOf('}', open);
  return open >= 0 && close >= 0 && source.slice(open + 1, close).includes(declaration);
}

let passed = 0;
let failed = 0;
function check(name, condition) {
  if (condition) { passed++; console.log(`  \u2713 ${name}`); }
  else { failed++; console.error(`  \u2717 ${name}`); }
}

const links = [...html.matchAll(/<link rel="stylesheet" href="([^"?]+)(?:\?v=([^"]+))?"/g)]
  .map((m) => ({ href: m[1], v: m[2] }));
const versions = [...html.matchAll(/\?v=([\w-]+)/g)].map((m) => m[1]);

check('reflow stylesheet is linked after the Claude geometry layer',
  html.indexOf('/claude-system.css?') > 0
  && html.indexOf('/arabtec-responsive.css?') > html.indexOf('/claude-system.css?'));
check('all deployed UI assets share one cache version',
  versions.length >= 8 && new Set(versions).size === 1);
check('viewport includes viewport-fit=cover for iPhone safe areas',
  html.includes('viewport-fit=cover'));

const mobile = between(responsive, '@media (max-width: 640px)', '@media (max-width: 480px)');
check('stacked table cells reflow as columns, not squeezed rows',
  mobile.includes('flex-direction: column') && mobile.includes('.responsive-table td'));
check('stacked table labels no longer reserve 40% of a phone row',
  /td::before[^{]*\{[^}]*flex:\s*0 0 auto/.test(mobile.replace(/\s+/g, ' '))
  && !/flex:\s*0 0 40%/.test(mobile));
check('cell-sub-only display:block applies to descendants, not the TD',
  mobile.includes('.responsive-table td .cell-sub-only')
  && mobile.includes('.responsive-table td.cell-sub-only')
  && mobile.includes('flex-direction: column'));
check('long cell values wrap instead of ellipsizing on a phone',
  mobile.includes('overflow-wrap: anywhere') && mobile.includes('white-space: normal'));
check('request-card meta stacks label then value',
  mobile.includes('.rq-meta > div') && mobile.includes('flex-direction: column')
  && mobile.includes('.rq-meta dd') && mobile.includes('white-space: normal'));
check('candidate cards drop the two-column university squeeze',
  mobile.includes('.cand-card .cc-face') && mobile.includes('grid-template-columns: 38px minmax(0, 1fr)')
  && mobile.includes('.cand-card .cc-uni') && mobile.includes('grid-column: 1 / -1'));
check('bottom navigation keeps env(safe-area-inset-bottom)',
  mobile.includes('.mobile-nav') && mobile.includes('env(safe-area-inset-bottom'));
check('anyhelp launcher sits above the bottom navigation and safe area',
  mobile.includes('.anyhelp-fab') && mobile.includes('var(--ats-nav-h)')
  && mobile.includes('env(safe-area-inset-bottom'));
check('page content reserves space for nav + launcher',
  mobile.includes('.content') && mobile.includes('padding-bottom'));
check('page-level overflow is clipped, not used as a layout strategy',
  ruleHas(responsive, 'html, body', 'overflow-x: clip') || responsive.includes('overflow-x: clip'));
check('reflow layer does not paper over bugs with !important',
  (responsive.match(/!important/g) || []).length === 0);

// The historical 40% label rule must still be beaten by cascade order, not deleted
// from product history — but the last sheet must not repeat it.
check('design-system still documents the stacked-table transform',
  design.includes('.responsive-table td::before') && design.includes('flex: 0 0 40%'));
check('stylesheet link order is styles \u2192 approved \u2192 design-system \u2192 claude \u2192 reflow',
  links.map((l) => l.href).join(' ') === [
    '/styles.css',
    '/arabtec-approved-ui.css',
    '/arabtec-design-system.css',
    '/claude-system.css',
    '/arabtec-responsive.css',
  ].join(' '));

/* --------------------------------------------------------------------------
   Talent Pool head. `.page-head-main` carries `flex: 1 1 320px` from
   claude-system.css — a ROW basis, so the title block claims a full line once
   the actions wrap. A later edit gave the Talent Pool head
   `flex-direction: column`, which turns that same declaration into a 320px
   basis ON HEIGHT: about 60px of title reserved 320px, and the page showed a
   quarter-screen of blank between the heading and the toolbar. The actions get
   their own row by wrapping the row, never by flipping the axis.
   -------------------------------------------------------------------------- */
const talentPool = between(responsive, 'TALENT POOL COMPOSITION', '@media');

check('the row basis this depends on is still declared',
  ruleHas(claude, '.page-head-main', 'flex: 1 1 320px'));
check('the Talent Pool head stays a row',
  talentPool.includes('flex-direction: row') && !talentPool.includes('flex-direction: column'));
check('it wraps, so the actions still get their own line',
  talentPool.includes('flex-wrap: wrap') && talentPool.includes('width: 100%'));
check('the title block claims that line explicitly, not via a height basis',
  talentPool.includes('.page-head-main') && talentPool.includes('flex: 1 1 100%'));

console.log(`\n=== UI RESPONSIVE: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed ? 1 : 0);
