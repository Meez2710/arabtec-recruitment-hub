// Assessment controlled by the recruitment team (owner decision, 5 Oct 2026).
//   • each recruitment role edits both sections and the final decision
//   • the HR Director views only; technical interviewers keep their narrow
//     rights; unrelated users see nothing; salary stays protected
//   • a submitted evaluation is changed deliberately: reopen with a reason,
//     or an update carrying an edit reason — both audited and in the history
//   • the history lists only the parts the viewer may see, never scores
import { suiteDatabaseUrl } from './test-support/suite-db.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'arabtec-assessteam-'));
process.env.DATABASE_URL = suiteDatabaseUrl('file:' + path.join(TMP, 'assessteam.db'));
process.env.UPLOAD_DIR = path.join(TMP, 'uploads');
process.env.PORT = process.env.ASSESS_TEAM_TEST_PORT || '4384';
process.env.SEED_DEMO_DATA ||= 'true';
process.env.SMTP_TRANSPORT = 'json';
const { adminToken, ADMIN_BOOTSTRAP_PASSWORD } = await import('./test-support/admin-session.mjs');
process.env.SEED_ADMIN_PASSWORD ||= ADMIN_BOOTSTRAP_PASSWORD;
await import('./prisma/seed.js');
await import('./src/server.js');
const { waitForReady } = await import('./test-support/wait-ready.mjs');
const B = 'http://localhost:' + process.env.PORT;
await waitForReady(B);

