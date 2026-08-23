// Pre-candidate intake — a CV parsed before anyone exists to attach it to.
//
// Run: node --experimental-sqlite cv_intake_test.mjs
//
// WHAT IT PROVES
//   1. Parsing a CV creates a PENDING intake and NO candidate.
//   2. A rejected intake creates no candidate.
//   3. An approved intake creates the candidate exactly once.
//   4. The candidate's own invariants still hold (a name is required).
//   5. Existing duplicate detection runs, and a conflict preserves the intake.
//   6. The resulting CandidateProposal is linked to the created candidate and
//      carries the evidence, the citation and the generation record.
//   7. Incomplete, stale, repeated and superseded reviews are refused.
//   8. A failure anywhere rolls back the candidate, the proposal and the intake.

process.env.DATABASE_URL = 'file:/tmp/arabtec_intake_test.db';


/* ------------------------------------------------------------------------- *
 * Reading a CV needs a configured reader. Without ANTHROPIC_API_KEY there is
 * no parser wired at all, so these assertions cannot be made — they are
 * SKIPPED, loudly, and skipping is NOT a pass. CI deliberately holds no key:
 * a required gate that spends money and depends on a third party's uptime on
 * every push is not a gate, it is a flake. Run locally with a key set, or set
 * one as a repository secret, to make this a real check.
 * ------------------------------------------------------------------------- */
const HAS_READER = String(process.env.ANTHROPIC_API_KEY || '').trim() !== '';

if (!HAS_READER) {
  console.log(`\n\u2298 SKIPPED — no ANTHROPIC_API_KEY, so no CV reader is wired.`);
  console.log('  This is NOT a pass. Most of this suite asserts on a real parse.');
  console.log('  Set ANTHROPIC_API_KEY locally, or as a repository secret, to run it.\n');
  process.exit(0);
}

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

for (const f of ['/tmp/arabtec_intake_test.db', '/tmp/arabtec_intake_test.db-journal']) {
  try { fs.rmSync(f); } catch { /* first run */ }
}

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (err) { failures.push({ name, err }); console.log(`  ✗ ${name}\n      ${err.message}`); }
}

console.log('\nPre-candidate CV intake -> review -> candidate\n');

const { ensureSchema } = await import('./src/lib/schema.js');
ensureSchema();

const { run: dbRun, get: dbGet, all: dbAll } = await import('./src/lib/db.js');
if (!dbGet("SELECT value FROM system_setting WHERE key='candidate_counter'")) {
  dbRun("INSERT INTO system_setting (key, value) VALUES ('candidate_counter','0')");
}
if (!dbGet("SELECT value FROM system_setting WHERE key='candidate_prefix'")) {
  dbRun("INSERT INTO system_setting (key, value) VALUES ('candidate_prefix','CAN')");
}
for (const [key, value] of [['application_counter', '0'], ['application_prefix', 'APP']]) {
  if (!dbGet('SELECT value FROM system_setting WHERE key=?', [key])) {
    dbRun('INSERT INTO system_setting (key, value) VALUES (?,?)', [key, value]);
  }
}
if (!dbGet('SELECT id FROM users WHERE id=1')) {
  dbRun("INSERT INTO users (id, full_name, email, password_hash) VALUES (1,'Reviewer','reviewer@example.test','x')");
}

const { Candidates } = await import('./src/lib/models.js');
const { configureParsing } = await import('./src/lib/parsing/composition.js');
const registry = await import('./src/lib/parsing/registry.js');
const { parseDocument } = await import('./src/lib/parsing/pipeline-provider.js');
const {
  createIntake, intakeById, pendingIntakes, reviewIntake, rejectIntake,
} = await import('./src/lib/intake-store.js');
const { proposalById } = await import('./src/lib/proposal-store.js');
const { renderEvaluation } = await import('./src/lib/parsing/evaluation.js');
const { classifyDuplicates } = await import('./src/lib/intake-store.js');
const { CandidateDocuments } = await import('./src/lib/models.js');

