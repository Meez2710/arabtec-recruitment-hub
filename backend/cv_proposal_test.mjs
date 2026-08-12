// Production-path proposal lifecycle — CV to candidate record, through review.
//
// Run: node --experimental-sqlite cv_proposal_test.mjs
//
// Same style as parser_seam_test.mjs: no server boot, a real database. This is
// about the boundary between a parse and a candidate record, so it exercises the
// registry, the proposal repository and the existing candidate persistence
// directly. Booting Express would only test Express.
//
// WHAT IT PROVES
//   1. A CV enters the new pipeline and comes out with evidence.
//   2. A proposal persists, and starts PENDING.
//   3. A PENDING proposal does not touch the candidate record.
//   4. Only ACCEPTED fields reach the candidate.
//   5. Everything else on the candidate is left exactly as it was.
//   6. A proposal cannot be reviewed twice.

process.env.DATABASE_URL = 'file:/tmp/arabtec_proposal_test.db';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

for (const f of ['/tmp/arabtec_proposal_test.db', '/tmp/arabtec_proposal_test.db-journal']) {
  try { fs.rmSync(f); } catch { /* first run */ }
}

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (err) { failures.push({ name, err }); console.log(`  ✗ ${name}\n      ${err.message}`); }
}

console.log('\nCV parse -> proposal -> approved candidate fields\n');

const { ensureSchema } = await import('./src/lib/schema.js');
ensureSchema();

// The candidate numbering counter is normally seeded by prisma/seed.js. This
// suite needs a database, not a seeded application, so it inserts only that.
const { run: dbRun, get: dbGet } = await import('./src/lib/db.js');
if (!dbGet("SELECT value FROM system_setting WHERE key='candidate_counter'")) {
  dbRun("INSERT INTO system_setting (key, value) VALUES ('candidate_counter','0')");
}
// A real reviewer row: `reviewed_by` is a foreign key, because a proposal must
// always name the human who resolved it.
if (!dbGet('SELECT id FROM users WHERE id=1')) {
  dbRun("INSERT INTO users (id, full_name, email, password_hash) VALUES (1,'Reviewer','reviewer@example.test','x')");
}

const { Candidates } = await import('./src/lib/models.js');
const { configureParsing } = await import('./src/lib/parsing/composition.js');
const registry = await import('./src/lib/parsing/registry.js');
const { raiseProposal, pendingProposal, proposalById, reviewProposal } =
  await import('./src/lib/proposal-store.js');

registry.resetParserRegistry();
configureParsing();

const REVIEWER = { id: 1, fullName: 'Reviewer' };

/* -------------------- 1. a CV goes through the pipeline -------------------- */

const cvPath = path.join(os.tmpdir(), `proposal-cv-${process.pid}.txt`);
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
].join('\n'));

let parsedFields = [];

await test('a CV enters the pipeline and every field carries evidence', async () => {
  const rich = await registry.getParser().parseEntities(cvPath);
  assert.equal(rich.metadata.parsed_by, 'document-pipeline');
  assert.equal(rich.personal.full_name.value, 'Ahmed Hassan');
  assert.ok(rich.personal.full_name.source.blockId, 'no source block on the name');

  // The same parse, as the proposable field list a proposal is raised from.
  const { parseDocument } = await import('./src/lib/parsing/pipeline-provider.js');
  const result = await parseDocument(cvPath);
  assert.ok(result.ok, 'the pipeline did not produce fields');
  parsedFields = result.fields;
  assert.ok(parsedFields.length >= 5, `expected >=5 fields, got ${parsedFields.length}`);
  for (const f of parsedFields) {
    assert.ok(f.evidence, `${f.field} has no evidence snippet`);
    assert.ok(f.evidenceRef && f.evidenceRef.blockId, `${f.field} has no source block`);
  }
});

/* ------------------- 2. a candidate, then a proposal ----------------------- */

const candidateNo = Candidates.nextNo();
const candidate = Candidates.create({
  candidateNo,
  fullName: 'Ahmed Hassan',
  email: 'ahmed.hassan@example.test',
  source: 'cv_parse',
  createdBy: null,
});

let proposalId = null;

