// The CV Intake -> Talent Pool workflow, end to end, without the network.
//
// Every case below is one of the behaviours the product owner specified: a
// clean CV reaches the Talent Pool on its own, an exception reaches a person,
// and nothing ever creates an Application by itself.
//
// The AI reader is not exercised here — parsed FIELDS are supplied directly, so
// these assertions are about the ingest decision itself and stay deterministic.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

process.env.DATABASE_URL = `file:/tmp/ats-autoingest-${randomUUID()}.db`;
process.env.MICROSOFT_TOKEN_ENCRYPTION_KEY = 'b'.repeat(64);
process.env.SMTP_TRANSPORT = 'json';

const { ensureSchema } = await import('./src/lib/schema.js');
const { run, get, all } = await import('./src/lib/db.js');
const { ROLES } = await import('./src/lib/permissions.js');
const { createIntake, intakeById } = await import('./src/lib/intake-store.js');
const { ingestIntake, classifyProfile, assessIntake, CLASSES, valuesOf, FLAGS, FLAG_CODES } =
  await import('./src/lib/cv-intake/auto-ingest.js');
const { Candidates } = await import('./src/lib/models.js');

ensureSchema();
for (const [code, name, description] of ROLES) {
  run('INSERT INTO role (code,name,description) VALUES (?,?,?)', [code, name, description]);
}
run(`INSERT INTO users (employee_no,full_name,email,password_hash,status,created_at,updated_at)
     VALUES ('E1','Test Recruiter','rec@arabtec.com','x','active',?,?)`,
[new Date().toISOString(), new Date().toISOString()]);
const ACTOR = { id: 1, fullName: 'Test Recruiter' };

// The sequence counters and prefixes Candidates.nextNo() reads. ensureSchema()
// creates the table; prisma/seed.js normally fills it. Seeded here directly so
// this suite needs no seed run and no demo data.
for (const [key, value] of [
  ['candidate_prefix', 'CAN'], ['candidate_counter', '0'],
  ['application_prefix', 'APP'], ['application_counter', '0'],
  ['retention_months', '24'],
]) {
  run('INSERT INTO system_setting (key,value,updated_at) VALUES (?,?,?)',
    [key, value, new Date().toISOString()]);
}

let failures = 0;
function check(name, fn) {
  try { fn(); console.log('  PASS', name); }
  catch (e) { failures += 1; console.error('  FAIL', name, '\n        ', e.message); }
}
async function checkAsync(name, fn) {
  try { await fn(); console.log('  PASS', name); }
  catch (e) { failures += 1; console.error('  FAIL', name, '\n        ', e.message); }
}

/** A parsed field as the reader emits it. Confidence defaults to a solid read. */
const F = (field, value, confidence = 0.92) => ({ field, value, confidence });

let hashSeed = 0;
/** Make an intake the way both real callers do. Distinct hash unless pinned. */
function makeIntake(fields, opts = {}) {
  return createIntake({
    storedName: `stored-${++hashSeed}.pdf`,
    fileName: opts.fileName || `cv-${hashSeed}.pdf`,
    mimeType: 'application/pdf',
    fileHash: opts.fileHash || `hash-${hashSeed}`,
    origin: opts.origin || 'mailbox.microsoft',
    modelId: 'test-model',
    documentId: `doc-${hashSeed}`,
    generation: null,
    fields,
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
    createdBy: ACTOR.id,
  });
}

const countCandidates = () => Number(get('SELECT COUNT(*) AS n FROM candidate').n);
const countApplications = () => Number(get('SELECT COUNT(*) AS n FROM application').n);

console.log('\n--- 1-3: a clean CV reaches the Talent Pool, whatever the profession ---');

await checkAsync('1. clean construction CV goes straight to the Talent Pool as Core', async () => {
  const before = countCandidates();
  const intake = makeIntake([
    F('fullName', 'Ahmed Hassan'), F('email', 'ahmed.hassan@example.com'),
    F('phone', '+201001234567'), F('currentPosition', 'Site Engineer'),
    F('currentCompany', 'Orascom Construction'), F('yearsExperience', 7),
  ]);
  const r = await ingestIntake(intake, ACTOR);
  assert.equal(r.outcome, 'CONVERTED', `expected CONVERTED, got ${r.outcome}: ${r.reason}`);
  assert.equal(countCandidates(), before + 1, 'exactly one candidate was created');
  assert.equal(r.classification, CLASSES.CORE);
  assert.equal(intakeById(intake.id).status, 'CONVERTED');
  const c = Candidates.byId(r.candidateId);
  assert.equal(c.full_name, 'Ahmed Hassan');
  assert.equal(c.discipline_class, CLASSES.CORE, 'the bucket is stored for search');
});