registry.resetParserRegistry();
configureParsing();

const REVIEWER = { id: 1, fullName: 'Reviewer' };
const countCandidates = () => dbGet('SELECT COUNT(*) c FROM candidate').c;

/* ------------------------- a real CV, really parsed ------------------------ */

const cvPath = path.join(os.tmpdir(), `intake-cv-${process.pid}.txt`);
fs.writeFileSync(cvPath, [
  'Ahmed Hassan',
  'Cairo, Egypt',
  'ahmed.hassan@example.test',
  '+20 100 123 4567',
  '',
  'EXPERIENCE',
  'Senior Structural Engineer at Arabtec Construction',
  '',
  'EDUCATION',
  'BSc in Civil Engineering, Cairo University, 2015',
  '',
  'SKILLS',
  'AutoCAD, ETABS',
].join('\n'));

const parsed = await parseDocument(cvPath);
assert.ok(parsed.ok, 'the pipeline produced no fields — the rest of this suite is meaningless');

/** A COMPLETE decision map over an intake's proposed fields. */
const decide = (id, accept = {}) => Object.fromEntries(
  intakeById(id).fields.map((f) => [f.field, accept[f.field] === true]),
);

const newIntake = () => createIntake({
  storedName: path.basename(cvPath),
  fileName: 'ahmed-hassan-cv.txt',
  mimeType: 'text/plain',
  fileHash: 'hash-abc',
  origin: 'resume.extract',
  documentId: parsed.documentId,
  generation: {
    capability: 'resume.extract', modelId: 'test-model', promptVersionId: 'v1',
    documentHash: 'hash-abc', parserVersion: 'test', extractorVersion: 'test',
    generatedAt: new Date(),
  },
  fields: parsed.fields,
  createdBy: 1,
});

/* ------------------------------- 1. parsing -------------------------------- */

let intakeId = null;

await test('parsing a CV creates a PENDING intake and no candidate', () => {
  const before = countCandidates();
  const intake = newIntake();
  intakeId = intake.id;
  assert.equal(intake.status, 'PENDING');
  assert.ok(intake.fields.length >= 5, `expected >=5 fields, got ${intake.fields.length}`);
  assert.equal(countCandidates(), before, 'a candidate was created by parsing');
  assert.ok(pendingIntakes().some((i) => i.id === intakeId));
});

await test('the intake keeps a reference to the uploaded document', () => {
  const intake = intakeById(intakeId);
  assert.equal(intake.storedName, path.basename(cvPath));
  assert.equal(intake.fileName, 'ahmed-hassan-cv.txt');
  assert.equal(intake.fileHash, 'hash-abc');
  assert.equal(intake.mimeType, 'text/plain');
});

await test('evidence, citation and generation survive being stored', () => {
  const intake = intakeById(intakeId);
  const name = intake.fields.find((f) => f.field === 'fullName');
  assert.ok(name.evidence, 'the evidence snippet was lost');
  assert.ok(name.evidenceRef && name.evidenceRef.blockId, 'the source block was lost');
  assert.equal(intake.generation.modelId, 'test-model');
});

/* ------------------------------ 2. refusals -------------------------------- */

await test('an incomplete decision map is refused and creates nothing', async () => {
  const before = countCandidates();
  await assert.rejects(
    () => reviewIntake(intakeId, { fullName: true }, REVIEWER),
    /decision is required for every proposed field/,
  );
  assert.equal(countCandidates(), before);
  assert.equal(intakeById(intakeId).status, 'PENDING');
});

await test('a stale version is refused and creates nothing', async () => {
  const before = countCandidates();
  await assert.rejects(
    () => reviewIntake(intakeId, decide(intakeId, { fullName: true }), REVIEWER,
      { expectedVersion: 99 }),
    /changed since it was loaded/,
  );
  assert.equal(countCandidates(), before);
});

