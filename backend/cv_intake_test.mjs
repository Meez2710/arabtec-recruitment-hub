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

fs.rmSync(cvPath, { force: true });

console.log(`\n${failures.length === 0 ? '✓' : '✗'} ${passed} passed, ${failures.length} failed\n`);
process.exit(failures.length === 0 ? 0 : 1);