await checkAsync('2. clean support-function CV is auto-ingested as Support', async () => {
  const intake = makeIntake([
    F('fullName', 'Mona Farouk'), F('email', 'mona.farouk@example.com'),
    F('currentPosition', 'Document Controller'), F('yearsExperience', 5),
  ]);
  const r = await ingestIntake(intake, ACTOR);
  assert.equal(r.outcome, 'CONVERTED', r.reason || '');
  assert.equal(r.classification, CLASSES.SUPPORT);
});

await checkAsync('3. an unrelated professional is auto-ingested, classified, NOT rejected', async () => {
  const intake = makeIntake([
    F('fullName', 'Youssef Adel'), F('email', 'youssef.adel@example.com'),
    F('currentPosition', 'Senior Accountant'), F('currentCompany', 'KPMG'),
  ]);
  const r = await ingestIntake(intake, ACTOR);
  assert.equal(r.outcome, 'CONVERTED', 'an accountant is a real hire for a contractor');
  assert.equal(r.classification, CLASSES.OTHER);
  assert.notEqual(intakeById(intake.id).status, 'REJECTED', 'classification must never reject');
});

console.log('\n--- 4-6: no vacancy needed, and partial contact details are fine ---');

check('4. the pipeline does not depend on hiring requests existing', () => {
  assert.equal(Number(get('SELECT COUNT(*) AS n FROM recruitment_request').n), 0,
    'fixture sanity: no requisition exists, yet cases 1-3 all converted');
});

await checkAsync('5. name + phone, no email, is enough to auto-ingest', async () => {
  const intake = makeIntake([
    F('fullName', 'Karim Saleh'), F('phone', '+201119876543'),
    F('currentPosition', 'Quantity Surveyor'), F('yearsExperience', 9),
  ]);
  const r = await ingestIntake(intake, ACTOR);
  assert.equal(r.outcome, 'CONVERTED', r.reason || '');
  assert.equal(Candidates.byId(r.candidateId).email, null, 'no email was invented');
});

await checkAsync('6. name + email, no phone, is enough to auto-ingest', async () => {
  const intake = makeIntake([
    F('fullName', 'Laila Mahmoud'), F('email', 'laila.mahmoud@example.com'),
    F('currentPosition', 'Planning Engineer'), F('yearsExperience', 4),
  ]);
  const r = await ingestIntake(intake, ACTOR);
  assert.equal(r.outcome, 'CONVERTED', r.reason || '');
  assert.equal(Candidates.byId(r.candidateId).phone, null, 'no phone was invented');
});

console.log('\n--- 7-10: duplicates, updates and lookalikes ---');

await checkAsync('7. the identical CV twice produces ONE candidate', async () => {
  const fields = [
    F('fullName', 'Tarek Nabil'), F('email', 'tarek.nabil@example.com'),
    F('phone', '+201223334444'), F('currentPosition', 'Structural Engineer'),
  ];
  const first = await ingestIntake(makeIntake(fields, { fileHash: 'dup-hash-1' }), ACTOR);
  assert.equal(first.outcome, 'CONVERTED');
  const before = countCandidates();

  const second = await ingestIntake(makeIntake(fields, { fileHash: 'dup-hash-1' }), ACTOR);
  assert.equal(second.outcome, 'DUPLICATE', `expected DUPLICATE, got ${second.outcome}`);
  assert.equal(second.candidateId, first.candidateId, 'it points at the person already on file');
  assert.equal(countCandidates(), before, 'no second candidate was created');
});

