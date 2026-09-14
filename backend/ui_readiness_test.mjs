// Source-level release contract for the browser-served UI. The production SPA
// has no bundler or DOM test harness, so these checks guard the small set of
// structural guarantees that must survive future stylesheet and JSX edits.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, '../frontend/public');
const app = fs.readFileSync(path.join(publicDir, 'app.jsx'), 'utf8');
const css = fs.readFileSync(path.join(publicDir, 'arabtec-design-system.css'), 'utf8');
const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
const responsiveCss = fs.readFileSync(path.join(publicDir, 'arabtec-responsive.css'), 'utf8');
const defaults = fs.readFileSync(path.join(here, 'src/lib/permissions.js'), 'utf8');
const schema = fs.readFileSync(path.join(here, 'src/lib/schema.js'), 'utf8');
const readinessCss = css.slice(css.indexOf('16. UI READINESS RELEASE'));
const focusHook = app.slice(app.indexOf('function useDialogFocus'), app.indexOf('function Modal'));
const sharedModal = app.slice(app.indexOf('function Modal'), app.indexOf('function Confirm'));
const candidateDrawer = app.slice(app.indexOf('function CandidateQuickView'), app.indexOf('function AssessmentPanel'));

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

// UI Step 11: the Open-roles row's age label ("0d") and its Open button were
// two inline-level children of a plain block div (`style={{ textAlign: 'right' }}`),
// so they sat on the same line with a 0px gap; a stray `style={{ marginTop: 6 }}`
// on the button did nothing because margin-top does not stack inline-block
// siblings. `RoleRow` now wraps them in `.role-row-end`, a real stacked
// composition — guard both the JSX (no inline hack) and the CSS (it actually stacks).
const roleRow = app.slice(app.indexOf('function RoleRow'), app.indexOf('// Small date helpers'));

const versions = [...html.matchAll(/\?v=([\w-]+)/g)].map((match) => match[1]);
check('all deployed UI assets share one cache version', versions.length >= 7 && new Set(versions).size === 1);
check('reflow stylesheet is the last product CSS linked', html.lastIndexOf('rel="stylesheet"') === html.indexOf('rel="stylesheet" href="/arabtec-responsive.css?'));
check('authenticated shell has a render recovery boundary', app.includes('<AppErrorBoundary key={user.id}') && app.includes("console.error('ui.render_failed'"));
check('shared modal binds dialog semantics and keyboard handler', sharedModal.includes('ref={dialogRef}') && sharedModal.includes('role="dialog" aria-modal="true" aria-labelledby={titleId}') && sharedModal.includes('onKeyDown={onDialogKeyDown}'));
check('candidate drawer binds dialog semantics and keyboard handler', candidateDrawer.includes('ref={dialogRef}') && candidateDrawer.includes('role="dialog" aria-modal="true" aria-labelledby={titleId}') && candidateDrawer.includes('onKeyDown={onDialogKeyDown}'));
check('dialog hook traps Tab, closes on Escape, and restores focus', focusHook.includes("e.key === 'Escape'") && focusHook.includes("e.key !== 'Tab'") && focusHook.includes('last.focus()') && focusHook.includes('first.focus()') && focusHook.includes('previous?.isConnected'));
check('dialogs expose labelled close controls', sharedModal.includes('aria-label="Close dialog"') && candidateDrawer.includes('aria-label="Close candidate details"'));
check('saved primary color is contrast-guarded before driving action tokens', app.includes("hasWhiteTextContrast(b.button_color) ? b.button_color : '#008064'") && app.includes("r.setProperty('--at-action', primary)") && app.includes("r.setProperty('--at-action-hover', shadeColor(primary, -14))"));
check('action color defaults green and migrates only the legacy red default', defaults.includes("button_color: '#008064'") && schema.includes("['#008064', 'button_color', '#d2232a']"));
check('readiness mobile rules keep all buttons at 44px', ruleHas(readinessCss, '.btn, .btn-sm, .btn.small', 'min-height: 44px'));
check('four KPI layouts collapse to two columns before tablet width', ruleHas(readinessCss, '.dash-kpi-row:has(> :nth-child(4)):not(:has(> :nth-child(5)))', 'grid-template-columns: repeat(2, minmax(0, 1fr))'));
check('legacy tables receive a horizontal overflow owner', ruleHas(readinessCss, '.card:has(table:not(.responsive-table)', 'overflow-x: auto'));
check('empty states use the four shared schematic marks', ['none-yet', 'no-match', 'failed', 'all-clear'].every(mark => app.includes(`'${mark}': <svg`)) && app.includes('<EmptyArt name={mark} />') && !/<Empty\s+icon=/.test(app));
check('email module loads before the shell', html.indexOf('/email-settings.jsx?') > 0 && html.indexOf('/email-settings.jsx?') < html.indexOf('/app.jsx?'));
check('intake review body copy meets the release size', ruleHas(readinessCss, '.review-table td, .review-table td > strong', 'font-size: 12.5px'));
check('RoleRow found and is non-empty', roleRow.length > 0 && roleRow.length < 2000);
check('role-row Open button carries no inline margin-top hack', !roleRow.includes('marginTop'));
check('role-row age label + Open button share a dedicated stacking class', roleRow.includes('className="role-row-end"'));
check('.role-row-end actually stacks its children with a real gap, not an inline nudge',
  ruleHas(css, '.role-row-end', 'display: flex') && ruleHas(css, '.role-row-end', 'flex-direction: column')
  && ruleHas(css, '.role-row-end', 'gap: 6px'));

