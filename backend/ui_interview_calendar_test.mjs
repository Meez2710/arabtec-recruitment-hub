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
// INTERVIEW_IMPLEMENTATION_BRIEF decision 2: the candidate cannot be in two
// interviews at once (blocks); a shared panelist is allowed only when the
// overlap is acknowledged with a reason; a shared location/link only warns.
check('the schedule form checks conflicts live: candidate blocks, panel needs a reason, location warns', () => {
  const modal = app.slice(app.indexOf('function ScheduleInterviewModal'), app.indexOf('function InterviewsPage'));
  assert.match(modal, /\/interviews\/clashes\?/);
  assert.match(modal, /const formReady = [^;]*!blockedByCandidate[^;]*\(!needsAck \|\| \(ack && overlapReason\.trim\(\)\)\)/, 'candidate conflict blocks; panel overlap needs acknowledgement + reason');
  assert.match(modal, /ackPanelOverlap: true, overlapReason/, 'the acknowledgement and reason are sent to the server');
  assert.match(modal, /avail\.location[^\n]*className="notice">/, 'a shared location or link is a plain warning');
  assert.doesNotMatch(modal, /formReady = [^;]*avail\.location/, 'a location overlap never blocks saving');
});

check('candidate answer (audit A3): four answers, shown only while the interview is upcoming', () => {
  const labels = Object.values(get('IV_RESPONSE')).map((r) => r.label);
  assert.deepEqual(labels, ['No answer yet', 'Confirmed', 'Wants another time', 'Declined']);
  const label = get('ivResponseLabel');
  assert.equal(label({ status: 'scheduled', candidateResponse: 'confirmed' }), 'Confirmed');
  assert.equal(label({ status: 'rescheduled' }), 'No answer yet', 'a missing answer reads as No answer yet');
  assert.equal(label({ status: 'completed', candidateResponse: 'confirmed' }), '', 'no answer chip once the interview is over');
  assert.match(app, /className="seg-tabs resp-picker" role="radiogroup"/, 'the detail page offers the four answers as one radio group');
});

check('phone numbers (audit A11): the form converts like the server (same cases as interview_comms_test)', () => {
  const ui = get('toIntlPhone');
  for (const [v, want] of [['01001234567', '+201001234567'], ['0100 123 4567', '+201001234567'], ['+20 100 123 4567', '+201001234567'],
    ['0020 122 345 6789', '+201223456789'], ['201501234567', '+201501234567'], ['٠١٠٠١٢٣٤٥٦٧', '+201001234567'], ['01001234567 / 01223456789', '+201001234567'],
    ['+971 50 123 4567', '+971501234567'], ['02 2345 6789', null], ['0181234567', null], ['call me', null], ['', null]]) {
    assert.equal(ui(v), want, `"${v}"`);
  }
  assert.match(app, /function CallHandoff\(/, 'the send dialog has a phone-call panel');
  assert.match(app, /channel === 'call' && r\.status === 'manual_handoff' \? CALL_HANDOFF/, 'a call reads "Call started — not confirmed", never sent');
});

check('needs a reminder (audit A7): ahead, within 24 h, and unconfirmed or not yet reminded', () => {
  const f = get('ivNeedsReminder');
  const now = Date.parse('2026-10-12T08:00:00Z');
  const at = (h) => new Date(now + h * 3600000).toISOString();
  assert.equal(f({ status: 'scheduled', scheduledAt: at(5), candidateResponse: 'pending' }, now), true);
  assert.equal(f({ status: 'rescheduled', scheduledAt: at(20), candidateResponse: 'confirmed', remindedAt: null }, now), true, 'confirmed but never reminded');
  assert.equal(f({ status: 'scheduled', scheduledAt: at(5), candidateResponse: 'confirmed', remindedAt: at(-1) }, now), false, 'confirmed and reminded');
  assert.equal(f({ status: 'scheduled', scheduledAt: at(30), candidateResponse: 'pending' }, now), false, 'more than a day away');
  assert.equal(f({ status: 'scheduled', scheduledAt: at(-1), candidateResponse: 'pending' }, now), false, 'already started');
  assert.equal(f({ status: 'cancelled', scheduledAt: at(5), candidateResponse: 'pending' }, now), false, 'cancelled');
  assert.match(app, /setComm\('reminder'\)\}>Send reminder<\/button>/, 'the interview page offers Send reminder');
});

check('messages come from templates (owner, 12 Oct): editors are folded away; chips name the value', () => {
  assert.equal((app.match(/<TemplateNote /g) || []).length, 2, 'the schedule form and the send dialog both use the template note');
  assert.match(app, /editable=\{customMsgs\}/, 'the WhatsApp text is read-only unless the wording is being changed for this interview');
  const phFor = get('phFor'); const phShort = get('phShort');
  const all = [{ name: 'candidateName', in: 'cw', label: 'Candidate full name' }, { name: 'changes', in: 'cwp', label: 'What changed (updates)' }];
  assert.deepEqual(phFor(all, 'c', 'invite').map((p) => p.name), ['candidateName'], 'update-only variables are not offered on an invitation');
  assert.deepEqual(phFor(all, 'c', 'update').map((p) => p.name), ['candidateName', 'changes']);
  assert.equal(phShort('Time zone, e.g. Cairo time (GMT+3)'), 'Time zone');
  assert.equal(phShort('Where: location, meeting link or phone, labelled'), 'Where');
});