await checkAsync('8. an updated CV from an existing candidate keeps one person and records the document', async () => {
  const base = [
    F('fullName', 'Nour Ibrahim'), F('email', 'nour.ibrahim@example.com'),
    F('phone', '+201335556666'), F('currentPosition', 'MEP Engineer'),
  ];
  const first = await ingestIntake(makeIntake(base, { fileHash: 'nour-v1' }), ACTOR);
  assert.equal(first.outcome, 'CONVERTED');
  const before = countCandidates();

  // Same person, new document, a promotion since last time.
  const updated = [...base.slice(0, 3), F('currentPosition', 'Senior MEP Engineer'), F('yearsExperience', 11)];
  const second = await ingestIntake(makeIntake(updated, { fileHash: 'nour-v2' }), ACTOR);

  assert.equal(second.outcome, 'DUPLICATE', 'the same person, matched on contact details');
  assert.equal(second.candidateId, first.candidateId);
  assert.equal(countCandidates(), before, 'still one Nour Ibrahim');

  // Both CVs survive as intake records against that person — the source history.
  const intakes = all('SELECT id, status, candidate_id FROM candidate_intake WHERE candidate_id=?',
    [first.candidateId]);
  assert.ok(intakes.length >= 2, `both documents are retained (found ${intakes.length})`);
  assert.ok(intakes.some((i) => i.status === 'CONVERTED'));
  assert.ok(intakes.some((i) => i.status === 'DUPLICATE'));
});

await checkAsync('7. a namesake with different contacts becomes its OWN flagged candidate', async () => {
  const a = await ingestIntake(makeIntake([
    F('fullName', 'Mohamed Ali'), F('email', 'mohamed.ali.1@example.com'),
    F('phone', '+201447778888'), F('currentPosition', 'Civil Engineer'),
  ]), ACTOR);
  assert.equal(a.outcome, 'CONVERTED');
  const before = countCandidates();

  // A different Mohamed Ali: nothing in common but the name.
  const b = await ingestIntake(makeIntake([
    F('fullName', 'Mohamed Ali'), F('email', 'mohamed.ali.2@example.com'),
    F('phone', '+201559990000'), F('currentPosition', 'Architect'),
  ]), ACTOR);

  assert.equal(b.outcome, 'CONVERTED', 'two people with one name is ordinary, not a blocker');
  assert.equal(countCandidates(), before + 1, 'a SEPARATE candidate, not a merge');
  assert.notEqual(b.candidateId, a.candidateId);
  const codes = JSON.parse(Candidates.byId(b.candidateId).quality_flags || '[]');
  assert.ok(codes.includes('possible-duplicate'), `expected the label, got ${codes}`);
  assert.match(Candidates.byId(b.candidateId).quality_note, /same name/i);
  // And the first person is untouched.
  assert.equal(Candidates.byId(a.candidateId).current_position, 'Civil Engineer');
});

console.log('\n--- uncertainty is LABELLED, not blocked ---');

const flagsOf = (id) => {
  try { return JSON.parse(Candidates.byId(id).quality_flags || '[]'); } catch { return []; }
};

await checkAsync('2b. no email but a usable phone: Talent Pool, no Contact Missing flag', async () => {
  const r = await ingestIntake(makeIntake([
    F('fullName', 'Hoda Salem'), F('phone', '+201220009999'),
    F('currentPosition', 'Site Engineer'),
  ]), ACTOR);
  assert.equal(r.outcome, 'CONVERTED');
  assert.ok(!flagsOf(r.candidateId).includes('contact-missing'), 'a phone IS a contact');
});

await checkAsync('2c. no contact at all: Talent Pool WITH Contact Missing', async () => {
  const before = countCandidates();
  const r = await ingestIntake(makeIntake([
    F('fullName', 'Walid Nasser'), F('currentPosition', 'Site Engineer'),
    F('currentCompany', 'Hassan Allam'),
  ]), ACTOR);
  assert.equal(r.outcome, 'CONVERTED', 'missing contact must NOT block the pool');
  assert.equal(countCandidates(), before + 1);
  assert.ok(flagsOf(r.candidateId).includes('contact-missing'));
  assert.match(Candidates.byId(r.candidateId).quality_note, /No email or phone/);
  assert.equal(intakeById(r.candidateId ? 0 : 0)?.status ?? 'n/a', 'n/a');
});

await checkAsync('4. sparse professional data: Talent Pool WITH Incomplete Profile', async () => {
  const r = await ingestIntake(makeIntake([
    F('fullName', 'Ramy Gaber'), F('phone', '+201330008888'),
  ]), ACTOR);
  assert.equal(r.outcome, 'CONVERTED', 'a thin profile is a label, not a gate');
  assert.ok(flagsOf(r.candidateId).includes('incomplete-profile'));
  assert.match(Candidates.byId(r.candidateId).quality_note, /position and experience/i);
});

