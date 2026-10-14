// Packet 02 — role-controlled assessment: the central field-policy resolver and
// every layer that must obey it (API serialization, API writes, preview,
// settings). Real legacy HTTP routes against a disposable SQLite database and
// upload directory, under the DEFAULT policy unless a test changes it.
import { suiteDatabaseUrl } from './test-support/suite-db.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'arabtec-policy-'));
process.env.DATABASE_URL = suiteDatabaseUrl('file:' + path.join(TMP, 'policy.db'));
process.env.UPLOAD_DIR = path.join(TMP, 'uploads');
process.env.PORT = process.env.POLICY_TEST_PORT || '4393';
process.env.SEED_DEMO_DATA ||= 'true';
process.env.SMTP_TRANSPORT = 'json';
const { adminToken, ADMIN_BOOTSTRAP_PASSWORD } = await import('./test-support/admin-session.mjs');
process.env.SEED_ADMIN_PASSWORD ||= ADMIN_BOOTSTRAP_PASSWORD;

await import('./prisma/seed.js');
await import('./src/server.js');
const { waitForReady } = await import('./test-support/wait-ready.mjs');
const B = 'http://localhost:' + process.env.PORT;
await waitForReady(B);
const db = await import('./src/lib/db.js');
const P = await import('./src/lib/assessment-policy.js');

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
const TECH = ['technical_knowledge', 'relevant_experience', 'problem_solving', 'tools_software', 'planning_organizing'];
const HRK = ['openness', 'conscientiousness', 'extraversion', 'agreeableness', 'emotional_stability'];
const rows = (keys, s) => Object.fromEntries(keys.map((k, i) => [k, { score: Array.isArray(s) ? s[i] : s, notes: '' }]));