/* ---------------------------------------------------------------------------
   Shared refetch contract (Requests / Interviews / Offers / Users).

   All four loaders used to begin with `setUsers(null)` / `setData(null)` /
   `setOffers(null)`, and all four render branches read that same state as
   "still loading" — so every filter change and every search keystroke replaced
   the live table with a skeleton and then rebuilt it. Measured in the browser
   with a 700ms latency shim: rows went 14 -> 0, 25 skeleton elements appeared
   and the count pill unmounted for 726ms before the new rows arrived.

   The contract each loader must now keep:
     - it does not null its list state before fetching (content stays mounted),
     - it takes a `++loadSeq.current` ticket and drops its own result if a
       newer request has since started (no stale overwrite),
     - it clears the busy flag only for the newest request.
   ------------------------------------------------------------------------ */
const LOADERS = [
  ['RequestsPage',   'function RequestsPage',   'setData(null)'],
  ['InterviewsPage', 'function InterviewsPage', 'setData(null)'],
  ['OffersPage',     'function OffersPage',     'setOffers(null)'],
  ['UsersPage',      'function UsersPage',      'setUsers(null)'],
];
for (const [label, marker, clearCall] of LOADERS) {
  const start = app.indexOf(marker);
  const body = app.slice(start, app.indexOf('const load = useCallback', start));
  const loader = app.slice(app.indexOf('const load = useCallback', start));
  const fn = loader.slice(0, loader.indexOf('\n  useEffect(() => { load(); }, [load]);'));
  // Strip comments so an explanatory mention of the old call is not a match.
  const code = fn.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  check(`${label} refetch does not blank its list before fetching`, !code.includes(clearCall));
  // Both write paths must bail, not just one: an earlier version of this check
  // passed with the success-path guard deleted, because the catch block still
  // had one. Count them, and require the finally to gate the busy flag too.
  const bails = (code.match(/seq !== loadSeq\.current/g) || []).length;
  check(`${label} refetch guards both write paths against a stale response`,
    /\+\+loadSeq\.current/.test(code) && bails >= 2 && /seq === loadSeq\.current/.test(code));
  check(`${label} declares the loadSeq ticket it uses`, /useRef\(0\)/.test(body + fn));
}

// The four supporting datasets on Users do not depend on the search box; they
// were refetched with every keystroke because they shared one Promise.all with
// `/users`. Measured after the split: one keystroke issues exactly one call.
{
  const start = app.indexOf('function UsersPage');
  const loader = app.slice(app.indexOf('const load = useCallback', start));
  const fn = loader.slice(0, loader.indexOf('\n  useEffect(() => { load(); }, [load]);'));
  check('Users search refetches only /users, not its reference data',
    fn.includes("api.get('/users'") && !/\/roles|org\/departments|org\/projects|org\/sites/.test(fn));
}

// A refetch that fails keeps the rows it already had; only a failure with
// nothing to fall back on is allowed to take the page.
check('a failed refetch reports without replacing usable content',
  app.includes('function RefetchError')
  && (app.match(/loadError && (data|offers|users) \? <RefetchError/g) || []).length >= 3
  && (app.match(/loadError && !(data|offers|users) \?/g) || []).length >= 3);

/* ---------------------------------------------------------------------------
   Same-purpose controls share their typography.

   "Add manually" rendered at 11.5px beside "Bulk Upload CVs", "Parse CV" and
   "Scan CV Inbox" at 14px — one label visibly smaller than the three actions
   next to it, in the same row, doing the same kind of job. Two separate causes,
   both removed: an inline `style={{ fontSize: 11.5 }}` on the button, and an
   unexplained `.page-head:has(+ .ask-bar) .btn-ghost { font-size: 13.5px }` in
   the reflow layer, which shrank ghost buttons for that one page layout.

   Emphasis on a button is carried by fill and border, not by size.
   ------------------------------------------------------------------------ */
check('no control carries an inline font-size',
  !/<(?:button|select|input)[^>]*fontSize/.test(app));
check('ghost buttons are not shrunk relative to their action row',
  !/\.btn-ghost\s*\{[^}]*font-size/.test(responsiveCss)
  && !/:has\(\+ \.ask-bar\) \.btn-ghost \{\s*font-size/.test(responsiveCss));

console.log(`\n=== UI READINESS: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed ? 1 : 0);