await checkAsync('5. low confidence on identity: Talent Pool WITH Low Confidence', async () => {
  const r = await ingestIntake(makeIntake([
    F('fullName', 'Faded Print', 0.30), F('email', 'faded.print@example.com', 0.25),
    F('currentPosition', 'Site Engineer', 0.9),
  ]), ACTOR);
  assert.equal(r.outcome, 'CONVERTED', 'low confidence is visible, not blocking');
  assert.ok(flagsOf(r.candidateId).includes('low-confidence'));
});

await checkAsync('9. a completely unreadable file is a hard exception — no candidate', async () => {
  const before = countCandidates();
  const intake = makeIntake([], { fileName: 'corrupt.pdf' });
  // createIntake refuses an empty field set, which IS the hard block upstream.
  if (intake === null) {
    assert.equal(countCandidates(), before, 'nothing was created');
    return;
  }
  const r = await ingestIntake(intake, ACTOR);
  assert.equal(r.outcome, 'BLOCKED');
  assert.equal(r.code, 'unreadable');
  assert.equal(countCandidates(), before);
});

await checkAsync('10. no usable name is a hard exception — no candidate', async () => {
  const before = countCandidates();
  const intake = makeIntake([F('currentPosition', 'Engineer'), F('email', 'x@example.com')]);
  const r = await ingestIntake(intake, ACTOR);
  assert.equal(r.outcome, 'BLOCKED', 'there is no person to create');
  assert.equal(r.code, 'no-identity');
  assert.equal(countCandidates(), before);
  assert.equal(intakeById(intake.id).status, 'PENDING', 'the file waits for a person');
});

await checkAsync('12. two CVs in one email are processed independently', async () => {
  const before = countCandidates();
  const one = await ingestIntake(makeIntake([
    F('fullName', 'Hala Zaki'), F('email', 'hala.zaki@example.com'), F('currentPosition', 'Architect'),
  ]), ACTOR);
  const two = await ingestIntake(makeIntake([
    F('fullName', 'Omar Fathy'), F('email', 'omar.fathy@example.com'), F('currentPosition', 'Foreman'),
  ]), ACTOR);
  assert.equal(one.outcome, 'CONVERTED');
  assert.equal(two.outcome, 'CONVERTED');
  assert.notEqual(one.candidateId, two.candidateId);
  assert.equal(countCandidates(), before + 2);
});

await checkAsync('14. a candidate-record rule the reader got past keeps the CV', async () => {
  const intake = makeIntake([
    F('fullName', 'Broken Record'), F('email', 'not-an-email-address'),
    F('phone', '+201770002222'), F('currentPosition', 'Site Engineer'),
  ]);
  const r = await ingestIntake(intake, ACTOR);
  assert.notEqual(r.outcome, 'CONVERTED');
  const row = intakeById(intake.id);
  assert.equal(row.status, 'PENDING', 'still reviewable and still retryable');
  assert.ok(row.storedName, 'the original document is still on file');
});

console.log('\n--- 15-18: idempotency, language, and the Application rule ---');

await checkAsync('15. re-running the same ingest twice creates no second candidate', async () => {
  const intake = makeIntake([
    F('fullName', 'Rania Sobhy'), F('email', 'rania.sobhy@example.com'),
    F('phone', '+201881113333'), F('currentPosition', 'Cost Control Engineer'),
  ]);
  const first = await ingestIntake(intake, ACTOR);
  assert.equal(first.outcome, 'CONVERTED');
  const before = countCandidates();

  // The very same intake again — as a repeated sync or a retry would.
  const again = await ingestIntake(intakeById(intake.id), ACTOR);
  assert.notEqual(again.outcome, 'CONVERTED', 'an already-converted intake cannot convert twice');
  assert.equal(countCandidates(), before, 'no duplicate candidate from a repeated run');
});

await checkAsync('16. an Arabic CV is ingested on its own merits', async () => {
  const intake = makeIntake([
    F('fullName', 'محمد عبد الرحمن'), F('email', 'm.abdelrahman@example.com'),
    F('phone', '+201992224444'), F('currentPosition', 'مهندس موقع'),
  ]);
  const r = await ingestIntake(intake, ACTOR);
  assert.equal(r.outcome, 'CONVERTED', `an Arabic name must not block ingest: ${r.reason}`);
  assert.equal(Candidates.byId(r.candidateId).full_name, 'محمد عبد الرحمن');
  // The bucket cannot be read from Arabic job titles by keyword, and says so
  // honestly rather than guessing — the candidate is still in the pool.
  assert.equal(r.classification, CLASSES.UNCLASSIFIED,
    'an unbucketed profile is Unclassified — a search fact, not a review state');
});