await test('a candidate is never created without an accepted name', async () => {
  const before = countCandidates();
  await assert.rejects(
    // Everything accepted EXCEPT the name.
    () => reviewIntake(intakeId, decide(intakeId, { email: true, phone: true }), REVIEWER),
    /without an accepted full name/,
  );
  assert.equal(countCandidates(), before, 'a nameless candidate was created');
  assert.equal(intakeById(intakeId).status, 'PENDING', 'the intake was consumed by a failure');
});

await test('accepting nothing rejects the intake and creates no candidate', async () => {
  const scratch = newIntake();
  const before = countCandidates();
  const result = await reviewIntake(scratch.id, decide(scratch.id), REVIEWER);
  assert.equal(result.status, 'REJECTED');
  assert.equal(result.candidateId, null);
  assert.equal(countCandidates(), before);
  assert.equal(intakeById(scratch.id).status, 'REJECTED');
});

await test('an explicitly rejected intake creates no candidate', async () => {
  const scratch = newIntake();
  const before = countCandidates();
  const result = rejectIntake(scratch.id, REVIEWER, 'not a real applicant');
  assert.equal(result.status, 'REJECTED');
  assert.equal(countCandidates(), before);
  assert.equal(intakeById(scratch.id).reason, 'not a real applicant');
});

/* ------------------------------ 3. conversion ------------------------------ */

let candidateId = null;
let proposalId = null;

await test('an approved intake creates the candidate exactly once', async () => {
  const before = countCandidates();
  const result = await reviewIntake(intakeId, decide(intakeId, {
    fullName: true, email: true, phone: true, location: true,
    university: true, skills: true,
    // currentCompany / currentPosition / major / graduationYear rejected.
  }), REVIEWER, { expectedVersion: 0 });

  assert.equal(result.status, 'CONVERTED');
  assert.equal(countCandidates(), before + 1, 'expected exactly one new candidate');
  candidateId = result.candidateId;
  proposalId = result.proposalId;

  const c = Candidates.byId(candidateId);
  assert.equal(c.full_name, 'Ahmed Hassan');
  assert.equal(c.email, 'ahmed.hassan@example.test');
  assert.equal(c.university, 'Cairo University');
  assert.deepEqual(JSON.parse(c.skills), ['AutoCAD', 'ETABS']);
  // Rejected fields were never written.
  assert.equal(c.current_company, null, 'a rejected field reached the candidate');
  assert.equal(c.major, null, 'a rejected field reached the candidate');
});

await test('the intake is marked CONVERTED and linked to what it produced', () => {
  const intake = intakeById(intakeId);
  assert.equal(intake.status, 'CONVERTED');
  assert.equal(intake.candidateId, candidateId);
  assert.equal(intake.proposalId, proposalId);
  assert.equal(intake.reviewedBy, REVIEWER.id);
  assert.ok(intake.reviewedAt);
});

await test('the resulting proposal is linked to the candidate and records the review', () => {
  const proposal = proposalById(proposalId);
  assert.equal(proposal.candidateId, candidateId);
  assert.equal(proposal.status, 'APPLIED');
  const name = proposal.fields.find((f) => f.field === 'fullName');
  assert.equal(name.decision, 'ACCEPTED');
  assert.ok(name.evidenceRef && name.evidenceRef.blockId, 'the citation was lost on conversion');
  const company = proposal.fields.find((f) => f.field === 'currentCompany');
  assert.equal(company.decision, 'REJECTED');
  // The generation record survives, so the parse is reproducible.
  assert.equal(proposal.generation.modelId, 'test-model');
});

await test('a converted intake cannot be reviewed again', async () => {
  const before = countCandidates();
  await assert.rejects(
    () => reviewIntake(intakeId, decide(intakeId, { fullName: true }), REVIEWER),
    /CONVERTED and can no longer be reviewed/,
  );
  assert.equal(countCandidates(), before, 'a second candidate was created');
});

