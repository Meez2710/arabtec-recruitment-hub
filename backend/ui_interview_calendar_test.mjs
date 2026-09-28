// Interview calendar: the date arithmetic behind the Day / Week / Month grid,
// run against the production app.jsx in the vendored React/Babel (no DOM, no
// network). Dates are built with local-time constructors so the suite passes
// in any timezone.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const publicDir = fileURLToPath(new URL('../frontend/public/', import.meta.url));
const window = new EventTarget();
window.location = { hash: '', pathname: '/', search: '', reload() {} };
window.history = { replaceState() {} };
const document = Object.assign(new EventTarget(), { getElementById: () => ({}), activeElement: null });
const ctx = vm.createContext({ window, document, Event, CustomEvent, URLSearchParams, console,
  localStorage: { getItem: () => null }, setTimeout, clearTimeout,
  ReactDOM: { createRoot: () => ({ render() {} }) },
  fetch() { throw new Error('calendar tests must not use the network'); } });
ctx.self = ctx;
vm.runInContext(fs.readFileSync(publicDir + 'vendor/react.production.min.js', 'utf8'), ctx);
vm.runInContext(fs.readFileSync(publicDir + 'vendor/babel.min.js', 'utf8'), ctx);
for (const file of ['email-settings.jsx', 'org-structure.jsx', 'app.jsx']) {
  const source = fs.readFileSync(publicDir + file, 'utf8');
  vm.runInContext(ctx.Babel.transform(source, { presets: ['react'] }).code, ctx, { filename: file });
}
const get = (name) => vm.runInContext(name, ctx);
const app = fs.readFileSync(publicDir + 'app.jsx', 'utf8');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); console.log('  ✅ ' + name); pass++; } catch (e) { console.log('  ❌ ' + name + '\n     ' + e.message); fail++; }
}
const D = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi);
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const iv = (id, start, durationMin = 60, status = 'scheduled') => ({ id, scheduledAt: start.toISOString(), durationMin, status });

const calWeekStart = get('calWeekStart'); const calRange = get('calRange'); const calWeekdays = get('calWeekdays');
const calWeekDates = get('calWeekDates'); const calHourSpan = get('calHourSpan'); const calLayoutDay = get('calLayoutDay');
const calFirstOpenSlot = get('calFirstOpenSlot'); const calSlotOpen = get('calSlotOpen'); const calStep = get('calStep');
const toLocalInput = get('toLocalInput');

console.log('\n— the working week is Saturday to Thursday —');
check('a Monday belongs to the week that started the Saturday before', () => assert.equal(ymd(calWeekStart(D(2026, 9, 28, 15))), '2026-09-26'));
check('a Saturday starts its own week', () => assert.equal(ymd(calWeekStart(D(2026, 9, 26, 8))), '2026-09-26'));
check('a Friday closes the week that started the Saturday before', () => assert.equal(ymd(calWeekStart(D(2026, 10, 2))), '2026-09-26'));
check('the week view fetches Saturday 00:00 to the next Saturday 00:00', () => {
  const r = calRange('week', D(2026, 9, 28, 15));
  assert.equal(ymd(r.from), '2026-09-26'); assert.equal(ymd(r.to), '2026-10-03'); assert.equal(r.from.getHours(), 0);
});
check('the month view covers whole Saturday-first weeks', () => {
  const r = calRange('month', D(2026, 9, 15));
  assert.equal(ymd(r.from), '2026-08-29'); assert.equal(ymd(r.to), '2026-10-03');
});
check('the day view is one calendar day', () => {
  const r = calRange('day', D(2026, 9, 28, 15));
  assert.equal(ymd(r.from), '2026-09-28'); assert.equal(ymd(r.to), '2026-09-29');
});
check('columns are Sat, Sun, Mon, Tue, Wed, Thu with nothing booked on Friday', () =>
  assert.deepEqual([...calWeekdays([])], [6, 0, 1, 2, 3, 4]));
check('Friday appears (last) only when an interview is booked on it', () =>
  assert.deepEqual([...calWeekdays([iv(1, D(2026, 10, 2, 10))])], [6, 0, 1, 2, 3, 4, 5]));
check('the column dates run 26 Sep → 1 Oct (+ 2 Oct when Friday shows)', () =>
  assert.deepEqual([...calWeekDates(D(2026, 9, 26), [6, 0, 1, 2, 3, 4, 5])].map(ymd),
    ['2026-09-26', '2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02']));

