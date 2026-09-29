// Automated intake is for candidates in Egypt (product owner, 29 Sep 2026).
//
// Run: node --experimental-sqlite egypt_rule_test.mjs
//
// A CV the careers mailbox brings in from someone located outside Egypt is
// filed with its reason and never enters the Talent Pool on its own. A CV a
// recruiter uploads by hand is their decision and is not filtered. A CV that
// does not say where the person is, is not excluded.

process.env.DATABASE_URL = 'file:/tmp/arabtec_egypt_rule_test.db';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { ADMIN_BOOTSTRAP_PASSWORD } from './test-support/admin-session.mjs';
for (const f of ['/tmp/arabtec_egypt_rule_test.db', '/tmp/arabtec_egypt_rule_test.db-journal']) {
  try { fs.rmSync(f); } catch { /* first run */ }
}
process.env.SEED_ADMIN_PASSWORD ||= ADMIN_BOOTSTRAP_PASSWORD;

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (err) { failures.push({ name, err }); console.log(`  ✗ ${name}\n      ${err.message}`); }
}

const { egyptVerdict } = await import('./src/lib/cv-intake/egypt-rule.js');
const at = (location, phone) => egyptVerdict(new Map([['location', location], ['phone', phone]]));

console.log('\nWhere the CV says the candidate is\n');
for (const [label, location, phone, outside] of [
  ['Cairo', 'Cairo', null, false],
  ['New Cairo, Egypt', 'New Cairo, Egypt', null, false],
  ['Alexandria', 'Alexandria', null, false],
  ['Arabic: القاهرة', 'القاهرة', null, false],
  ['6th of October City, Giza', '6th of October City, Giza', null, false],
  ['Riyadh, KSA', 'Riyadh, KSA', null, true],
  ['Dubai, UAE', 'Dubai, UAE', '01000000000', true],
  ['Doha, Qatar', 'Doha, Qatar', null, true],
  ['Muscat, Oman', 'Muscat, Oman', null, true],
  ['Amman, Jordan', 'Amman, Jordan', null, true],
  ['Arabic: الرياض، السعودية', 'الرياض، السعودية', null, true],
  ['King Faisal Road, Riyadh (a street name is not Egypt)', 'King Faisal Road, Riyadh', null, true],
  ['both named: Cairo, Egypt — currently Dubai', 'Cairo, Egypt — currently Dubai', null, false],
  ['no location, Saudi mobile only', '', '+966 50 123 4567', true],
  ['no location, UAE 00-prefixed', null, '00971501234567', true],
  ['no location, Egyptian mobile', '', '01000102229', false],
  ['no location, Egyptian + foreign numbers', '', '01000102229 / +971501234567', false],
  ['no location, +20 number', null, '+20 100 555 0142', false],
  ['unknown place', 'Remote', null, false],
  ['nothing at all', null, null, false],
  ['local number with no country code', null, '0501234567', false],
]) {
  await test(`${label} → ${outside ? 'outside' : 'not excluded'}`, async () => {
    assert.equal(at(location, phone).outside, outside);
  });
}

/* --------------------------- the automated path --------------------------- */

process.env.PORT = '4181';
await import('./prisma/seed.js');
await import('./src/server.js');
await new Promise((r) => setTimeout(r, 700));
const { createIntake, intakeById } = await import('./src/lib/intake-store.js');
const { ingestIntake } = await import('./src/lib/cv-intake/auto-ingest.js');
const { get: dbGet } = await import('./src/lib/db.js');
const ACTOR = { id: 1, fullName: 'Mailbox' };
const countCandidates = () => dbGet('SELECT COUNT(*) c FROM candidate').c;
let seq = 0;
const cv = (location, phone) => createIntake({
  fileName: `cv-${++seq}.pdf`, fileHash: `hash-egypt-${seq}`, createdBy: 1,
  fields: [
    { field: 'fullName', value: `Applicant Number ${seq}`, confidence: 0.9, evidence: 'Name' },
    { field: 'email', value: `applicant${seq}@example.test`, confidence: 0.9, evidence: 'Email' },
    ...(location ? [{ field: 'location', value: location, confidence: 0.8, evidence: 'Location' }] : []),
    ...(phone ? [{ field: 'phone', value: phone, confidence: 0.8, evidence: 'Phone' }] : []),
    { field: 'currentPosition', value: 'Site Engineer', confidence: 0.8, evidence: 'Site Engineer' },
  ],
});

console.log('\nThe careers mailbox (automated)\n');

await test('a CV from Riyadh is filed, not added to the Talent Pool', async () => {
  const intake = cv('Riyadh, Saudi Arabia');
  const before = countCandidates();
  const r = await ingestIntake(intake, ACTOR, { egyptOnly: true });
  assert.equal(r.outcome, 'EXCLUDED');
  assert.equal(r.candidateId, null);
  assert.equal(countCandidates(), before, 'a candidate was created');
  const row = intakeById(intake.id);
  assert.equal(row.status, 'REJECTED', 'the intake must leave the review queue');
  assert.equal(row.autoCode, 'outside-egypt');
  assert.match(row.reason, /outside Egypt \(location: Riyadh, Saudi Arabia\)/);
});

await test('a CV with only a foreign phone is filed too', async () => {
  const r = await ingestIntake(cv(null, '+971 50 123 4567'), ACTOR, { egyptOnly: true });
  assert.equal(r.outcome, 'EXCLUDED');
});

await test('a CV from Cairo enters the Talent Pool as before', async () => {
  const before = countCandidates();
  const r = await ingestIntake(cv('Cairo, Egypt'), ACTOR, { egyptOnly: true });
  assert.equal(r.outcome, 'CONVERTED');
  assert.equal(countCandidates(), before + 1);
});

await test('a CV that does not say where the person is, is not excluded', async () => {
  const r = await ingestIntake(cv(null, null), ACTOR, { egyptOnly: true });
  assert.equal(r.outcome, 'CONVERTED');
});

await test('a recruiter\'s own upload is not filtered (no egyptOnly)', async () => {
  const r = await ingestIntake(cv('Dubai, UAE'), ACTOR);
  assert.equal(r.outcome, 'CONVERTED');
});

await test('both mailbox entrances (arrival and backlog) apply the rule', async () => {
  const src = fs.readFileSync(new URL('./src/lib/microsoft/mailbox-sync.js', import.meta.url), 'utf8');
  assert.equal((src.match(/ingestIntake\([^)]*\{ egyptOnly: true \}\)/g) || []).length, 2);
  const routes = fs.readFileSync(new URL('./src/routes/candidates.js', import.meta.url), 'utf8');
  assert.doesNotMatch(routes, /egyptOnly/, 'manual uploads must not be filtered');
});

console.log(`\n${failures.length === 0 ? '✓' : '✗'} ${passed} passed, ${failures.length} failed\n`);
process.exit(failures.length === 0 ? 0 : 1);