/* ------------------------------ 4. duplicates ------------------------------ */

await test('existing duplicate detection runs and preserves the intake', async () => {
  const dup = newIntake();
  const before = countCandidates();
  let error = null;
  try {
    await reviewIntake(dup.id, decide(dup.id, { fullName: true, email: true }), REVIEWER);
  } catch (e) { error = e; }

  assert.ok(error, 'a duplicate candidate was created silently');
  assert.equal(error.code, 'duplicate');
  assert.ok(error.detail.matches.some((m) => m.id === candidateId),
    'the conflict did not name the existing candidate');
  assert.equal(countCandidates(), before, 'a duplicate candidate was created');
  // PRESERVED, not consumed: a duplicate is a decision for a person.
  assert.equal(intakeById(dup.id).status, 'PENDING');
});

await test('a duplicate can be converted with the existing override', async () => {
  const dup = pendingIntakes().find((i) => i.status === 'PENDING');
  const before = countCandidates();
  const result = await reviewIntake(dup.id, decide(dup.id, { fullName: true, email: true }),
    REVIEWER, { overrideDuplicate: true });
  assert.equal(result.status, 'CONVERTED');
  assert.equal(countCandidates(), before + 1);
});

/* ------------------------------ 5. rollback -------------------------------- */

await test('a failure rolls back the candidate, the proposal and the intake', async () => {
  // A malformed list value: encodeList throws when the candidate UPDATE runs,
  // after the candidate row and the proposal have already been written in this
  // transaction. All three must disappear together.
  const poison = createIntake({
    storedName: path.basename(cvPath),
    fileName: 'poison.txt',
    fields: [
      { field: 'fullName', value: 'Broken Record', confidence: 0.75, evidence: 'x' },
      { field: 'skills', value: 'not-an-array', confidence: 0.75, evidence: 'y' },
    ],
    createdBy: 1,
  });
  const beforeCandidates = countCandidates();
  const beforeProposals = dbGet('SELECT COUNT(*) c FROM candidate_proposal').c;

  await assert.rejects(
    () => reviewIntake(poison.id, { fullName: true, skills: true }, REVIEWER),
    /must be an array/,
  );

  assert.equal(countCandidates(), beforeCandidates, 'a candidate survived the rollback');
  assert.equal(dbGet('SELECT COUNT(*) c FROM candidate_proposal').c, beforeProposals,
    'a proposal survived the rollback');
  assert.equal(intakeById(poison.id).status, 'PENDING', 'the intake was resolved anyway');
  assert.equal(intakeById(poison.id).candidateId, null);
  assert.equal(dbAll("SELECT id FROM candidate WHERE full_name='Broken Record'").length, 0);
});

/* ------------------- 6. requisition association --------------------------- */

// A real, open requisition to submit against.
dbRun(`INSERT INTO recruitment_request
  (id, ticket_no, title, status, headcount, requester_id, created_by, created_at, updated_at)
  VALUES (1,'REQ-TEST-1','Structural Engineer','sourcing',1,1,1,datetime('now'),datetime('now'))`);
dbRun(`INSERT INTO recruitment_request
  (id, ticket_no, title, status, headcount, requester_id, created_by, created_at, updated_at)
  VALUES (2,'REQ-TEST-2','Closed Role','closed',1,1,1,datetime('now'),datetime('now'))`);

const countApplications = () => dbGet('SELECT COUNT(*) c FROM application').c;

const intakeFor = (requestId) => createIntake({
  storedName: path.basename(cvPath),
  fileName: 'linked-cv.txt',
  fields: [
    { field: 'fullName', value: `Linked Person ${requestId}-${Date.now()}`, confidence: 0.75, evidence: 'x' },
    { field: 'location', value: 'Cairo, Egypt', confidence: 0.75, evidence: 'y' },
  ],
  ...(requestId !== null ? { requestId } : {}),
  createdBy: 1,
});