check('place (owner, 12 Oct): on-site interviews pick Head Office or a site; name + address become the location', () => {
  const placeText = get('placeText');
  assert.equal(placeText({ name: 'Head Office', address: '12 Synthetic St, New Cairo' }), 'Head Office — 12 Synthetic St, New Cairo');
  assert.equal(placeText({ name: 'Site A', address: '' }), 'Site A');
  assert.equal((app.match(/f\.mode === 'onsite'\s*\?\s*<InterviewPlacePicker /g) || []).length, 2, 'the booking and reschedule forms both use the place picker for on-site');
  assert.match(app, /<option value="other">Other place…<\/option>/, 'a place outside the list can still be typed');
  assert.match(app, /id="iv-hq-addr"/, 'the Head Office address is set once, in Invitation templates');
});

check('next step after Completed (audit A10): shown only then, moves only on an explicit click', () => {
  assert.match(app, /\{iv\.status === 'completed' && <NextStepBox /, 'the box appears only for a Completed interview');
  const box = app.slice(app.indexOf('function NextStepBox('), app.indexOf('function InterviewDetail('));
  assert.match(box, /api\.post\(`\/applications\/\$\{app\.id\}\/move`/, 'moving uses the pipeline route and its checks');
  assert.match(box, /!REASON_STATUSES\.includes\(t\) && canPipelineMove\(app\.status, t\)/, 'only moves the board allows; reject/hold stay on the board with a reason');
  assert.match(box, /can\(user, 'candidate\.move_stage'\)/, 'only people allowed to move stages see the move control');
  assert.doesNotMatch(box, /useEffect\(/, 'nothing moves on its own');
});

check('working week (audit A9): a plain warning in both forms, never a block; editable once', () => {
  assert.equal((app.match(/\{avail\.hours && <div className="notice">Outside the working week/g) || []).length, 2, 'schedule and reschedule both warn');
  assert.doesNotMatch(app, /formReady = [^;]*avail\.hours/, 'the warning never disables saving');
  assert.match(app, /id="iv-ww-start"/, 'working days and hours are set in Invitation templates');
});

// Scheduling Setup (12 Oct): the calendar follows the SAVED working week, not
// constants. Default behaviour above is unchanged; these use a changed week.
console.log('\n— the calendar follows Scheduling Setup —');
const sunThu = { days: [0, 1, 2, 3, 4], start: '08:30', end: '16:00' };    // Saturday made non-working, 08:30–16:00
const satThu = { days: [0, 1, 2, 3, 4, 6], start: '09:00', end: '17:00' }; // the approved default, as the server sends it
check('the default week from the server gives Saturday–Thursday columns', () => assert.deepEqual([...calWeekdays([], satThu)], [6, 0, 1, 2, 3, 4]));
check('Friday stays a non-working day unless something is booked on it', () => {
  assert.ok(![...calWeekdays([], satThu)].includes(5));
  assert.ok([...calWeekdays([iv(1, D(2026, 10, 2, 10))], satThu)].includes(5));
});
check('a day switched off in Scheduling Setup leaves the week', () => assert.deepEqual([...calWeekdays([], sunThu)], [0, 1, 2, 3, 4]));
check('the grid opens at the saved start hour and closes after the saved end', () => assert.deepEqual([...calHourSpan([], sunThu)], [8, 16]));
check('an end time with minutes rounds the grid up to the next hour', () => assert.deepEqual([...calHourSpan([], { ...sunThu, end: '16:30' })], [8, 17]));
check('clicking a future day books the saved start time', () => assert.equal(toLocalInput(calFirstOpenSlot(D(2026, 9, 29), D(2026, 9, 28, 11, 10), sunThu)), '2026-09-29T08:30'));
check('day-by-day skips every non-working day from the setting', () => assert.equal(ymd(calStep('day', D(2026, 10, 1), 1, sunThu)), '2026-10-04'));
check('Scheduling Setup is reachable by name for schedulers and settings managers', () => {
  assert.match(app, /can\(user, 'notification\.manage'\)\) && <button className="btn btn-secondary" onClick=\{\(\) => setTemplatesOpen\(true\)\}>Scheduling Setup<\/button>/);
  assert.match(app, /<Modal title="Scheduling Setup"/);
  assert.match(app, /ww=\{data\.workingWeek\}/, 'the page passes the saved week to the calendar');
  assert.match(app, /setTemplatesOpen\(false\); load\(\);/, 'closing the panel reloads, so a saved week shows at once');
});

console.log(`\n=== UI INTERVIEW CALENDAR: ${pass} passed, ${fail} failed ===\n`);
process.exit(fail ? 1 : 0);