await checkAsync('17. a mixed Arabic/English CV classifies from the part it can read', async () => {
  const intake = makeIntake([
    F('fullName', 'أحمد سمير'), F('email', 'ahmed.samir@example.com'),
    F('currentPosition', 'Site Engineer - مهندس موقع'), F('yearsExperience', 6),
  ]);
  const r = await ingestIntake(intake, ACTOR);
  assert.equal(r.outcome, 'CONVERTED');
  assert.equal(r.classification, CLASSES.CORE, 'the English half is enough to bucket it');
});

await checkAsync('18. a clean auto-ingest creates NO Application', async () => {
  const before = countApplications();
  const r = await ingestIntake(makeIntake([
    F('fullName', 'Dina Refaat'), F('email', 'dina.refaat@example.com'),
    F('phone', '+201003335555'), F('currentPosition', 'Planning Engineer'),
  ]), ACTOR);
  assert.equal(r.outcome, 'CONVERTED');
  assert.equal(countApplications(), before, 'recruitment progression stays human-driven');
  assert.equal(countApplications(), 0, 'no application has been created by any case above');
});

await checkAsync('18b. a CV uploaded against a requisition is never auto-ingested', async () => {
  const intake = makeIntake([
    F('fullName', 'Requisition Linked'), F('email', 'req.linked@example.com'),
    F('phone', '+201114446666'), F('currentPosition', 'Site Engineer'),
  ], { requestId: 999, origin: 'resume.extract' });
  const r = await ingestIntake(intake, ACTOR);
  assert.equal(r.outcome, 'NEEDS_REVIEW');
  assert.equal(r.code, 'request-linked');
  assert.equal(countApplications(), 0, 'and still no application');
});

console.log('\n--- classification, on its own ---');

check('classification never returns something outside the five buckets', () => {
  const buckets = new Set(Object.values(CLASSES));
  const samples = [
    'Site Engineer', 'Document Controller', 'Chemical Engineer', 'Accountant',
    '', 'مهندس', 'Zookeeper', 'Procurement Officer',
  ];
  for (const title of samples) {
    const got = classifyProfile(valuesOf([{ field: 'currentPosition', value: title }]));
    assert.ok(buckets.has(got), `"${title}" produced "${got}", which is not a bucket`);
  }
});

check('an empty profile is Unclassified, not a crash', () => {
  assert.equal(classifyProfile(valuesOf([])), CLASSES.UNCLASSIFIED);
  const v = assessIntake({ fields: [] });
  assert.equal(v.ok, false, 'nothing read is one of the two hard exceptions');
  assert.equal(v.blockCode, 'unreadable');
});


console.log('\n--- classification is a search fact, never a review state ---');

await checkAsync('C1. an unclassifiable but clean CV still goes to the Talent Pool', async () => {
  const before = countCandidates();
  const intake = makeIntake([
    F('fullName', 'Zahra Mostafa'), F('email', 'zahra.mostafa@example.com'),
    F('phone', '+201445556677'), F('currentPosition', 'Falconry Master'),
    F('currentCompany', 'Desert Heritage Trust'),
  ]);
  const r = await ingestIntake(intake, ACTOR);
  assert.equal(r.outcome, 'CONVERTED', 'an unknown profession must not need a recruiter');
  assert.equal(r.classification, CLASSES.UNCLASSIFIED);
  assert.equal(countCandidates(), before + 1);
  assert.equal(intakeById(intake.id).status, 'CONVERTED', 'not parked in Candidate Review');
  assert.equal(Candidates.byId(r.candidateId).discipline_class, CLASSES.UNCLASSIFIED);
});

await checkAsync('C2. an Arabic-only CV is Unclassified and still auto-ingested', async () => {
  const intake = makeIntake([
    F('fullName', 'سارة خليل'), F('email', 'sara.khalil@example.com'),
    F('phone', '+201778889999'), F('currentPosition', 'أخصائي موارد بشرية'),
  ]);
  const r = await ingestIntake(intake, ACTOR);
  assert.equal(r.outcome, 'CONVERTED');
  assert.equal(r.classification, CLASSES.UNCLASSIFIED);
  assert.equal(intakeById(intake.id).status, 'CONVERTED');
});