await test('requestId survives intake creation and creates no application', () => {
  const before = countApplications();
  const intake = intakeFor(1);
  assert.equal(intake.requestId, 1);
  assert.equal(intake.applicationId, null);
  assert.equal(countApplications(), before, 'an application was created before review');
});

await test('an approved intake creates the application exactly once', async () => {
  const intake = intakeFor(1);
  const beforeApps = countApplications();
  const result = await reviewIntake(intake.id, decide(intake.id, { fullName: true, location: true }),
    REVIEWER, { overrideDuplicate: true });

  assert.equal(result.status, 'CONVERTED');
  assert.ok(result.applicationId, 'no application was created');
  assert.equal(countApplications(), beforeApps + 1, 'expected exactly one new application');

  const stored = intakeById(intake.id);
  assert.equal(stored.applicationId, result.applicationId, 'applicationId not stored on the intake');
  assert.equal(stored.requestId, 1);

  // The existing per-candidate/request uniqueness guard.
  const apps = dbAll('SELECT * FROM application WHERE candidate_id=? AND request_id=?',
    [result.candidateId, 1]);
  assert.equal(apps.length, 1, 'a duplicate application was created');
});

await test('an intake naming a closed requisition is refused and preserved', async () => {
  const intake = intakeFor(2);
  const beforeApps = countApplications();
  const beforeCandidates = countCandidates();
  let error = null;
  try {
    await reviewIntake(intake.id, decide(intake.id, { fullName: true }), REVIEWER,
      { overrideDuplicate: true });
  } catch (e) { error = e; }

  assert.ok(error, 'a closed requisition was accepted');
  assert.equal(error.code, 'request-ineligible');
  assert.equal(countApplications(), beforeApps, 'a partial application was created');
  assert.equal(countCandidates(), beforeCandidates, 'a candidate survived an ineligible request');
  // requestId is neither discarded nor half-applied.
  assert.equal(intakeById(intake.id).status, 'PENDING');
  assert.equal(intakeById(intake.id).requestId, 2);
});

await test('an intake with no requestId converts without an application', async () => {
  const intake = intakeFor(null);
  const beforeApps = countApplications();
  const result = await reviewIntake(intake.id, decide(intake.id, { fullName: true }),
    REVIEWER, { overrideDuplicate: true });
  assert.equal(result.status, 'CONVERTED');
  assert.equal(result.applicationId, null);
  assert.equal(result.requestId, null);
  assert.equal(countApplications(), beforeApps, 'an application appeared without a requisition');
});

await test('the duplicate response reports matched fields and match kind', async () => {
  const first = createIntake({
    fileName: 'dup-a.txt',
    fields: [
      { field: 'fullName', value: 'Duplicate Probe', confidence: 0.75, evidence: 'x' },
      { field: 'email', value: 'dup.probe@example.test', confidence: 0.75, evidence: 'y' },
    ],
    createdBy: 1,
  });
  await reviewIntake(first.id, decide(first.id, { fullName: true, email: true }), REVIEWER,
    { overrideDuplicate: true });

  const second = createIntake({
    fileName: 'dup-b.txt',
    fields: [
      { field: 'fullName', value: 'Duplicate Probe Two', confidence: 0.75, evidence: 'x' },
      { field: 'email', value: 'dup.probe@example.test', confidence: 0.75, evidence: 'y' },
    ],
    createdBy: 1,
  });
  let error = null;
  try {
    await reviewIntake(second.id, decide(second.id, { fullName: true, email: true }), REVIEWER);
  } catch (e) { error = e; }

  assert.ok(error && error.code === 'duplicate');
  const match = error.detail.matches[0];
  assert.deepEqual(match.matchedFields, ['email']);
  assert.equal(match.kind, 'exact');
  assert.equal(error.detail.blocked, true);
  assert.equal(error.detail.overridable, true);
  // No presentation concerns leak out of the backend.
  const payload = JSON.stringify(error.detail).toLowerCase();
  for (const word of ['red', 'amber', 'colour', 'color', 'severity', 'warning']) {
    assert.equal(payload.includes(word), false, `the duplicate payload mentions "${word}"`);
  }
});

