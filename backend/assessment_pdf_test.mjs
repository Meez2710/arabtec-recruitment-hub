// Packet 01 — PDF-faithful assessment lifecycle and server trust.
// Exercises the real legacy HTTP routes (/api/assessments/*) and model against a
// disposable SQLite database and upload directory. Never touches a shared DB.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'arabtec-assess-'));
process.env.DATABASE_URL = 'file:' + path.join(TMP, 'assess.db');
process.env.UPLOAD_DIR = path.join(TMP, 'uploads');
process.env.PORT = process.env.ASSESS_TEST_PORT || '4391';
process.env.SEED_DEMO_DATA ||= 'true';
process.env.SMTP_TRANSPORT = 'json';
const { adminToken, ADMIN_BOOTSTRAP_PASSWORD } = await import('./test-support/admin-session.mjs');
process.env.SEED_ADMIN_PASSWORD ||= ADMIN_BOOTSTRAP_PASSWORD;

await import('./prisma/seed.js');
await import('./src/server.js');
const { waitForReady } = await import('./test-support/wait-ready.mjs');
const B = 'http://localhost:' + process.env.PORT;
await waitForReady(B);
const { Audit } = await import('./src/lib/models.js');
const db = await import('./src/lib/db.js');
const A = await import('./src/lib/assessment.js');