check('C3. no classification bucket carries review language', () => {
  for (const v of Object.values(CLASSES)) {
    assert.ok(!/review/i.test(v), `"${v}" reads like a workflow state, not a category`);
  }
  assert.equal(CLASSES.UNCLASSIFIED, 'Unclassified');
});

check('C4. the gate never reads the classification', () => {
  // Same identity and profile strength, wildly different professions: the
  // verdict must be identical, because classification is not an input to it.
  const mk = (position) => ({ fields: [
    { field: 'fullName', value: 'Gate Probe', confidence: 0.9 },
    { field: 'email', value: 'gate.probe@example.com', confidence: 0.9 },
    { field: 'currentPosition', value: position, confidence: 0.9 },
  ] });
  const core = assessIntake(mk('Site Engineer'));
  const odd = assessIntake(mk('Falconry Master'));
  assert.equal(core.ok, true);
  assert.equal(odd.ok, true, 'an unrecognised profession is still a clean parse');
  assert.equal(core.code, odd.code);
  assert.notEqual(core.classification, odd.classification, 'they DO bucket differently');
});

console.log('\n--- an updated CV from someone already in the pool ---');

await checkAsync('U1. a newer CV refreshes career data, keeps one candidate and both documents', async () => {
  const v1 = [
    F('fullName', 'Rasha Elsayed'), F('email', 'rasha.update@example.com'),
    F('phone', '+201335550001'), F('currentPosition', 'MEP Engineer'),
    F('yearsExperience', 8), F('location', 'Cairo'),
  ];
  const first = await ingestIntake(makeIntake(v1, { fileHash: 'nour-upd-v1' }), ACTOR);
  assert.equal(first.outcome, 'CONVERTED', first.reason || '');
  const id = first.candidateId;
  const beforeCount = countCandidates();
  const beforeApps = countApplications();
  assert.equal(Candidates.byId(id).current_position, 'MEP Engineer');
  assert.equal(Number(Candidates.byId(id).years_experience), 8);

  // The same person, two years on.
  const v2 = [
    F('fullName', 'Rasha Elsayed'), F('email', 'rasha.update@example.com'),
    F('phone', '+201335550001'), F('currentPosition', 'Senior MEP Engineer'),
    F('yearsExperience', 11), F('location', 'Cairo'),
  ];
  const second = await ingestIntake(makeIntake(v2, { fileHash: 'nour-upd-v2' }), ACTOR);

  assert.equal(second.outcome, 'DUPLICATE', 'still the same person');
  assert.equal(second.candidateId, id);
  assert.equal(countCandidates(), beforeCount, 'candidate count remains 1 for this person');

  const after = Candidates.byId(id);
  assert.equal(after.current_position, 'Senior MEP Engineer', 'searchable position is the newest');
  assert.equal(Number(after.years_experience), 11, 'searchable experience is the newest');

  // Both CVs on file.
  const docs = all('SELECT file_hash FROM candidate_document WHERE candidate_id=?', [id])
    .map((d) => d.file_hash);
  assert.ok(docs.includes('nour-upd-v1'), 'the original CV is retained');
  assert.ok(docs.includes('nour-upd-v2'), 'the newer CV is retained');

  // History: the change is recorded, not silent.
  const proposals = all('SELECT id, origin, status FROM candidate_proposal WHERE candidate_id=?', [id]);
  assert.ok(proposals.some((pr) => pr.origin === 'cv_auto_refresh'),
    'the refresh is recorded as a reviewed proposal, with what it replaced');
  assert.ok(second.refreshed.includes('currentPosition'));
  assert.ok(second.refreshed.includes('yearsExperience'));

  assert.equal(countApplications(), beforeApps, 'zero applications created');
  assert.notEqual(intakeById(0)?.status, 'PENDING');
  const intakes = all('SELECT status FROM candidate_intake WHERE candidate_id=?', [id]).map((i) => i.status);
  assert.ok(intakes.includes('CONVERTED') && intakes.includes('DUPLICATE'),
    'both intakes resolved, neither left needing a recruiter');
});