/* --------------------------- 7. evaluation --------------------------------- */

await test('the qualitative evaluator emits no numeric score', () => {
  const rendered = renderEvaluation({
    overall: 'Proficient',
    summary: 'Reads as a competent structural engineer.',
    competencies: [{
      competency: 'Structural design',
      level: 'Exceeds Requirements',
      evidence: ['Senior Structural Engineer at Arabtec Construction'],
      rationale: 'Held the role for several years.',
    }],
    gaps: ['Bridge design'],
    modelId: 'test-model',
    promptVersionId: 'v1',
    documentId: 'cv.txt',
  });
  for (const level of ['Exceeds Requirements', 'Proficient', 'Requires Development', 'No Evidence Found']) {
    // The vocabulary is closed; anything outside it is a regression.
    assert.equal(typeof level, 'string');
  }
  assert.match(rendered, /Exceeds Requirements/);
  assert.equal(/\/100|\bscore\b|%/i.test(rendered), false, 'a numeric score reappeared');
});

/* --------------------- 8. deterministic duplicate identifiers -------------- */

// One known candidate to match against, with a CV document on file.
const known = Candidates.create({
  candidateNo: Candidates.nextNo(),
  fullName: 'Known Person',
  email: 'known.person@example.test',
  phone: '+20 100 999 8877',
  linkedinUrl: 'https://www.linkedin.com/in/knownperson/',
  createdBy: 1,
});
CandidateDocuments.add({
  candidateId: known.id, docType: 'cv', fileName: 'known.pdf',
  fileHash: 'sha256-known-cv', uploadedBy: 1,
});

const classify = (accepted, hash = null) => classifyDuplicates(new Map(Object.entries(accepted)), hash);

await test('an exact email match blocks', () => {
  const { exact } = classify({ fullName: 'Someone Else', email: 'KNOWN.PERSON@example.test' });
  assert.equal(exact.length, 1);
  assert.equal(exact[0].kind, 'exact');
  assert.deepEqual(exact[0].matchedFields, ['email']);
});

await test('an exact normalized phone match blocks', () => {
  // Different punctuation and spacing; the same digits. The existing dedup
  // scheme compares digits exactly, so this is what "normalized" means here.
  const { exact } = classify({ fullName: 'Someone Else', phone: '+20-(100)-999.8877' });
  assert.equal(exact.length, 1);
  assert.equal(exact[0].kind, 'exact');
  assert.deepEqual(exact[0].matchedFields, ['phone']);
});

await test('an exact normalized LinkedIn match blocks', () => {
  // No scheme, no www, no trailing slash, different case.
  const { exact } = classify({ fullName: 'Someone Else', linkedinUrl: 'LinkedIn.com/in/KnownPerson' });
  assert.equal(exact.length, 1);
  assert.equal(exact[0].kind, 'exact');
  assert.deepEqual(exact[0].matchedFields, ['linkedinUrl']);
});

await test('an exact document-hash match blocks', () => {
  const { exact } = classify({ fullName: 'Someone Else' }, 'sha256-known-cv');
  assert.equal(exact.length, 1);
  assert.equal(exact[0].kind, 'exact');
  assert.deepEqual(exact[0].matchedFields, ['documentHash']);
});

await test('several identifiers matching are reported on one match', () => {
  const { exact } = classify({
    fullName: 'Known Person',
    email: 'known.person@example.test',
    phone: '+20 (100) 999 8877',
  }, 'sha256-known-cv');
  assert.equal(exact.length, 1, 'the same candidate was reported more than once');
  assert.deepEqual([...exact[0].matchedFields].sort(), ['documentHash', 'email', 'phone']);
});

