// Candidate Review: a CV the reader could not find a name in.
//
// Run: node --experimental-sqlite intake_entered_name_test.mjs
//
// Reported on 10.20.0.9 (29 Sep 2026): every pending intake had company,
// position and skills but NO fullName proposal, so "Accept all" → Submit
// always failed with "A candidate cannot be created without an accepted full
// name." and the only way out was to reject the CV. The reviewer can now type
// the name from the CV; the rule that a candidate needs a name is unchanged.
//
// No CV reader is needed: intakes are built directly, exactly as the parser
// stores them.

process.env.DATABASE_URL = 'file:/tmp/arabtec_intake_name_test.db';
process.env.PORT = '4179';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { adminToken, ADMIN_BOOTSTRAP_PASSWORD } from './test-support/admin-session.mjs';
for (const f of ['/tmp/arabtec_intake_name_test.db', '/tmp/arabtec_intake_name_test.db-journal']) {
  try { fs.rmSync(f); } catch { /* first run */ }
}
process.env.SEED_ADMIN_PASSWORD ||= ADMIN_BOOTSTRAP_PASSWORD;

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (err) { failures.push({ name, err }); console.log(`  ✗ ${name}\n      ${err.message}`); }
}

await import('./prisma/seed.js');
await import('./src/server.js');
await new Promise((r) => setTimeout(r, 700));
const { createIntake, reviewIntake, intakeById } = await import('./src/lib/intake-store.js');
const { get: dbGet } = await import('./src/lib/db.js');

const REVIEWER = { id: 1, fullName: 'Test Reviewer' };
const countCandidates = () => dbGet('SELECT COUNT(*) c FROM candidate').c;
let seq = 0;
// The shape found on production: everything but a name.
const nameless = () => createIntake({
  fileName: `scan-${++seq}.pdf`, fileHash: `hash-nameless-${seq}`, createdBy: 1,
  fields: [
    { field: 'currentCompany', value: `Contractor ${seq}`, confidence: 0.8, evidence: 'Worked at' },
    { field: 'currentPosition', value: 'Site Engineer', confidence: 0.8, evidence: 'Site Engineer' },
    { field: 'skills', value: ['AutoCAD', 'Primavera'], confidence: 0.7, evidence: 'Skills:' },
  ],
});
const named = () => createIntake({
  fileName: `named-${++seq}.pdf`, fileHash: `hash-named-${seq}`, createdBy: 1,
  fields: [
    { field: 'fullName', value: `Parsed Name ${seq}`, confidence: 0.9, evidence: 'Name' },
    { field: 'currentPosition', value: 'Planner', confidence: 0.8, evidence: 'Planner' },
  ],
});
const all = (intake, value) => Object.fromEntries(intake.fields.map((f) => [f.field, value]));

console.log('\nCandidate Review — a CV without a readable name\n');

await test('REPORTED: Accept all on a name-less CV is still refused without a name', async () => {
  const intake = nameless();
  const before = countCandidates();
  await assert.rejects(() => reviewIntake(intake.id, all(intake, true), REVIEWER),
    /without an accepted full name/);
  assert.equal(countCandidates(), before);
  assert.equal(intakeById(intake.id).status, 'PENDING', 'the CV must stay reviewable');
});

await test('Accept all + a typed name converts the CV into a candidate', async () => {
  const intake = nameless();
  const result = await reviewIntake(intake.id, all(intake, true), REVIEWER,
    { enteredFullName: '  Karim Mostafa  ' });
  assert.equal(result.status, 'CONVERTED');
  assert.equal(result.candidate.full_name, 'Karim Mostafa', 'the typed name is trimmed and used');
  assert.equal(result.candidate.current_position, 'Site Engineer', 'accepted fields still apply');
  assert.deepEqual(result.entered, ['fullName'], 'the name is recorded as entered by the reviewer');
});

await test('a blank typed name is no name', async () => {
  const intake = nameless();
  await assert.rejects(() => reviewIntake(intake.id, all(intake, true), REVIEWER, { enteredFullName: '   ' }),
    /without an accepted full name/);
});

await test('an absurdly long typed name is refused', async () => {
  const intake = nameless();
  await assert.rejects(() => reviewIntake(intake.id, all(intake, true), REVIEWER,
    { enteredFullName: 'x'.repeat(201) }), /200 characters/);
});

await test('accepting the proposed name AND typing one is refused, not guessed', async () => {
  const intake = named();
  await assert.rejects(() => reviewIntake(intake.id, all(intake, true), REVIEWER,
    { enteredFullName: 'Someone Else' }), /proposed name or type one/);
  assert.equal(intakeById(intake.id).status, 'PENDING');
});