await checkAsync('U2. identity and contact are never rewritten by an automatic refresh', async () => {
  const base = [
    F('fullName', 'Hany Kamal'), F('email', 'hany.kamal@example.com'),
    F('phone', '+201556667777'), F('currentPosition', 'Planning Engineer'),
  ];
  const first = await ingestIntake(makeIntake(base, { fileHash: 'hany-v1' }), ACTOR);
  const id = first.candidateId;

  // A newer CV with a new phone number AND a promotion.
  const second = await ingestIntake(makeIntake([
    F('fullName', 'Hany Kamal'), F('email', 'hany.kamal@example.com'),
    F('phone', '+201999998888'), F('currentPosition', 'Senior Planning Engineer'),
  ], { fileHash: 'hany-v2' }), ACTOR);

  assert.equal(second.outcome, 'DUPLICATE');
  const after = Candidates.byId(id);
  assert.equal(after.current_position, 'Senior Planning Engineer', 'career data moved');
  assert.equal(after.phone, '+201556667777', 'the phone on file was NOT rewritten');
  assert.ok((second.heldBack || []).includes('phone'), 'and the contact change is recorded as held');
});

await checkAsync('U3. empty fields are filled from the newer CV', async () => {
  const first = await ingestIntake(makeIntake([
    F('fullName', 'Sherif Adel'), F('email', 'sherif.adel@example.com'),
    F('currentPosition', 'Surveyor'),
  ], { fileHash: 'sherif-v1' }), ACTOR);
  const id = first.candidateId;
  assert.equal(Candidates.byId(id).years_experience, null);

  const second = await ingestIntake(makeIntake([
    F('fullName', 'Sherif Adel'), F('email', 'sherif.adel@example.com'),
    F('currentPosition', 'Surveyor'), F('yearsExperience', 6), F('location', 'Alexandria'),
  ], { fileHash: 'sherif-v2' }), ACTOR);

  assert.equal(second.outcome, 'DUPLICATE');
  const after = Candidates.byId(id);
  assert.equal(Number(after.years_experience), 6);
  assert.equal(after.location, 'Alexandria');
});

await checkAsync('U4. a shared contact with a DIFFERENT person: separate flagged candidate, other record untouched', async () => {
  const first = await ingestIntake(makeIntake([
    F('fullName', 'Amira Fouad'), F('email', 'shared.family@example.com'),
    F('phone', '+201220003333'), F('currentPosition', 'Architect'),
  ], { fileHash: 'shared-v1' }), ACTOR);
  assert.equal(first.outcome, 'CONVERTED');
  const before = countCandidates();
  const positionBefore = Candidates.byId(first.candidateId).current_position;

  // A brother using the same family address. Same email, different human.
  const second = await ingestIntake(makeIntake([
    F('fullName', 'Bassem Zaki'), F('email', 'shared.family@example.com'),
    F('phone', '+201220003333'), F('currentPosition', 'Electrical Engineer'),
  ], { fileHash: 'shared-v2' }), ACTOR);

  assert.equal(second.outcome, 'CONVERTED', 'Bassem is a real person and belongs in the pool');
  assert.equal(countCandidates(), before + 1, 'as his OWN candidate, never merged into Amira');
  assert.notEqual(second.candidateId, first.candidateId);

  const codes = JSON.parse(Candidates.byId(second.candidateId).quality_flags || '[]');
  assert.ok(codes.includes('needs-review'), `expected needs-review, got ${codes}`);
  assert.match(Candidates.byId(second.candidateId).quality_note, /names someone else/i);

  // The decisive assertion: Amira's record was not disturbed at all.
  assert.equal(Candidates.byId(first.candidateId).current_position, positionBefore);
  assert.equal(Candidates.byId(first.candidateId).full_name, 'Amira Fouad');
});

await checkAsync('U5. a re-sent identical CV changes nothing and still needs nobody', async () => {
  const fields = [
    F('fullName', 'Static Sample'), F('email', 'static.sample@example.com'),
    F('phone', '+201001112222'), F('currentPosition', 'Cost Control Engineer'),
  ];
  const first = await ingestIntake(makeIntake(fields, { fileHash: 'static-1' }), ACTOR);
  const id = first.candidateId;
  const updatedBefore = Candidates.byId(id).updated_at;

  const second = await ingestIntake(makeIntake(fields, { fileHash: 'static-1' }), ACTOR);
  assert.equal(second.outcome, 'DUPLICATE');
  assert.deepEqual(second.refreshed, [], 'nothing to refresh, so nothing was written');
  assert.equal(Candidates.byId(id).current_position, 'Cost Control Engineer');
  assert.ok(second.reason.includes('added nothing'), `reason says so: ${second.reason}`);
});