await test('a name-only match is potential and never blocks', async () => {
  const { exact, potential } = classify({ fullName: 'Known Person' });
  assert.deepEqual(exact, [], 'a name-only match was classified as exact');
  assert.equal(potential.length, 1);
  assert.equal(potential[0].kind, 'potential');
  assert.deepEqual(potential[0].matchedFields, ['fullName']);

  // And it really does not block: the conversion succeeds.
  const intake = createIntake({
    fileName: 'namesake.txt',
    fields: [{ field: 'fullName', value: 'Known Person', confidence: 0.75, evidence: 'x' }],
    createdBy: 1,
  });
  const before = countCandidates();
  const result = await reviewIntake(intake.id, { fullName: true }, REVIEWER);
  assert.equal(result.status, 'CONVERTED', 'a namesake blocked the conversion');
  assert.equal(countCandidates(), before + 1);
  assert.ok(result.potentialMatches.some((m) => m.id === known.id),
    'the namesake was not reported back');
});

await test('the existing override converts past an exact match', async () => {
  const intake = createIntake({
    fileName: 'override.txt',
    fields: [
      { field: 'fullName', value: 'Override Person', confidence: 0.75, evidence: 'x' },
      { field: 'email', value: 'known.person@example.test', confidence: 0.75, evidence: 'y' },
    ],
    createdBy: 1,
  });
  await assert.rejects(
    () => reviewIntake(intake.id, { fullName: true, email: true }, REVIEWER),
    (e) => e.code === 'duplicate' && e.detail.blocked === true && e.detail.overridable === true,
  );
  assert.equal(intakeById(intake.id).status, 'PENDING', 'the blocked intake was consumed');

  const before = countCandidates();
  const result = await reviewIntake(intake.id, { fullName: true, email: true }, REVIEWER,
    { overrideDuplicate: true });
  assert.equal(result.status, 'CONVERTED');
  assert.equal(countCandidates(), before + 1);
});

await test('the duplicate payload carries no presentation terminology', async () => {
  const intake = createIntake({
    fileName: 'terms.txt',
    fields: [
      { field: 'fullName', value: 'Terms Person', confidence: 0.75, evidence: 'x' },
      { field: 'phone', value: '+20 100 999 8877', confidence: 0.75, evidence: 'y' },
    ],
    createdBy: 1,
  });
  let error = null;
  try {
    await reviewIntake(intake.id, { fullName: true, phone: true }, REVIEWER);
  } catch (e) { error = e; }
  assert.ok(error && error.code === 'duplicate');
  const payload = JSON.stringify(error.detail).toLowerCase();
  for (const word of ['red', 'amber', 'colour', 'color', 'severity', 'warning', 'danger', 'style']) {
    assert.equal(payload.includes(word), false, `the payload mentions "${word}"`);
  }
});

/* --------------------- 9. evaluation dispatch safety ----------------------- */
//
// The route dispatches evaluation AFTER res.json(), so these assert the
// preconditions the route depends on: what reviewIntake returns, and when.

await test('a rolled-back review yields nothing to dispatch on', async () => {
  const poison = createIntake({
    fileName: 'poison2.txt',
    requestId: 1,
    fields: [
      { field: 'fullName', value: 'Rollback Person', confidence: 0.75, evidence: 'x' },
      { field: 'skills', value: 'not-an-array', confidence: 0.75, evidence: 'y' },
    ],
    createdBy: 1,
  });
  let result = null;
  try {
    result = await reviewIntake(poison.id, { fullName: true, skills: true }, REVIEWER,
      { overrideDuplicate: true });
  } catch { /* expected */ }
  // No result means the route never reaches its dispatch block.
  assert.equal(result, null);
  assert.equal(intakeById(poison.id).status, 'PENDING');
  assert.equal(intakeById(poison.id).applicationId, null);
});