await test('a proposal persists and starts PENDING', async () => {
  const raised = await raiseProposal({
    candidateId: candidate.id,
    origin: 'resume.extract',
    documentId: path.basename(cvPath),
    modelId: 'test-model',
    generation: {
      capability: 'resume.extract', modelId: 'test-model', promptVersionId: 'v1',
      documentHash: null, parserVersion: 'test', extractorVersion: 'test',
      generatedAt: new Date(),
    },
    fields: parsedFields,
  });
  assert.ok(raised, 'no proposal was raised');
  proposalId = raised.id;
  assert.equal(raised.status, 'PENDING');

  const stored = proposalById(proposalId);
  assert.equal(stored.status, 'PENDING');
  assert.ok(stored.fields.length > 0, 'the stored proposal has no fields');
  for (const f of stored.fields) assert.equal(f.decision, 'PENDING');
});

await test('the citation survives the round trip through the database', () => {
  const stored = proposalById(proposalId);
  const name = stored.fields.find((f) => f.field === 'fullName');
  assert.ok(name, 'fullName is not on the proposal');
  assert.ok(name.evidence, 'the evidence snippet was lost');
  assert.ok(name.evidenceRef && name.evidenceRef.blockId, 'the source block was lost');
});

await test('a proposal only ever holds fields the candidate may accept', () => {
  const stored = proposalById(proposalId);
  // The aggregate's whitelist. `degree` is extracted but is not proposable.
  assert.equal(stored.fields.some((f) => f.field === 'degree'), false);
});

/* ------------- 3. a PENDING proposal changes nothing at all ---------------- */

await test('a PENDING proposal does not touch the candidate record', () => {
  const row = Candidates.byId(candidate.id);
  assert.equal(row.university, null, 'university was written without review');
  assert.equal(row.current_company, null, 'current_company was written without review');
  assert.equal(row.location, null, 'location was written without review');
  assert.ok(pendingProposal(candidate.id), 'the proposal is no longer pending');
});

/* --------------------- 4. review applies ONLY what was accepted ------------ */

await test('only accepted fields reach the candidate record', async () => {
  const before = Candidates.byId(candidate.id);

  const result = await reviewProposal(proposalId, {
    university: true,
    location: true,
    // Deliberately withheld by the reviewer.
    currentCompany: false,
  }, REVIEWER);

  assert.equal(result.status, 'APPLIED');
  assert.deepEqual([...result.applied].sort(), ['location', 'university']);
  assert.ok(result.rejected.includes('currentCompany'));

  const after = Candidates.byId(candidate.id);
  assert.equal(after.university, 'Cairo University');
  assert.equal(after.location, 'Cairo, Egypt');
  // REJECTED means not written — not "written later".
  assert.equal(after.current_company, null, 'a rejected field was written anyway');
  // Everything the review did not mention is untouched.
  assert.equal(after.candidate_no, before.candidate_no);
  assert.equal(after.email, before.email);
  assert.equal(after.full_name, before.full_name);
});

await test('a reviewed proposal cannot be reviewed again', async () => {
  await assert.rejects(
    () => reviewProposal(proposalId, { university: true }, REVIEWER),
    /already/i,
  );
});

await test('accepting nothing rejects the proposal and writes nothing', async () => {
  const second = await raiseProposal({
    candidateId: candidate.id,
    origin: 'resume.extract',
    documentId: path.basename(cvPath),
    fields: parsedFields,
  });
  const before = Candidates.byId(candidate.id);
  const result = await reviewProposal(second.id, {}, REVIEWER);
  assert.equal(result.status, 'REJECTED');
  assert.deepEqual(result.applied, []);
  const after = Candidates.byId(candidate.id);
  assert.equal(after.current_company, before.current_company);
  assert.equal(after.university, before.university);
});

await test('raising a new proposal supersedes the previous pending one', async () => {
  const a = await raiseProposal({
    candidateId: candidate.id, origin: 'resume.extract', fields: parsedFields,
  });
  const b = await raiseProposal({
    candidateId: candidate.id, origin: 'resume.extract', fields: parsedFields,
  });
  assert.equal(proposalById(a.id).status, 'SUPERSEDED');
  assert.equal(proposalById(b.id).status, 'PENDING');
  // Exactly one live proposal, so a reviewer is never shown two.
  assert.equal(pendingProposal(candidate.id).id, b.id);
});

fs.rmSync(cvPath, { force: true });

console.log(`\n${failures.length === 0 ? '✓' : '✗'} ${passed} passed, ${failures.length} failed\n`);
process.exit(failures.length === 0 ? 0 : 1);
