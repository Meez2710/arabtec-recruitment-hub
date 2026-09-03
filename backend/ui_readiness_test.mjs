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
  if (condition) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}`); }
}

const versions = [...html.matchAll(/\?v=([\w-]+)/g)].map((match) => match[1]);
check('all deployed UI assets share one cache version', versions.length >= 7 && new Set(versions).size === 1);
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
check('empty states render the supplied icon', app.includes('{icon || <svg'));
check('intake review body copy meets the release size', ruleHas(readinessCss, '.review-table td, .review-table td > strong', 'font-size: 12.5px'));

console.log(`\n=== UI READINESS: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed ? 1 : 0);