let pass = 0, fail = 0;
const c = (n, ok, x = '') => { console.log((ok ? '  ✅ ' : '  ❌ ') + n + (ok ? '' : ' ' + x)); ok ? pass++ : fail++; };
async function api(p, { method = 'GET', token, body } = {}) {
  const r = await fetch(B + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch {}
  return { status: r.status, json: j, text, headers: r.headers };
}
const login = async (e, p = 'Arabtec@123') => (await api('/api/auth/login', { method: 'POST', body: { email: e, password: p } })).json.token;
const raw = (appId, type) => db.get('SELECT * FROM application_assessment WHERE application_id=? AND evaluator_type=?', [appId, type]);
const HR_KEYS = A.HR_CRITERIA.map((x) => x.key);
const TECH_KEYS = A.TECHNICAL_CRITERIA.map((x) => x.key);
const rowsOf = (keys, scores, notes = []) => Object.fromEntries(keys.map((k, i) => [k, { score: scores[i], notes: notes[i] || '' }]));

try {
  // ── Boundary helpers (direct: five integer rows cannot reach every raw value) ──
  try {
    console.log('\n— Average rounding and fit bands —');
    for (const [rawAvg, shown, band] of [[4.15, 4.2, 'strong'], [4.14, 4.1, 'acceptable'], [3.45, 3.5, 'acceptable'], [3.44, 3.4, 'borderline'], [2.95, 3.0, 'borderline'], [2.94, 2.9, 'weak'], [5, 5, 'strong'], [1, 1, 'weak']]) {
      const r = A.roundAverage(rawAvg);
      c(`raw ${rawAvg} → ${shown} ${band}`, r === shown && A.fitLevel(r)?.value === band, `${r} ${A.fitLevel(r)?.value}`);
    }
    c('no numeric score → average and fit null', A.roundAverage(null) === null && A.fitLevel(null) === null);
    const allNa = A.summarize(rowsOf(HR_KEYS, ['na', 'na', 'na', 'na', 'na']), A.HR_CRITERIA);
    c('all-N/A summary is Not rated, never Weak', allNa.average === null && allNa.fit === null && allNa.naCount === 5 && allNa.scoredCount === 0 && allNa.complete);
    const mixed = A.summarize(rowsOf(HR_KEYS, [5, 4, 'na', null, 4]), A.HR_CRITERIA);
    c('average counts only numeric rows', mixed.average === 4.3 && mixed.scoredCount === 3 && mixed.naCount === 1 && mixed.unansweredCount === 1 && !mixed.complete);
    c('averageScore accepts {score} objects (old scalar-only defect)', A.averageScore({ a: { score: 4 }, b: { score: 5 } }) === 4.5);
    const legacyNorm = A.normalizeStoredSection({ openness: { score: null }, conscientiousness: 4, extraversion: { score: 3 }, agreeableness: { score: 7 } }, A.HR_CRITERIA);
    c('legacy read: {score:null} → N/A, scalar 4 → 4, invalid → unanswered, missing → unanswered',
      legacyNorm.rows?.openness.score === 'na' && legacyNorm.rows?.conscientiousness.score === 4 && legacyNorm.rows?.extraversion.score === 3
      && legacyNorm.rows?.agreeableness.score === null && legacyNorm.rows?.emotional_stability.score === null,
      JSON.stringify(legacyNorm.rows));
    c('canonical unanswered-with-notes row is not read as N/A', A.normalizeStoredSection({ openness: { notes: 'x' } }, A.HR_CRITERIA).rows?.openness.score === null);
  } catch (e) { c('assessment helpers available', false, e.message); }

  // ── Fixture ──
  const admin = await adminToken(B);
  // Packet 02 fixture: this suite exercises the lifecycle, scope and audit
  // contract with scoped panel members (e.g. an Interviewer) acting as the HR
  // evaluator and recording the final decision. Under the Packet 02 DEFAULT
  // field policy that interviewer may not edit the behavioral section, so the
  // suite opts every audience into editing all assessment sections — through
  // the real, audited policy endpoint. Salary visibility is left at its
  // defaults. Default-policy behavior is proven in assessment_policy_test.mjs.
  const PANEL = { view: true, edit: true };
  const panelPolicy = Object.fromEntries(['hr', 'technical', 'hiring_manager', 'other'].map((a) => [a, {
    'assessment.behavioral': PANEL, 'assessment.technical': PANEL, 'assessment.criticalFlags': PANEL, 'assessment.finalRecommendation': PANEL,
    'assessment.finalRecommendation.behavioralJustification': PANEL, 'assessment.finalRecommendation.technicalJustification': PANEL,
  }]));
  const fixturePolicy = await api('/api/assessments/policy', { method: 'PUT', token: admin, body: { overrides: panelPolicy } });
  if (fixturePolicy.status !== 200) throw new Error('fixture policy not applied: ' + fixturePolicy.text);
  const hrMgr = await login('hr.manager@arabtec.com');      // view_all, feedback, salary.view
  const hrDir = await login('hr.director@arabtec.com');
  const recMgr = await login('rec.manager@arabtec.com');
  const recruiter = await login('recruiter@arabtec.com');   // view_all, feedback, NO salary.view
  const interviewer = await login('interviewer@arabtec.com'); // view_assigned + feedback (Mona Sami)
  const hm = await login('hiring.manager@arabtec.com');     // view_assigned + feedback (Nadia Fouad)
  const viewer = await login('viewer@arabtec.com');         // view_all, no feedback
  const pm = await login('pm@arabtec.com');                 // candidate.view, no interview scope

  const rmeta = (await api('/api/requests/meta/form', { token: hrMgr })).json;
  const dept = rmeta.departments.find((d) => d.name === 'Planning') || rmeta.departments[0];
  const cr = await api('/api/requests', { method: 'POST', token: hrMgr, body: { title: 'Site Engineer', justification: 'new_hire', projectId: rmeta.projects[0].id, departmentId: dept.id, location: 'Cairo', headcount: 3, priority: 'high' } });
  const rid = cr.json.request.id;
  await api(`/api/requests/${rid}/submit`, { method: 'POST', token: hrMgr });
  await api(`/api/requests/${rid}/approve`, { method: 'POST', token: hrDir, body: {} });
  await api(`/api/requests/${rid}/assign`, { method: 'POST', token: recMgr, body: { ownerId: rmeta.recruiters.find((r) => r.name === 'Karim Adel').id } });

  const EVIL = '<img src=x onerror=alert(1)>Ali "Q" & Co';
  const candA = (await api('/api/candidates', { method: 'POST', token: hrMgr, body: { fullName: EVIL, phone: '+201000000101', yearsExperience: 0, expectedSalary: 45123, university: 'Cairo University', major: 'Civil Engineering', graduationYear: 2015, employer: 'Orascom', noticePeriod: '1 month' } })).json.candidate;
  const candB = (await api('/api/candidates', { method: 'POST', token: hrMgr, body: { fullName: 'Bare Candidate', phone: '+201000000102' } })).json.candidate;
  const candC = (await api('/api/candidates', { method: 'POST', token: hrMgr, body: { fullName: 'Locked Candidate', phone: '+201000000103' } })).json.candidate;
  const mkApp = async (cand) => (await api('/api/applications', { method: 'POST', token: recruiter, body: { candidateId: cand.id, requestId: rid, initialStatus: 'matched' } })).json.application.id;
  const appA = await mkApp(candA), appB = await mkApp(candB), appC = await mkApp(candC);
  for (const id of [appA, appB]) await api(`/api/applications/${id}/move`, { method: 'POST', token: recruiter, body: { status: 'interviewing' } });
  const statusOf = async (id) => (await api(`/api/applications/${id}`, { token: recruiter })).json.application.status;

  const ivMeta = (await api('/api/interviews/meta/form', { token: recruiter })).json;
  const mona = ivMeta.interviewers.find((u) => u.name === 'Mona Sami');
  const nadia = ivMeta.interviewers.find((u) => u.name === 'Nadia Fouad');
  const day = (n) => new Date(Date.now() + n * 86400000).toISOString();
  const iv1 = (await api('/api/interviews', { method: 'POST', token: recruiter, body: { applicationId: appA, interviewType: 'technical', scheduledAt: day(2), panel: [{ interviewerId: mona.id, isLead: true }] } })).json.interview;
  const iv2 = (await api('/api/interviews', { method: 'POST', token: recruiter, body: { applicationId: appA, interviewType: 'final', scheduledAt: day(5), panel: [{ interviewerId: mona.id }] } })).json.interview;
  await api(`/api/interviews/${iv2.id}/status`, { method: 'POST', token: recruiter, body: { status: 'cancelled', reason: 'Rescheduled' } });
  await api('/api/interviews', { method: 'POST', token: recruiter, body: { applicationId: appB, interviewType: 'hr', scheduledAt: day(3), panel: [{ interviewerId: nadia.id }] } });

  // ── Metadata: exact PDF wording ──
  console.log('\n— PDF metadata —');
  const meta = (await api('/api/assessments/meta', { token: interviewer })).json;
  c('five behavioral rows, exact labels/descriptions', JSON.stringify(meta.behavioralCriteria.map((x) => [x.label, x.description])) === JSON.stringify([
    ['Openness', 'Adaptability, learning agility, response to new systems and processes.'],
    ['Conscientiousness', 'Reliability, follow-through, accountability, documentation discipline.'],
    ['Extraversion', 'Communication clarity, assertiveness, stakeholder coordination.'],
    ['Agreeableness', 'Cooperation, respect, teamwork without passivity.'],
    ['Emotional Stability', 'Composure under pressure, stress tolerance, conflict response.']]));
  c('five technical rows, exact labels/descriptions', JSON.stringify(meta.technicalCriteria.map((x) => [x.label, x.description])) === JSON.stringify([
    ['Technical Knowledge', 'Role-specific expertise and depth of knowledge for the position.'],
    ['Relevant Experience', 'Years, project complexity and similarity to current scope.'],
    ['Problem-Solving', 'Critical thinking, structured approach, sound decision-making.'],
    ['Tools & Software', 'Proficiency with role-required software, systems and tools.'],
    ['Planning & Organizing', 'Prioritization, scheduling, resource and risk management.']]));
  c('behavioral instruction text', meta.behavioralInstruction === 'Score each trait based on specific examples and observed evidence.');
  c('score guide + N/A', JSON.stringify(meta.scoreGuide) === JSON.stringify({ 1: 'Unsuitable', 2: 'Below Standard', 3: 'Average', 4: 'Proficient', 5: 'Excellent' }) && meta.naLabel === 'Not Applicable');
  c('critical flags exact', JSON.stringify(meta.criticalFlags.map((f) => f.label)) === JSON.stringify(['Repeated blaming of others or no ownership', 'No specific examples or evidence provided', 'Inconsistencies between CV and stated experience']));
  const pdfDecisions = ['Proceed', 'Proceed with Conditions', 'Hold', 'CV Pool', 'Reject'];
  c('evaluator decisions are the PDF choices', JSON.stringify(meta.decisions.map((d) => d.label)) === JSON.stringify(pdfDecisions));
  c('final decisions are the PDF choices (no Hired)', JSON.stringify(meta.finalDecisions.map((d) => d.label)) === JSON.stringify(pdfDecisions));

  // ── Context ──
  console.log('\n— Context from real linked records —');
  const getA = async (t = hrMgr) => (await api(`/api/assessments/application/${appA}`, { token: t }));
  const bA = (await getA()).json.assessment;
  const ctx = bA.context || {};
  c('full name / position / department resolved by id', ctx.fullName === EVIL && ctx.position === 'Site Engineer' && ctx.department === dept.name, JSON.stringify(ctx));
  c('interview date = latest NON-cancelled interview with reference', ctx.interview?.interviewNo === iv1.interviewNo && ctx.interview.scheduledAt === new Date(iv1.scheduledAt).toISOString(), JSON.stringify(ctx.interview));
  c('zero years of experience preserved', ctx.yearsExperience === 0);
  c('education, employer, notice from candidate', ctx.education === 'Civil Engineering, Cairo University (2015)' && ctx.currentEmployer === 'Orascom' && ctx.noticePeriod === '1 month');
  c('current salary has no source → null', ctx.currentSalary === null);
  c('salary.view holder sees expected salary', ctx.salaryVisible === true && ctx.expectedSalary === 45123);
  const recA = await getA(recruiter);
  c('without salary.view: salary withheld from JSON, not just hidden', recA.json?.assessment?.context?.salaryVisible === false && !('expectedSalary' in (recA.json?.assessment?.context || { expectedSalary: 1 })) && !recA.text.includes('45123'));
  const ctxC = (await api(`/api/assessments/application/${appC}`, { token: hrMgr })).json?.assessment?.context;
  c('missing data stays missing (no interview, no invented values)', ctxC?.interview === null && ctxC?.education === null && ctxC?.yearsExperience === null && ctxC?.currentEmployer === null);

  // ── Validation (nothing persists on rejection) ──
  console.log('\n— Strict server validation —');
  const post = (body, t = interviewer, id = appA) => api(`/api/assessments/application/${id}`, { method: 'POST', token: t, body });
  const bad = [
    ['score 0', { evaluatorType: 'hr', behavioral: { openness: { score: 0 } } }],
    ['score 6', { evaluatorType: 'hr', behavioral: { openness: { score: 6 } } }],
    ['fractional', { evaluatorType: 'hr', behavioral: { openness: { score: 3.5 } } }],
    ['numeric string', { evaluatorType: 'hr', behavioral: { openness: { score: '4' } } }],
    ['scalar row', { evaluatorType: 'hr', behavioral: { openness: 4 } }],
    ['array section', { evaluatorType: 'hr', behavioral: [{ score: 4 }] }],
    ['array row', { evaluatorType: 'hr', behavioral: { openness: [4] } }],
    ['unknown criterion', { evaluatorType: 'hr', behavioral: { charisma: { score: 4 } } }],
    ['technical key in HR section', { evaluatorType: 'hr', behavioral: { technical_knowledge: { score: 4 } } }],
    ['unknown row field', { evaluatorType: 'hr', behavioral: { openness: { score: 4, weight: 2 } } }],
    ['non-string notes', { evaluatorType: 'hr', behavioral: { openness: { score: 4, notes: 5 } } }],
    ['oversized notes', { evaluatorType: 'hr', behavioral: { openness: { score: 4, notes: 'x'.repeat(A.NOTES_MAX + 1) } } }],
    ['unknown flag', { evaluatorType: 'hr', criticalFlags: { lying: true } }],
    ['non-boolean flag', { evaluatorType: 'hr', criticalFlags: { blaming: 'yes' } }],
    ['invalid recommendation', { evaluatorType: 'hr', recommendation: 'hired' }],
    ['submitted not boolean', { evaluatorType: 'hr', submitted: 'true' }],
    ['other section on HR', { evaluatorType: 'hr', technical: {} }],
    ['bad evaluatorType', { evaluatorType: 'final' }],
  ];
  for (const [name, body] of bad) { const r = await post(body); c(`rejects ${name} (400)`, r.status === 400, `${r.status} ${r.text}`); }
  c('no record created by rejected writes', !raw(appA, 'hr'));

  // ── Identity / target tampering ──
  console.log('\n— Identity and target cannot be overridden —');
  for (const [name, extra] of [['applicationId', { applicationId: appB }], ['evaluatorId', { evaluatorId: 1 }], ['evaluatorName', { evaluatorName: 'Layla Hassan' }], ['updatedAt', { updatedAt: '2000-01-01T00:00:00Z' }], ['id', { id: 99 }]]) {
    const r = await post({ evaluatorType: 'hr', behavioral: { openness: { score: 4 } }, ...extra });
    c(`rejects client ${name} (400)`, r.status === 400, `${r.status}`);
  }
  c('target application B untouched by tampering', !raw(appB, 'hr') && !raw(appA, 'hr'));

  // ── Scope ──
  console.log('\n— Scope: assigned vs unrelated actors —');
  c('panel interviewer reads assigned app (200)', (await getA(interviewer)).status === 200);
  c('viewer (view_all) reads (200)', (await getA(viewer)).status === 200);
  c('unrelated scoped actor: read denied (403)', (await getA(hm)).status === 403);
  c('unrelated scoped actor: write denied (403)', (await post({ evaluatorType: 'hr' }, hm)).status === 403);
  c('unrelated scoped actor: final denied (403)', (await api(`/api/assessments/application/${appA}/final`, { method: 'POST', token: hm, body: { decision: 'proceed' } })).status === 403);
  c('unrelated scoped actor: preview denied (403)', (await api(`/api/assessments/application/${appA}/preview`, { token: hm })).status === 403);
  c('candidate.view without interview scope: read denied (403)', (await getA(pm)).status === 403);
  c('viewer without interview.feedback: write denied (403)', (await post({ evaluatorType: 'hr' }, viewer)).status === 403);
  c('second scoped actor reads own assigned app (200)', (await api(`/api/assessments/application/${appB}`, { token: hm })).status === 200);
  c('second scoped actor writes own assigned app (201)', (await post({ evaluatorType: 'technical', technical: { technical_knowledge: { score: 3 } } }, hm, appB)).status === 201);
  c('first scoped actor cannot read the other app (403)', (await api(`/api/assessments/application/${appB}`, { token: interviewer })).status === 403);
  c('unrelated actor still cannot write by naming its own app in the body', (await post({ evaluatorType: 'hr', applicationId: appB }, hm)).status === 403 && !raw(appA, 'hr'));

  // ── Draft → reload → submit (HR) ──
  console.log('\n— HR draft with N/A and notes, reload, submit —');
  const draftBody = { evaluatorType: 'hr', submitted: false, behavioral: {
    openness: { score: 4, notes: 'Led ERP rollout <b>x</b>' },
    conscientiousness: { score: 'na', notes: 'Not observable in this round' },
    extraversion: { score: null, notes: 'Follow up on stakeholder example' },
  }, criticalFlags: { no_evidence: true }, behavioralJustification: '<script>alert(1)</script> steady' };
  const d1 = await post(draftBody);
  c('partial HR draft saved (201)', d1.status === 201, d1.text);
  const stored = JSON.parse(raw(appA, 'hr').behavioral);
  c('stored JSON is canonical: N/A string, unanswered has no score property', stored.conscientiousness.score === 'na' && !('score' in stored.extraversion) && stored.extraversion.notes && !('agreeableness' in stored), JSON.stringify(stored));
  const hr1 = (await getA(interviewer)).json?.assessment?.hr;
  c('reload: status Draft', hr1?.status === 'draft' && hr1?.submitted === false);
  c('reload: score, N/A and notes round-trip', hr1?.rows?.openness.score === 4 && hr1?.rows?.openness.notes === 'Led ERP rollout <b>x</b>' && hr1?.rows?.conscientiousness.score === 'na' && hr1?.rows?.extraversion.score === null && hr1?.rows?.extraversion.notes === 'Follow up on stakeholder example');
  c('reload: summary counts', hr1?.summary?.average === 4 && hr1?.summary?.scoredCount === 1 && hr1?.summary?.naCount === 1 && hr1?.summary?.unansweredCount === 3);
  c('flag → review required (no auto reject)', hr1?.reviewRequired === true && (await statusOf(appA)) === 'interviewing');
  c('actual saver + UTC timestamp', hr1?.evaluatorName === 'Mona Sami' && /Z$/.test(hr1?.updatedAt) && !isNaN(Date.parse(hr1?.updatedAt)));
  c('HR and technical are independent', (await getA(interviewer)).json?.assessment?.technical === null);

  const incomplete = await post({ ...draftBody, submitted: true, recommendation: 'proceed' });
  c('submit with unanswered rows rejected (400) and names them', incomplete.status === 400 && /Extraversion/.test(incomplete.json?.error || ''));
  const full = { ...draftBody, submitted: true, behavioral: { ...draftBody.behavioral, extraversion: { score: 5, notes: 'Clear' }, agreeableness: { score: 4 }, emotional_stability: { score: 5 } } };
  const noRec = await post(full);
  c('submit without recommendation rejected (400)', noRec.status === 400);
  c('failed submits left the draft intact', raw(appA, 'hr').submitted === 0 && JSON.parse(raw(appA, 'hr').behavioral).extraversion.notes === 'Follow up on stakeholder example');
  const sub = await post({ ...full, recommendation: 'proceed_conditions', behavioralFit: 'weak' });
  const hr2 = sub.json?.assessment?.hr;
  c('HR submitted (201) with submitted:true', sub.status === 201 && hr2?.status === 'submitted');
  c('average from numeric rows only: (4+5+4+5)/4 = 4.5 Strong', hr2?.summary?.average === 4.5 && hr2?.summary?.naCount === 1 && hr2?.computedFit === 'strong');
  c('conflicting client fit ignored; server-derived fit stored', raw(appA, 'hr').behavioral_fit === 'strong' && hr2?.fitHistorical === false);
  c('recommendation saved; application stage unchanged', hr2?.recommendation === 'proceed_conditions' && (await statusOf(appA)) === 'interviewing');

  // ── Technical: all N/A, then edited by another actor ──
  console.log('\n— Technical evaluation, all-N/A, multiple editors —');
  const t1 = await post({ evaluatorType: 'technical', submitted: true, technical: rowsOf(TECH_KEYS, ['na', 'na', 'na', 'na', 'na']), recommendation: 'hold' }, recruiter);
  const tech1 = t1.json?.assessment?.technical;
  c('all-N/A technical submit allowed (201)', t1.status === 201 && tech1?.submitted);
  c('all-N/A is Not rated (null average and fit)', tech1?.summary?.average === null && tech1?.computedFit === null && tech1?.summary?.naCount === 5);
  c('HR untouched by technical write', t1.json?.assessment?.hr?.rows?.openness.score === 4 && t1.json?.assessment?.hr?.evaluatorName === 'Mona Sami');
  const t2 = await post({ evaluatorType: 'technical', submitted: true, technical: rowsOf(TECH_KEYS, [4, 4, 3, 'na', 4], ['', '', 'Structured', '', '']), recommendation: 'proceed' }, hrMgr);
  const tech2 = t2.json?.assessment?.technical;
  c('edit by second actor updates last-saved identity', tech2?.evaluatorName === 'Omar Khalil' && raw(appA, 'technical').evaluator_name === 'Omar Khalil');
  c('(4+4+3+4)/4 = 3.75 → 3.8 Acceptable', tech2?.summary?.average === 3.8 && tech2?.computedFit === 'acceptable');
  const hrEdit = await post({ ...full, recommendation: 'proceed_conditions', submitted: true }, recruiter);
  c('HR edited by another authorized actor → editor recorded', hrEdit.json?.assessment?.hr?.evaluatorName === 'Karim Adel');

  // ── Audit ──
  console.log('\n— Audit trail —');
  const logs = (await api('/api/audit?pageSize=500', { token: admin })).json.logs.filter((l) => l.entityType === 'application' && String(l.entityId) === String(appA) && l.action.startsWith('assessment.'));
  const draftLog = logs.find((l) => l.action === 'assessment.draft_saved');
  c('draft audited as assessment.draft_saved with state', draftLog && draftLog.newValue?.state === 'draft' && draftLog.newValue?.evaluatorType === 'hr' && draftLog.actorName === 'Mona Sami');
  const subLog = logs.find((l) => l.action === 'assessment.submitted' && l.newValue?.evaluatorType === 'hr');
  c('submission audited as assessment.submitted with previous draft', subLog && subLog.newValue?.state === 'submitted' && subLog.oldValue?.state === 'draft' && subLog.newValue?.scores.conscientiousness.score === 'na');
  const updLogs = logs.filter((l) => l.action === 'assessment.updated');
  c('edits audited as assessment.updated with previous author', updLogs.some((l) => l.oldValue?.evaluatorName === 'Karim Adel' && l.newValue?.evaluatorName === 'Omar Khalil') && updLogs.some((l) => l.oldValue?.evaluatorName === 'Mona Sami' && l.newValue?.evaluatorName === 'Karim Adel'));
  c('no assessment audit payload carries salary', !JSON.stringify(logs).includes('45123'));

  // ── Rollback when the audit write fails ──
  console.log('\n— Atomic persistence + audit —');
  const before = raw(appA, 'hr');
  const realWrite = Audit.write;
  Audit.write = () => { throw new Error('simulated audit failure'); };
  let rb;
  try { rb = await post({ ...full, recommendation: 'reject', submitted: true }, recruiter); }
  finally { Audit.write = realWrite; }
  const after = raw(appA, 'hr');
  c('audit failure fails the request', rb.status >= 500, `${rb.status}`);
  c('…and leaves no unaudited change', after.recommendation === before.recommendation && after.updated_at === before.updated_at && after.evaluator_name === before.evaluator_name);
  const fdBefore = db.get('SELECT * FROM application_final_decision WHERE application_id=?', [appA]);
  Audit.write = () => { throw new Error('simulated audit failure'); };
  let rbf;
  try { rbf = await api(`/api/assessments/application/${appA}/final`, { method: 'POST', token: hrMgr, body: { decision: 'reject' } }); }
  finally { Audit.write = realWrite; }
  c('final decision rolls back with its audit', rbf.status >= 500 && !db.get('SELECT * FROM application_final_decision WHERE application_id=?', [appA]) && !fdBefore);

  // ── Final decision ──
  console.log('\n— Shared final decision —');
  const fin = (body, t = hrMgr, id = appA) => api(`/api/assessments/application/${id}/final`, { method: 'POST', token: t, body });
  c('locked stage: evaluation write denied (409)', (await post({ evaluatorType: 'hr' }, hrMgr, appC)).status === 409);
  c('locked stage: final decision denied (409)', (await fin({ decision: 'proceed' }, hrMgr, appC)).status === 409);
  c('new final write of historical "hired" rejected (400)', (await fin({ decision: 'hired' })).status === 400);
  c('final decision cannot carry identity (400)', (await fin({ decision: 'proceed', decidedBy: 1 })).status === 400);
  const f1 = await fin({ decision: 'proceed_conditions', notes: 'Pending <i>reference</i>' });
  c('Proceed with Conditions recorded (201)', f1.status === 201 && f1.json?.assessment?.finalDecision?.decision === 'proceed_conditions' && f1.json?.assessment?.finalDecision?.decidedByName === 'Omar Khalil' && /Z$/.test(f1.json?.assessment?.finalDecision?.decidedAt));
  c('final decision does not move the application', (await statusOf(appA)) === 'interviewing');
  c('CV Pool accepted for a scoped panel member', (await fin({ decision: 'cv_pool' }, interviewer)).status === 201);
  await fin({ decision: 'proceed_conditions', notes: 'Pending <i>reference</i>' });
  const finLog = (await api('/api/audit?pageSize=500', { token: admin })).json.logs.find((l) => l.action === 'assessment.final_decision' && String(l.entityId) === String(appA) && l.oldValue?.decision === 'cv_pool');
  c('final decision audited with previous value and actor', finLog && finLog.newValue?.decision === 'proceed_conditions' && finLog.oldValue.decidedByName === 'Mona Sami');

  // ── Legacy history (read only, never rewritten) ──
  console.log('\n— Legacy records —');
  db.run(`INSERT INTO application_assessment (application_id,evaluator_type,evaluator_id,evaluator_name,behavioral,critical_flags,recommendation,behavioral_fit,submitted)
          VALUES (?,?,?,?,?,?,?,?,1)`, [appB, 'hr', null, 'Legacy Author', JSON.stringify({ openness: { score: null }, conscientiousness: 4, extraversion: { score: 3 } }), JSON.stringify({ blaming: true }), 'proceed', 'strong']);
  db.run(`INSERT INTO application_final_decision (application_id,decision,decided_by_name,decided_at) VALUES (?,?,?,datetime('now'))`, [appB, 'hired', 'Legacy Decider']);
  const legacyRawBefore = JSON.stringify(raw(appB, 'hr'));
  const lb = (await api(`/api/assessments/application/${appB}`, { token: hrMgr })).json.assessment;
  c('legacy {score:null} reads as N/A; scalar 4 reads as 4', lb?.hr?.rows?.openness.score === 'na' && lb?.hr?.rows?.conscientiousness.score === 4 && lb?.hr?.rows?.extraversion.score === 3 && lb?.hr?.rows?.agreeableness.score === null);
  c('legacy summary: (4+3)/2 = 3.5 Acceptable, 1 N/A', lb?.hr?.summary?.average === 3.5 && lb?.hr?.summary?.naCount === 1 && lb?.hr?.computedFit === 'acceptable');
  c('manual historical fit kept visible as historical', lb?.hr?.savedFit === 'strong' && lb?.hr?.fitHistorical === true);
  c('legacy SQLite timestamp served as UTC ISO', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(lb?.hr?.updatedAt), lb?.hr?.updatedAt);
  c('historical final "hired" shown as historical, unconverted', lb?.finalDecision?.decision === 'hired' && lb?.finalDecision?.historical === true && lb?.finalDecision?.decisionLabel === 'Hired (historical)');
  c('viewing never rewrote stored history', JSON.stringify(raw(appB, 'hr')) === legacyRawBefore && db.get('SELECT decision FROM application_final_decision WHERE application_id=?', [appB]).decision === 'hired');

  // ── Preview ──
  console.log('\n— Escaped, masked, scoped preview —');
  const pvHr = await api(`/api/assessments/application/${appA}/preview`, { token: hrMgr });
  const pvRec = await api(`/api/assessments/application/${appA}/preview`, { token: recruiter });
  c('preview served as HTML with a no-script CSP', pvHr.status === 200 && /text\/html/.test(pvHr.headers.get('content-type')) && /default-src 'none'/.test(pvHr.headers.get('content-security-policy') || ''));
  c('candidate name escaped', pvHr.text.includes('&lt;img src=x onerror=alert(1)&gt;Ali &quot;Q&quot; &amp; Co') && !pvHr.text.includes('<img src=x'));
  c('notes / justification escaped, never executed', pvHr.text.includes('&lt;script&gt;alert(1)&lt;/script&gt;') && !/<script/i.test(pvHr.text) && pvHr.text.includes('Led ERP rollout &lt;b&gt;x&lt;/b&gt;') && pvHr.text.includes('Pending &lt;i&gt;reference&lt;/i&gt;'));
  c('real department + interview reference, never render-time date', pvHr.text.includes(dept.name) && pvHr.text.includes(iv1.interviewNo) && !pvHr.text.includes('</span>Engineering</div>'));
  c('salary shown to salary.view holder', pvHr.text.includes('45123'));
  c('salary omitted from preview without salary.view (no "Restricted" placeholder)', !pvRec.text.includes('45123') && !pvRec.text.includes('Restricted') && !pvRec.text.includes('Expected Salary') && pvHr.text.includes('Expected Salary'));
  c('N/A, notes, counts, flags, recommendation, actor shown', pvHr.text.includes('N/A — Not Applicable') && pvHr.text.includes('Not observable in this round') && /Scored: 4 · N\/A: 1/.test(pvHr.text) && pvHr.text.includes('Review required') && pvHr.text.includes('Proceed with Conditions') && pvHr.text.includes('Karim Adel') && pvHr.text.includes('Omar Khalil'));
  c('PDF section titles and justification label', pvHr.text.includes('INTERVIEW ASSESSMENT FORM') && pvHr.text.includes('ASSESSMENT &amp; EVALUATION') && pvHr.text.includes('Critical Flags — Review if Any Are True') && pvHr.text.includes('Justification / Key Strengths'));
  c('no overall score or suggested pipeline move', !/Overall Score|Suggested/i.test(pvHr.text));
  c('both submitted → not labelled draft', !pvHr.text.includes('DRAFT PREVIEW'));
  await post({ evaluatorType: 'technical', submitted: false, technical: rowsOf(TECH_KEYS, [4, 4, 3, null, 4]) }, hrMgr);
  const pvDraft = await api(`/api/assessments/application/${appA}/preview`, { token: hrMgr });
  c('editing back to draft is truthful in JSON and preview', (await getA()).json?.assessment?.technical?.status === 'draft' && pvDraft.text.includes('DRAFT PREVIEW'));
  const pvC = await api(`/api/assessments/application/${appC}/preview`, { token: hrMgr });
  c('no interview → "Not recorded", not today', pvC.status === 200 && /Interview Date<\/div><div class="v">Not recorded/.test(pvC.text) && /Interview Date:<\/strong> <span class="line">Not recorded/.test(pvC.text));
  c('no fabricated signatures', !/signed|e-signature/i.test(pvHr.text));
} catch (e) {
  console.error(e); fail++;
} finally {
  console.log(`\n=== ASSESSMENT PDF: ${pass} passed, ${fail} failed ===\n`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.exit(fail ? 1 : 0);
}