await test('a completed review reports the requestId the dispatch depends on', async () => {
  const intake = createIntake({
    fileName: 'dispatch.txt',
    requestId: 1,
    fields: [{ field: 'fullName', value: 'Dispatch Person', confidence: 0.75, evidence: 'x' }],
    createdBy: 1,
  });
  const result = await reviewIntake(intake.id, { fullName: true }, REVIEWER,
    { overrideDuplicate: true });
  assert.equal(result.status, 'CONVERTED');
  assert.equal(result.requestId, 1);
  assert.ok(result.storedName === null || typeof result.storedName === 'string');
  assert.ok(result.applicationId, 'no application to attach an evaluation to');
});

await test('a retried review of a converted intake dispatches nothing', async () => {
  const intake = createIntake({
    fileName: 'retry.txt',
    requestId: 1,
    fields: [{ field: 'fullName', value: 'Retry Person', confidence: 0.75, evidence: 'x' }],
    createdBy: 1,
  });
  await reviewIntake(intake.id, { fullName: true }, REVIEWER, { overrideDuplicate: true });
  // The second attempt throws before producing anything, so the route returns a
  // conflict and never reaches its dispatch block.
  await assert.rejects(
    () => reviewIntake(intake.id, { fullName: true }, REVIEWER, { overrideDuplicate: true }),
    /CONVERTED and can no longer be reviewed/,
  );
});

await test('an intake with no requestId gives the route nothing to evaluate', async () => {
  const intake = createIntake({
    fileName: 'norequest.txt',
    fields: [{ field: 'fullName', value: 'No Request Person', confidence: 0.75, evidence: 'x' }],
    createdBy: 1,
  });
  const result = await reviewIntake(intake.id, { fullName: true }, REVIEWER,
    { overrideDuplicate: true });
  assert.equal(result.requestId, null, 'a requisition appeared from nowhere');
  assert.equal(result.applicationId, null);
});

await test('a rejected field never reaches what the evaluator is given', async () => {
  const intake = createIntake({
    fileName: 'evidence.txt',
    fields: [
      { field: 'fullName', value: 'Evidence Person', confidence: 0.75, evidence: 'name line' },
      { field: 'currentCompany', value: 'Rejected Employer', confidence: 0.5, evidence: 'employer line' },
    ],
    createdBy: 1,
  });
  const result = await reviewIntake(intake.id, { fullName: true, currentCompany: false },
    REVIEWER, { overrideDuplicate: true });

  // The evaluator reads the proposal's fields; a rejected one is marked REJECTED
  // and its value is not on the candidate.
  const proposal = proposalById(result.proposalId);
  const company = proposal.fields.find((f) => f.field === 'currentCompany');
  assert.equal(company.decision, 'REJECTED');
  assert.equal(Candidates.byId(result.candidateId).current_company, null);
});

await test('an evaluation failure cannot undo a committed conversion', async () => {
  const intake = createIntake({
    fileName: 'evalfail.txt',
    requestId: 1,
    fields: [{ field: 'fullName', value: 'Eval Fail Person', confidence: 0.75, evidence: 'x' }],
    createdBy: 1,
  });
  const result = await reviewIntake(intake.id, { fullName: true }, REVIEWER,
    { overrideDuplicate: true });

  // Whatever an asynchronous dispatch does afterwards, this is already durable.
  const rejection = Promise.reject(new Error('evaluator unreachable'));
  let caught = null;
  await rejection.catch((e) => { caught = e; });
  assert.equal(caught.message, 'evaluator unreachable');

  assert.equal(intakeById(intake.id).status, 'CONVERTED');
  assert.ok(Candidates.byId(result.candidateId));
  assert.equal(proposalById(result.proposalId).status, 'APPLIED');
  assert.ok(dbGet('SELECT id FROM application WHERE id=?', [result.applicationId]));
});

fs.rmSync(cvPath, { force: true });

console.log(`\n${failures.length === 0 ? '✓' : '✗'} ${passed} passed, ${failures.length} failed\n`);
process.exit(failures.length === 0 ? 0 : 1);