try {
  // ── Resolver, directly ──
  console.log('\n— Central resolver —');
  const app = { id: 999999, status: 'interviewing', request_id: null };
  const user = (roles, permissions) => ({ id: 1, roles, permissions });
  const FULL = ['candidate.view', 'interview.view_all', 'interview.feedback', 'salary.view'];
  const r = (u, key, overrides = {}) => P.resolveAssessmentPermission({ user: u, application: app, fieldKey: key, overrides });
  const tech = user(['interviewer'], ['candidate.view', 'interview.view_all', 'interview.feedback']);
  const hr = user(['hr_manager'], FULL);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  c('canView false / canEdit false (technical → behavioral)', same(r(tech, 'assessment.behavioral'), { canView: false, canEdit: false }));
  c('canView true / canEdit false (technical → final recommendation)', same(r(tech, 'assessment.finalRecommendation'), { canView: true, canEdit: false }));
  c('canView true / canEdit true (technical → technical)', same(r(tech, 'assessment.technical'), { canView: true, canEdit: true }));
  c('section inheritance: a criterion follows its section', same(r(tech, 'assessment.technical.toolsSoftware'), { canView: true, canEdit: true }) && same(r(tech, 'assessment.behavioral.openness'), { canView: false, canEdit: false }));
  c('field override beats its section', same(r(tech, 'assessment.technical.toolsSoftware', { technical: { 'assessment.technical.toolsSoftware': { view: true, edit: false } } }), { canView: true, canEdit: false }));
  c('field-level default beats section (technical justification editable, final read-only)', same(r(tech, 'assessment.finalRecommendation.technicalJustification'), { canView: true, canEdit: true }));
  c('salary: policy allows HR, salary.view still required', r(hr, 'assessment.candidate.expectedSalary').canView === true
    && r(user(['recruiter'], ['candidate.view', 'interview.view_all', 'interview.feedback']), 'assessment.candidate.expectedSalary').canView === false);
  c('salary hidden from technical even with salary.view', r(user(['interviewer'], [...FULL]), 'assessment.candidate.currentSalary').canView === false);
  c('candidate details are never editable from the assessment', r(hr, 'assessment.candidate.fullName').canEdit === false);
  c('policy cannot widen access: no candidate.view → nothing', r(user(['hr_manager'], ['interview.view_all', 'interview.feedback']), 'assessment.technical').canView === false);
  c('locked stage → view but no edit', P.resolveAssessmentPermission({ user: hr, application: { ...app, status: 'matched' }, fieldKey: 'assessment.behavioral', overrides: {} }).canEdit === false);
  c('several roles → union of their audiences', same(r(user(['interviewer', 'hr_manager'], FULL), 'assessment.behavioral'), { canView: true, canEdit: true }));
  c('unmapped role → "other" audience (view-only)', same(r(user(['viewer'], ['candidate.view', 'interview.view_all', 'interview.feedback']), 'assessment.technical'), { canView: true, canEdit: false }));
  for (const [name, bad] of [['unknown audience', { ceo: {} }], ['unknown key', { hr: { 'assessment.salary': { view: true, edit: false } } }],
    ['edit while hidden', { hr: { 'assessment.behavioral': { view: false, edit: true } } }], ['candidate edit', { hr: { 'assessment.candidate.fullName': { view: true, edit: true } } }],
    ['non-boolean', { hr: { 'assessment.behavioral': { view: 'yes', edit: false } } }], ['extra prop', { hr: { 'assessment.behavioral': { view: true, edit: false, x: 1 } } }]]) {
    c(`validator rejects ${name}`, !!P.validatePolicyOverrides(bad).error);
  }

  // ── Fixture ──
  const admin = await adminToken(B);
  const hrMgr = await login('hr.manager@arabtec.com');
  const hrDir = await login('hr.director@arabtec.com');
  const recMgr = await login('rec.manager@arabtec.com');
  const recruiter = await login('recruiter@arabtec.com');
  const interviewer = await login('interviewer@arabtec.com');   // Mona Sami — Technical Interviewer
  const hm = await login('hiring.manager@arabtec.com');         // Nadia Fouad
  const rmeta = (await api('/api/requests/meta/form', { token: hrMgr })).json;
  const recId = rmeta.recruiters.find((x) => x.name === 'Karim Adel').id;
  async function request(token, title) {
    const cr = await api('/api/requests', { method: 'POST', token, body: { title, justification: 'new_hire', projectId: rmeta.projects[0].id, departmentId: rmeta.departments[0].id, location: 'Cairo', headcount: 2, priority: 'high' } });
    const id = cr.json.request.id;
    await api(`/api/requests/${id}/submit`, { method: 'POST', token });
    await api(`/api/requests/${id}/approve`, { method: 'POST', token: hrDir, body: {} });
    await api(`/api/requests/${id}/assign`, { method: 'POST', token: recMgr, body: { ownerId: recId } });
    return id;
  }
  const r1 = await request(hrMgr, 'Planning Engineer');
  const r2 = await request(hm, 'Planning Coordinator'); // the hiring manager's own request
  const cand = (await api('/api/candidates', { method: 'POST', token: hrMgr, body: { fullName: 'Salma Policy', phone: '+201000000301', expectedSalary: 61234, yearsExperience: 6, noticePeriod: '2 weeks' } })).json.candidate;
  const cand2 = (await api('/api/candidates', { method: 'POST', token: hrMgr, body: { fullName: 'Hany Second', phone: '+201000000302' } })).json.candidate;
  const appA = (await api('/api/applications', { method: 'POST', token: recruiter, body: { candidateId: cand.id, requestId: r1, initialStatus: 'matched' } })).json.application.id;
  const appB = (await api('/api/applications', { method: 'POST', token: recruiter, body: { candidateId: cand2.id, requestId: r2, initialStatus: 'matched' } })).json.application.id;
  for (const id of [appA, appB]) await api(`/api/applications/${id}/move`, { method: 'POST', token: recruiter, body: { status: 'interviewing' } });
  const ivMeta = (await api('/api/interviews/meta/form', { token: recruiter })).json;
  const mona = ivMeta.interviewers.find((u) => u.name === 'Mona Sami');
  const iv = (await api('/api/interviews', { method: 'POST', token: recruiter, body: { applicationId: appA, interviewType: 'technical', scheduledAt: new Date(Date.now() + 86400000).toISOString(), panel: [{ interviewerId: mona.id, isLead: true }] } })).json.interview;
  const get = (t, id = appA) => api(`/api/assessments/application/${id}`, { token: t });
  const post = (t, body, id = appA) => api(`/api/assessments/application/${id}`, { method: 'POST', token: t, body });

  // ── Technical interviewer: serialization ──
  console.log('\n— Technical Interviewer: what the API returns —');
  const tv = await get(interviewer);
  const tb = tv.json?.assessment;
  c('assigned technical interviewer can read (200)', tv.status === 200);
  c('currentSalary key absent', tb && !('currentSalary' in tb.context));
  c('expectedSalary key absent', tb && !('expectedSalary' in tb.context));
  c('no salary value anywhere in the response', !tv.text.includes('61234'));
  c('non-confidential context present (name, years, availability, interview)', tb.context.fullName === 'Salma Policy' && tb.context.yearsExperience === 6 && tb.context.noticePeriod === '2 weeks' && tb.context.interview?.interviewNo === iv.interviewNo);
  c('permission metadata travels with the bundle', tb.permissions['assessment.technical'].canEdit === true && tb.permissions['assessment.behavioral'].canView === false && tb.permissions['assessment.finalRecommendation'].canEdit === false);

  // ── HR: serialization ──
  const hb = (await get(hrMgr)).json.assessment;
  c('HR manager receives salary fields', hb.context.expectedSalary === 61234 && 'currentSalary' in hb.context);
  // Owner decision 2026-10-05: the recruitment team edits both sections (was: technical view-only).
  c('HR manager: behavioral, technical and final all editable', hb.permissions['assessment.behavioral'].canEdit && hb.permissions['assessment.technical'].canEdit && hb.permissions['assessment.finalRecommendation.technicalJustification'].canEdit && hb.permissions['assessment.finalRecommendation'].canEdit);

  // ── Writes ──
  console.log('\n— Field-level write authorization —');
  const salaryWrite = await post(interviewer, { evaluatorType: 'technical', technical: { technical_knowledge: { score: 4 } }, currentSalary: 1000 });
  c('technical score + currentSalary → rejected (403) naming the field', salaryWrite.status === 403 && salaryWrite.json?.field === 'assessment.candidate.currentSalary');
  c('…and nothing was persisted', !raw(appA, 'technical'));
  c('expectedSalary write rejected (403)', (await post(interviewer, { evaluatorType: 'technical', expectedSalary: 1 })).status === 403);
  c('technical interviewer cannot write the behavioral section (403)', (await post(interviewer, { evaluatorType: 'hr', behavioral: { openness: { score: 5 } } })).status === 403 && !raw(appA, 'hr'));
  c('technical interviewer cannot record the final decision (403)', (await api(`/api/assessments/application/${appA}/final`, { method: 'POST', token: interviewer, body: { decision: 'proceed' } })).status === 403);
  c('technical interviewer cannot change the behavioral justification', (await post(interviewer, { evaluatorType: 'hr', behavioralJustification: 'x' })).status === 403);
  const techDraft = await post(interviewer, { evaluatorType: 'technical', technical: rows(TECH, [4, 4, 3, 'na', 4]), criticalFlags: { no_evidence: true }, recommendation: 'proceed', technicalJustification: 'Strong site planning' });
  c('technical section editable by the technical interviewer (201)', techDraft.status === 201);
  c('…saved as Mona Sami', raw(appA, 'technical').evaluator_name === 'Mona Sami');
  // The write itself is covered by assessment_team_edit_test.mjs; here the
  // technical record must stay as the interviewer saved it for the checks below.
  c('HR manager may now change technical scores (policy grants edit)', hb.permissions['assessment.technical.technicalKnowledge'].canEdit === true);
  const hrSave = await post(hrMgr, { evaluatorType: 'hr', submitted: true, behavioral: rows(HRK, [5, 4, 'na', 4, 5]), criticalFlags: { blaming: false, no_evidence: false, cv_inconsistency: false }, recommendation: 'proceed_conditions', behavioralJustification: 'Calm under pressure' });
  c('HR manager submits the behavioral section (201)', hrSave.status === 201);
  const t2 = raw(appA, 'technical');
  c('multi-evaluator: HR save left the technical record untouched', t2.evaluator_name === 'Mona Sami' && JSON.parse(t2.critical_flags).no_evidence === true && t2.technical_justification === 'Strong site planning');
  await post(interviewer, { evaluatorType: 'technical', submitted: true, technical: rows(TECH, [4, 4, 3, 'na', 5]) });
  const h2 = raw(appA, 'hr');
  c('multi-evaluator: technical submit left the HR record untouched', h2.evaluator_name === 'Omar Khalil' && h2.submitted === 1 && h2.behavioral_justification === 'Calm under pressure');
  c('omitted parts are kept, not cleared (technical justification + flags survive a scores-only save)', raw(appA, 'technical').technical_justification === 'Strong site planning' && JSON.parse(raw(appA, 'technical').critical_flags).no_evidence === true);
  c('HR manager records the final decision (201)', (await api(`/api/assessments/application/${appA}/final`, { method: 'POST', token: hrMgr, body: { decision: 'proceed_conditions' } })).status === 201);

  const tv2 = (await get(interviewer)).json.assessment;
  c('technical interviewer still never receives the behavioral section', tv2.hr === null && !JSON.stringify(tv2).includes('Calm under pressure'));
  c('technical interviewer sees the final decision read-only', tv2.finalDecision?.decision === 'proceed_conditions' && tv2.permissions['assessment.finalRecommendation'].canEdit === false);

  // ── Hiring manager (requester of their own request) ──
  console.log('\n— Hiring Manager —');
  const hmB = await get(hm, appB);
  c('hiring manager reads own request\'s application; salary withheld', hmB.status === 200 && !('expectedSalary' in hmB.json.assessment.context));
  c('hiring manager: behavioral view-only, technical editable (defaults)', hmB.json.assessment.permissions['assessment.behavioral'].canEdit === false && hmB.json.assessment.permissions['assessment.technical'].canEdit === true);
  c('hiring manager cannot write behavioral (403)', (await post(hm, { evaluatorType: 'hr', behavioral: { openness: { score: 3 } } }, appB)).status === 403);
  c('hiring manager still scoped: other request denied (403)', (await get(hm, appA)).status === 403);

  // ── Preview obeys the same policy ──
  console.log('\n— Preview follows the policy —');
  const pvT = await api(`/api/assessments/application/${appA}/preview`, { token: interviewer });
  const pvH = await api(`/api/assessments/application/${appA}/preview`, { token: hrMgr });
  c('technical preview: salary rows omitted, no "Restricted"', pvT.status === 200 && !/Current Salary|Expected Salary|61234|Restricted/.test(pvT.text));
  c('technical preview: behavioral section and its signature omitted', !pvT.text.includes('HR Assessment — Behavioral') && !pvT.text.includes('HR Interviewer') && !pvT.text.includes('Calm under pressure'));
  c('technical preview: technical section present', pvT.text.includes('Technical Assessment — Role Competency') && pvT.text.includes('Strong site planning'));
  c('HR preview: salary and both sections present', pvH.text.includes('Expected Salary') && pvH.text.includes('61234') && pvH.text.includes('HR Assessment — Behavioral') && pvH.text.includes('Technical Assessment — Role Competency'));
  c('preview keeps the no-script CSP and escaping', /default-src 'none'/.test(pvT.headers.get('content-security-policy') || '') && !/<script/i.test(pvT.text + pvH.text));

  // ── Settings endpoint ──
  console.log('\n— Assessment Visibility & Permissions —');
  c('technical interviewer cannot read the policy (403)', (await api('/api/assessments/policy', { token: interviewer })).status === 403);
  c('recruiter cannot read the policy (403)', (await api('/api/assessments/policy', { token: recruiter })).status === 403);
  // Settings are a system-administrator control: no HR or recruitment role holds it by default.
  for (const [who, tok] of [['HR manager', hrMgr], ['HR director', hrDir], ['recruitment manager', recMgr]]) {
    c(`${who} cannot read or change the policy (403)`, (await api('/api/assessments/policy', { token: tok })).status === 403
      && (await api('/api/assessments/policy', { method: 'PUT', token: tok, body: { overrides: {} } })).status === 403);
  }
  const pol = await api('/api/assessments/policy', { token: admin });
  c('system admin reads the policy (200) with audiences, sections, defaults', pol.status === 200 && pol.json.policy.audiences.length === 4 && pol.json.policy.sections.length === 5 && pol.json.policy.effective.technical['assessment.behavioral'].view === false);
  for (const [name, overrides] of [['unknown key', { technical: { nope: { view: true, edit: false } } }], ['edit while hidden', { technical: { 'assessment.behavioral': { view: false, edit: true } } }], ['salary edit', { hr: { 'assessment.candidate.currentSalary': { view: true, edit: true } } }]]) {
    c(`PUT rejects ${name} (400)`, (await api('/api/assessments/policy', { method: 'PUT', token: admin, body: { overrides } })).status === 400);
  }
  c('generic system settings cannot overwrite the policy (400)', (await api('/api/settings/system', { method: 'PUT', token: admin, body: { settings: { 'assessment.field_policy': '{}' } } })).status === 400);

  // Configuration proof: Technical Interviewer — Behavioral: Hidden → Read Only.
  const change = await api('/api/assessments/policy', { method: 'PUT', token: admin, body: { overrides: { technical: { 'assessment.behavioral': { view: true, edit: false } } } } });
  c('policy change saved (200)', change.status === 200 && change.json.policy.effective.technical['assessment.behavioral'].view === true);
  const after = (await get(interviewer)).json.assessment;
  c('runtime follows the change: behavioral now visible to the technical interviewer', after.hr?.rows?.openness?.score === 5 && after.permissions['assessment.behavioral'].canView === true);
  c('…and read-only', after.permissions['assessment.behavioral'].canEdit === false && (await post(interviewer, { evaluatorType: 'hr', behavioral: { openness: { score: 1 } } })).status === 403);
  c('behavioral justification still hidden (its own field default)', !('justification' in after.hr) && !JSON.stringify(after).includes('Calm under pressure'));
  const pvAfter = await api(`/api/assessments/application/${appA}/preview`, { token: interviewer });
  c('preview follows the change too', pvAfter.text.includes('HR Assessment — Behavioral'));
  const audit = (await api('/api/audit?pageSize=500', { token: admin })).json.logs.find((l) => l.action === 'assessment.policy_changed');
  c('policy change audited with actor and new value', audit && audit.actorRole === 'system_admin' && audit.newValue.technical['assessment.behavioral'].view === true);

  // Field override at runtime: hide one technical criterion from technical interviewers.
  await api('/api/assessments/policy', { method: 'PUT', token: admin, body: { overrides: { technical: { 'assessment.technical.toolsSoftware': { view: false, edit: false }, 'assessment.technical.problemSolving': { view: true, edit: false } } } } });
  const fo = (await get(interviewer)).json.assessment.technical;
  c('hidden criterion absent from rows, and the average it would reveal is withheld', !('tools_software' in fo.rows) && fo.summary === undefined && fo.computedFit === undefined);
  c('HR still sees that criterion', 'tools_software' in (await get(hrMgr)).json.assessment.technical.rows);
  c('read-only criterion: changing it is rejected (403)', (await post(interviewer, { evaluatorType: 'technical', technical: { problem_solving: { score: 5, notes: '' } } })).json?.field === 'assessment.technical.problemSolving');
  c('read-only criterion: sending it unchanged is accepted', (await post(interviewer, { evaluatorType: 'technical', technical: { problem_solving: { score: 3, notes: '' }, technical_knowledge: { score: 5, notes: '' } } })).status === 201);
  c('hidden criterion kept intact by a technical save', JSON.parse(raw(appA, 'technical').technical).tools_software.score === 'na');

  const reset = await api('/api/assessments/policy', { method: 'PUT', token: admin, body: { overrides: {} } });
  c('restore defaults (200)', reset.status === 200 && JSON.stringify(reset.json.policy.overrides) === '{}');
  c('defaults back in force: behavioral hidden again', (await get(interviewer)).json.assessment.hr === null);

  console.log('\n— Permission catalog —');
  const permsOf = async (t) => { const me = (await api('/api/auth/me', { token: t })).json; return me.user?.permissions || me.permissions || []; };
  c('system admin holds interview.assessment_policy', (await permsOf(admin)).includes('interview.assessment_policy'));
  c('no other default role holds it', !(await permsOf(hrMgr)).includes('interview.assessment_policy') && !(await permsOf(hrDir)).includes('interview.assessment_policy') && !(await permsOf(recMgr)).includes('interview.assessment_policy'));
} catch (e) {
  console.error(e); fail++;
} finally {
  console.log(`\n=== ASSESSMENT POLICY: ${pass} passed, ${fail} failed ===\n`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.exit(fail ? 1 : 0);
}