console.log('\n— hours: 09:00 to 17:00, never hiding a booking —');
check('an empty week shows 09–17', () => assert.deepEqual([...calHourSpan([])], [9, 17]));
check('an 08:00 interview pulls the grid back to 08:00', () => assert.deepEqual([...calHourSpan([iv(1, D(2026, 9, 28, 8), 45)])], [8, 17]));
check('an interview ending 17:30 pushes the grid to 18:00', () => assert.deepEqual([...calHourSpan([iv(1, D(2026, 9, 28, 16, 30))])], [9, 18]));

console.log('\n— placing interviews on a day —');
check('a 10:30 start sits 1.5 hours down a 09:00 grid', () => {
  const [p] = calLayoutDay([iv(1, D(2026, 9, 28, 10, 30))], 9, 56);
  assert.equal(p.top, 84); assert.equal(p.height, 54); assert.equal(p.lanes, 1);
});
check('two interviews at the same time sit side by side', () => {
  const placed = calLayoutDay([iv(1, D(2026, 9, 28, 10)), iv(2, D(2026, 9, 28, 10, 30))], 9, 56);
  assert.deepEqual([...placed].map((p) => [p.iv.id, p.lane, p.lanes]), [[1, 0, 2], [2, 1, 2]]);
});
check('back-to-back interviews each take the full width', () => {
  const placed = calLayoutDay([iv(1, D(2026, 9, 28, 10)), iv(2, D(2026, 9, 28, 11))], 9, 56);
  assert.ok(placed.every((p) => p.lanes === 1 && p.lane === 0));
});
check('a short interview is still tall enough to read and click', () =>
  assert.ok(calLayoutDay([iv(1, D(2026, 9, 28, 10), 15)], 9, 56)[0].height >= 22));

console.log('\n— booking from the grid —');
const now = D(2026, 9, 28, 11, 10);
check('a slot before now is closed; one after now is open', () => {
  assert.equal(calSlotOpen(D(2026, 9, 28, 11), now), false);
  assert.equal(calSlotOpen(D(2026, 9, 28, 11, 30), now), true);
});
check('clicking a future day books 09:00', () => assert.equal(toLocalInput(calFirstOpenSlot(D(2026, 9, 29), now)), '2026-09-29T09:00'));
check('clicking today books the next half hour', () => assert.equal(toLocalInput(calFirstOpenSlot(D(2026, 9, 28), now)), '2026-09-28T11:30'));
check('a day that is over offers nothing', () => {
  assert.equal(calFirstOpenSlot(D(2026, 9, 27), now), null);
  assert.equal(calFirstOpenSlot(D(2026, 9, 28), D(2026, 9, 28, 23, 50)), null);
});
check('the form receives the slot in datetime-local format', () => assert.equal(toLocalInput(D(2026, 9, 28, 9, 30)), '2026-09-28T09:30'));

console.log('\n— navigation —');
check('next from Thursday skips Friday to Saturday in day view', () => assert.equal(ymd(calStep('day', D(2026, 10, 1), 1)), '2026-10-03'));
check('previous from Saturday skips Friday to Thursday in day view', () => assert.equal(ymd(calStep('day', D(2026, 10, 3), -1)), '2026-10-01'));
check('week steps are seven days', () => assert.equal(ymd(calStep('week', D(2026, 9, 28), 1)), '2026-10-05'));
check('month steps land on the 1st', () => assert.equal(ymd(calStep('month', D(2026, 1, 31), 1)), '2026-02-01'));

console.log('\n— wiring —');
const page = app.slice(app.indexOf('function InterviewsPage'), app.indexOf('function InterviewDetail'));
check('the calendar is the first screen on desktop and a single day on phones', () =>
  assert.match(page, /isPhone \? 'day' : 'week'/));
check('the page offers Day, Week, Month and List', () =>
  assert.match(page, /\[\['day', 'Day'\], \['week', 'Week'\], \['month', 'Month'\], \['list', 'List'\]\]/));
check('calendar views ask the server for the visible range only', () => assert.match(page, /params\.set\('from', from\); params\.set\('to', to\)/));
check('an open slot opens the schedule form on that time', () => {
  assert.match(page, /onCreateAt=\{setCreateAt\}/);
  assert.match(page, /initialAt=\{createAt\}/);
});
check('the schedule form checks the panel for clashes and only warns', () => {
  const modal = app.slice(app.indexOf('function ScheduleInterviewModal'), app.indexOf('function InterviewsPage'));
  assert.match(modal, /\/interviews\/clashes\?/);
  assert.match(modal, /notice notice-warn cal-clash/);
  assert.doesNotMatch(modal.slice(modal.indexOf('disabled={'), modal.indexOf('disabled={') + 200), /clashes/, 'a clash must not disable Schedule');
});

console.log(`\n=== UI INTERVIEW CALENDAR: ${pass} passed, ${fail} failed ===\n`);
process.exit(fail ? 1 : 0);