await test('rejecting a wrong proposed name and typing the right one works', async () => {
  const intake = named();
  const result = await reviewIntake(intake.id, { fullName: false, currentPosition: true }, REVIEWER,
    { enteredFullName: 'Corrected Name' });
  assert.equal(result.status, 'CONVERTED');
  assert.equal(result.candidate.full_name, 'Corrected Name');
});

await test('rejecting every field but typing a name creates a name-only candidate', async () => {
  const intake = nameless();
  const result = await reviewIntake(intake.id, all(intake, false), REVIEWER,
    { enteredFullName: 'Name Only' });
  assert.equal(result.status, 'CONVERTED');
  assert.equal(result.candidate.full_name, 'Name Only');
  assert.equal(result.candidate.current_position ?? null, null, 'rejected fields are not applied');
});

await test('rejecting every field with no name still rejects the CV (unchanged)', async () => {
  const intake = nameless();
  const before = countCandidates();
  const result = await reviewIntake(intake.id, all(intake, false), REVIEWER);
  assert.equal(result.status, 'REJECTED');
  assert.equal(countCandidates(), before);
});

/* ------------------------------ over HTTP -------------------------------- */

const B = 'http://localhost:4179';
async function api(p, { method = 'GET', token, body } = {}) {
  const r = await fetch(B + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch { /* empty */ }
  return { status: r.status, json: j };
}
const admin = await adminToken(B);
const recruiter = (await api('/api/auth/login', { method: 'POST', body: { email: 'recruiter@arabtec.com', password: 'Arabtec@123' } })).json.token;

await test('HTTP: the review endpoint takes the typed name as `fullName`', async () => {
  const intake = nameless();
  const r = await api(`/api/candidates/intakes/${intake.id}/review`, { method: 'POST', token: recruiter,
    body: { decisions: all(intake, true), version: intake.version, fullName: 'Typed Over Http' } });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.candidate.fullName, 'Typed Over Http');
});

await test('HTTP: the audit trail says the name was entered by the reviewer', async () => {
  const audit = await api('/api/audit?pageSize=50', { token: admin });
  const created = (audit.json.logs || []).find((l) => l.action === 'candidate.created'
    && /"entered":\["fullName"\]/.test(JSON.stringify(l.newValue ?? l.new_value ?? '')));
  assert.ok(created, 'no candidate.created audit entry records entered: ["fullName"]');
});

await test('HTTP: a non-string fullName is ignored, not trusted', async () => {
  const intake = nameless();
  const r = await api(`/api/candidates/intakes/${intake.id}/review`, { method: 'POST', token: recruiter,
    body: { decisions: all(intake, true), fullName: { $ne: '' } } });
  assert.equal(r.status, 400, JSON.stringify(r.json));
  assert.match(r.json.error, /full name/);
});

/* --------------------------- the review screen --------------------------- */

const screen = fs.readFileSync(new URL('../frontend/public/intake-review.jsx', import.meta.url), 'utf8');
await test('UI: the screen asks for the name when the CV has none or it was rejected', async () => {
  assert.match(screen, /const needsName = !nameProposed \|\| decisions\.fullName === 'REJECT'/);
  assert.match(screen, /'Candidate full name \*'/);
});
await test('UI: the typed name is sent as `fullName` with the review', async () => {
  assert.match(screen, /\.\.\.\(enteredName \? \{ fullName: enteredName \} : \{\}\)/);
});
await test('UI: Submit waits for the name instead of failing after it', async () => {
  assert.match(screen, /disabled: busy \|\| pending > 0 \|\| nameMissing/);
});

const app = fs.readFileSync(new URL('../frontend/public/app.jsx', import.meta.url), 'utf8');
const overlay = app.slice(app.indexOf('function CvParseReviewOverlay'), app.indexOf('function CvParseReviewOverlay') + 6000);
await test('UI: Talent Pool → Parse CV asks for the name too, and sends it', async () => {
  assert.match(overlay, /canSave && !nameProposed && \(/);
  assert.match(overlay, /\.\.\.\(nameProposed \? \{\} : \{ fullName: typedName\.trim\(\) \}\)/);
  assert.match(overlay, /disabled=\{!canSave \|\| saving \|\| nameMissing\}/);
});
await test('UI: View CV opens a side panel beside the review, not a new page', async () => {
  assert.match(screen, /onClick: \(\) => setCvOpen\(\(open\) => !open\)/);
  assert.doesNotMatch(screen.slice(screen.indexOf("'View CV'") - 200, screen.indexOf("'View CV'")), /api\(\)\.download/,
    'View CV must not download the file');
  assert.match(screen, /h\(IntakeCvPanel, \{ id, fileName: intake\.fileName/);
});

console.log(`\n${failures.length === 0 ? '✓' : '✗'} ${passed} passed, ${failures.length} failed\n`);
process.exit(failures.length === 0 ? 0 : 1);