let pass = 0, fail = 0;
const c = (n, ok, x = '') => { console.log((ok ? '  ✅ ' : '  ❌ ') + n + (ok ? '' : ' ' + x)); ok ? pass++ : fail++; };
async function api(p, { method = 'GET', token, body } = {}) {
  const r = await fetch(B + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch {}
  return { status: r.status, json: j, text };
}
const login = async (e) => (await api('/api/auth/login', { method: 'POST', body: { email: e, password: 'Arabtec@123' } })).json.token;
const TECH = ['technical_knowledge', 'relevant_experience', 'problem_solving', 'tools_software', 'planning_organizing'];
const HRK = ['openness', 'conscientiousness', 'extraversion', 'agreeableness', 'emotional_stability'];
const rows = (keys, s) => Object.fromEntries(keys.map((k) => [k, { score: s, notes: '' }]));

try {
  const admin = await adminToken(B);
  const hrMgr = await login('hr.manager@arabtec.com');
  const hrDir = await login('hr.director@arabtec.com');
  const recMgr = await login('rec.manager@arabtec.com');
  const recruiter = await login('recruiter@arabtec.com');
  const interviewer = await login('interviewer@arabtec.com');
  const hm = await login('hiring.manager@arabtec.com');
  const meta = (await api('/api/requests/meta/form', { token: hrMgr })).json;
  const karim = meta.recruiters.find((r) => r.name === 'Karim Adel');
  const rid = (await api('/api/requests', { method: 'POST', token: hrMgr, body: { title: 'Assessment Team Edit', justification: 'new_hire', projectId: meta.projects[0].id, departmentId: meta.departments[0].id, location: 'Cairo', headcount: 1, priority: 'high' } })).json.request.id;
  await api(`/api/requests/${rid}/submit`, { method: 'POST', token: hrMgr });
  await api(`/api/requests/${rid}/approve`, { method: 'POST', token: hrDir, body: {} });
  await api(`/api/requests/${rid}/assign`, { method: 'POST', token: recMgr, body: { ownerId: karim.id } });
  const cid = (await api('/api/candidates', { method: 'POST', token: recruiter, body: { fullName: 'Synthetic Assessment Candidate', email: 'assess-team@example.invalid', expectedSalary: 47321 } })).json.candidate.id;
  const aid = (await api('/api/applications', { method: 'POST', token: recruiter, body: { candidateId: cid, requestId: rid, initialStatus: 'matched' } })).json.application.id;
  const mona = (await api('/api/interviews/meta/form', { token: recruiter })).json.interviewers.find((u) => u.name === 'Mona Sami');
  await api('/api/interviews', { method: 'POST', token: recruiter, body: { applicationId: aid, interviewType: 'technical', scheduledAt: new Date(Date.now() + 86400000).toISOString(), panel: [{ interviewerId: mona.id, isLead: true }] } });
  const A = `/api/assessments/application/${aid}`;
  const post = (token, body) => api(A, { method: 'POST', token, body });

  console.log('\n— each recruitment role controls the whole assessment —');
  for (const [who, t] of [['Recruiter', recruiter], ['Recruitment Manager', recMgr], ['HR Manager', hrMgr], ['System Administrator', admin]]) {
    const b = (await api(A, { token: t })).json.assessment;
    const p = b.permissions;
    c(`${who}: both sections, both justifications, flags and final decision editable`,
      p['assessment.behavioral'].canEdit && p['assessment.technical'].canEdit && p['assessment.finalRecommendation.technicalJustification'].canEdit
      && p['assessment.finalRecommendation.behavioralJustification'].canEdit && p['assessment.criticalFlags'].canEdit && p['assessment.finalRecommendation'].canEdit);
  }
  const t1 = await post(recruiter, { evaluatorType: 'technical', technical: rows(TECH, 4), recommendation: 'proceed', technicalJustification: 'Recruiter-entered panel notes' });
  c('a recruiter saves the technical section (201)', t1.status === 201 && t1.json.assessment.technical.evaluatorName === 'Karim Adel', t1.text.slice(0, 160));
  const h1 = await post(recMgr, { evaluatorType: 'hr', behavioral: rows(HRK, 4), recommendation: 'proceed', submitted: true });
  c('the Recruitment Manager submits the behavioral section (201)', h1.status === 201 && h1.json.assessment.hr.status === 'submitted');
  c('the HR Manager records the final decision (201)', (await api(`${A}/final`, { method: 'POST', token: hrMgr, body: { decision: 'proceed', notes: 'Team decision' } })).status === 201);

  console.log('\n— everyone else keeps their narrower access —');
  const dirB = await api(A, { token: hrDir });
  c('HR Director reads the assessment', dirB.status === 200);
  c('…but cannot write a section (403)', (await post(hrDir, { evaluatorType: 'hr', behavioral: rows(HRK, 1) })).status === 403);
  c('…nor the final decision (403)', (await api(`${A}/final`, { method: 'POST', token: hrDir, body: { decision: 'reject' } })).status === 403);
  const ivB = (await api(A, { token: interviewer })).json.assessment;
  c('panel interviewer: technical editable, behavioral hidden, final view-only', ivB.permissions['assessment.technical'].canEdit && !ivB.permissions['assessment.behavioral'].canView && !ivB.permissions['assessment.finalRecommendation'].canEdit);
  c('panel interviewer cannot write the behavioral section (403)', (await post(interviewer, { evaluatorType: 'hr', behavioral: rows(HRK, 1) })).status === 403);
  c('panel interviewer cannot record the final decision (403)', (await api(`${A}/final`, { method: 'POST', token: interviewer, body: { decision: 'reject' } })).status === 403);
  c('expected salary is withheld from the interviewer', ivB.context.expectedSalary === undefined && ivB.context.salaryVisible === false);
  c('an unrelated hiring manager cannot read it (403)', (await api(A, { token: hm })).status === 403);

  console.log('\n— a submitted evaluation is changed deliberately —');
  c('reopen needs a reason (400)', (await api(`${A}/reopen`, { method: 'POST', token: recruiter, body: { evaluatorType: 'hr' } })).status === 400);
  c('reopen refuses unknown fields (400)', (await api(`${A}/reopen`, { method: 'POST', token: recruiter, body: { evaluatorType: 'hr', reason: 'x', submitted: true } })).status === 400);
  c('a draft cannot be reopened (409)', (await api(`${A}/reopen`, { method: 'POST', token: recruiter, body: { evaluatorType: 'technical', reason: 'x' } })).status === 409);
  c('the interviewer cannot reopen the behavioral section (403)', (await api(`${A}/reopen`, { method: 'POST', token: interviewer, body: { evaluatorType: 'hr', reason: 'x' } })).status === 403);
  c('the HR Director cannot reopen (403)', (await api(`${A}/reopen`, { method: 'POST', token: hrDir, body: { evaluatorType: 'hr', reason: 'x' } })).status === 403);
  const ro = await api(`${A}/reopen`, { method: 'POST', token: recruiter, body: { evaluatorType: 'hr', reason: 'Add evidence for extraversion' } });
  c('a recruiter reopens the submitted behavioral section (201) → draft, scores kept', ro.status === 201 && ro.json.assessment.hr.status === 'draft' && ro.json.assessment.hr.rows.openness.score === 4, ro.text.slice(0, 160));
  c('resubmitting works as before', (await post(recMgr, { evaluatorType: 'hr', submitted: true })).json?.assessment?.hr?.status === 'submitted');
  const upd = await post(hrMgr, { evaluatorType: 'hr', behavioral: { extraversion: { score: 5, notes: 'reference call' } }, editReason: 'Reference call confirmed leadership' });
  c('an edit of the submitted section carrying a reason is saved (201)', upd.status === 201 && upd.json.assessment.hr.status === 'submitted');
  c('an over-long edit reason is refused (400)', (await post(hrMgr, { evaluatorType: 'hr', editReason: 'x'.repeat(5000) })).status === 400);
  const logs = (await api('/api/audit?pageSize=200', { token: admin })).json.logs.filter((l) => String(l.entityId) === String(aid));
  c('the reopen is audited with its reason', logs.some((l) => l.action === 'assessment.reopened' && l.comments === 'Add evidence for extraversion' && l.newValue?.state === 'draft'));
  c('the edit is audited with its reason', logs.some((l) => l.action === 'assessment.updated' && l.comments === 'Reference call confirmed leadership'));

  console.log('\n— history: who, when, why — only what the viewer may see —');
  const hist = (await api(`${A}/history`, { token: recruiter })).json.history;
  c('the recruiter sees behavioral, technical and final entries', ['hr', 'technical', 'final'].every((p) => hist.some((h) => h.part === p)), JSON.stringify(hist.map((h) => h.part)));
  c('the reopen and the edit carry their reasons', hist.some((h) => h.action === 'assessment.reopened' && h.reason === 'Add evidence for extraversion') && hist.some((h) => h.action === 'assessment.updated' && h.reason === 'Reference call confirmed leadership'));
  c('no scores in the history', !JSON.stringify(hist).includes('"score"') && !JSON.stringify(hist).includes('47321'));
  const ivHist = (await api(`${A}/history`, { token: interviewer })).json.history;
  c('the interviewer\'s history has no behavioral entries', ivHist.length > 0 && !ivHist.some((h) => h.part === 'hr'), JSON.stringify(ivHist.map((h) => h.part)));
  c('an unrelated user cannot read the history (403)', (await api(`${A}/history`, { token: hm })).status === 403);
} catch (e) { console.error(e); fail++; }
finally {
  console.log(`\n=== ASSESSMENT TEAM EDIT: ${pass} passed, ${fail} failed ===\n`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.exit(fail ? 1 : 0);
}