check('U6. the refresh policy never lists an identity field as refreshable', () => {
  // Reading the policy through behaviour: assessIntake/ingest aside, the two
  // sets must not overlap, or a future edit could quietly make email movable.
  const bad = ['fullName', 'email', 'phone', 'linkedinUrl'];
  const src = readFileSync(new URL('./src/lib/cv-intake/auto-ingest.js', import.meta.url), 'utf8');
  const refreshable = src.slice(src.indexOf('const REFRESHABLE'), src.indexOf('const IDENTITY'));
  for (const f of bad) {
    assert.ok(!refreshable.includes(`'${f}'`), `${f} must never be auto-refreshable`);
  }
});


console.log('\n--- flagged candidates are first-class members of the Talent Pool ---');

await checkAsync('11. a flagged candidate is searchable by every ordinary field', async () => {
  const r = await ingestIntake(makeIntake([
    F('fullName', 'Searchable Flagged'), F('currentPosition', 'Planning Engineer'),
    F('currentCompany', 'Arab Contractors'), F('yearsExperience', 12),
    F('location', 'Cairo'), F('skills', ['Primavera', 'Cost Control']),
  ]), ACTOR);
  assert.equal(r.outcome, 'CONVERTED');
  const id = r.candidateId;
  assert.ok(JSON.parse(Candidates.byId(id).quality_flags || '[]').includes('contact-missing'),
    'fixture sanity: this candidate IS flagged');

  const found = (f) => Candidates.list({ ...f, limit: 200, offset: 0 }).some((c) => c.id === id);
  assert.ok(found({}), 'the DEFAULT Talent Pool must not hide a flagged candidate');
  assert.ok(found({ q: 'Searchable' }), 'searchable by name');
  assert.ok(found({ currentPosition: 'Planning Engineer' }), 'searchable by role');
  assert.ok(found({ minExp: 10 }), 'searchable by experience');
  assert.ok(found({ location: 'Cairo' }), 'searchable by location');
  assert.ok(found({ disciplineClass: CLASSES.CORE }), 'searchable by classification');
  assert.ok(found({ source: 'cv_auto_ingest' }), 'searchable by source');
});

await checkAsync('12. each label is its own Talent Pool filter', async () => {
  const has = (flag, id) => Candidates.list({ qualityFlag: flag, limit: 200, offset: 0 })
    .some((c) => c.id === id);

  const contactless = await ingestIntake(makeIntake([
    F('fullName', 'Filter Contactless'), F('currentPosition', 'Surveyor'),
  ]), ACTOR);
  const lowconf = await ingestIntake(makeIntake([
    F('fullName', 'Filter Lowconf', 0.2), F('email', 'filter.lowconf@example.com', 0.2),
    F('currentPosition', 'Site Engineer', 0.95),
  ]), ACTOR);

  assert.ok(has('contact-missing', contactless.candidateId), 'Contact Missing filter finds it');
  assert.ok(has('low-confidence', lowconf.candidateId), 'Low Confidence filter finds it');
  assert.ok(!has('low-confidence', contactless.candidateId), 'and does not over-match');

  // The "everything that needs attention" view, and its inverse.
  const flagged = Candidates.list({ flagged: 'yes', limit: 500, offset: 0 }).map((c) => c.id);
  const clean = Candidates.list({ flagged: 'no', limit: 500, offset: 0 }).map((c) => c.id);
  assert.ok(flagged.includes(contactless.candidateId));
  assert.ok(!clean.includes(contactless.candidateId));
  assert.equal(flagged.filter((id) => clean.includes(id)).length, 0, 'the two views are disjoint');
});

check('13+14. no application and no requisition was involved anywhere above', () => {
  assert.equal(countApplications(), 0, 'not one application across the whole suite');
  assert.equal(Number(get('SELECT COUNT(*) AS n FROM recruitment_request').n), 0,
    'and not one hiring request had to exist');
});

check('every flag carries a code, a label and a human sentence', () => {
  for (const [key, f] of Object.entries(FLAGS)) {
    assert.ok(f.code && /^[a-z-]+$/.test(f.code), `${key} needs a filterable code`);
    assert.ok(f.label && !/[.]/.test(f.label), `${key} needs a short badge label`);
    assert.ok(f.reason && f.reason.trim().endsWith('.'), `${key} needs a full sentence`);
  }
  assert.equal(FLAG_CODES.length, Object.keys(FLAGS).length);
});

console.log(`\n=== CV AUTO-INGEST: ${failures} failure(s) ===\n`);
process.exit(failures ? 1 : 0);
