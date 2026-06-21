// Restructure verification: simplified intake, single HR Director approval,
// real file upload (request attachment + candidate resume), assessment form.
process.env.DATABASE_URL = 'file:/tmp/arabtec_rs.db';
process.env.PORT = '4270';
import fs from 'node:fs';
for (const f of ['/tmp/arabtec_rs.db', '/tmp/arabtec_rs.db-journal']) { try { fs.rmSync(f); } catch {} }
await import('./prisma/seed.js');
await import('./src/server.js');
await new Promise((r) => setTimeout(r, 800));
const B = 'http://localhost:4270';
let pass = 0, fail = 0;
const c = (n, ok, x = '') => { console.log((ok ? '  ✅ ' : '  ❌ ') + n + ' ' + x); ok ? pass++ : fail++; };
async function api(p, { method = 'GET', token, body } = {}) {
  const r = await fetch(B + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, json: j };
}
async function upload(p, token, filename, content) {
  const fd = new FormData();
  fd.append('file', new Blob([content], { type: 'application/pdf' }), filename);
  const r = await fetch(B + p, { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, json: j };
}
const login = async (e, p = 'Arabtec@123') => (await api('/api/auth/login', { method: 'POST', body: { email: e, password: p } })).json.token;

(async () => {
  const admin = await login('admin@arabtec.com', 'Admin@12345');
  const recruiter = await login('recruiter@arabtec.com');
  const hrMgr = await login('hr.manager@arabtec.com');
  const recMgr = await login('rec.manager@arabtec.com');
  const interviewer = await login('interviewer@arabtec.com');

  console.log('\n— Simplified intake + new fields —');
  const meta = await api('/api/requests/meta/form', { token: hrMgr });
  c('meta has justifications', (meta.json.justifications || []).some((j) => j.value === 'new_hire'));
  c('meta has hiringManagers', Array.isArray(meta.json.hiringManagers) && meta.json.hiringManagers.length > 0);
  c('meta no longer exposes disciplines', meta.json.disciplines === undefined);
  const hmUser = meta.json.hiringManagers[0];
  const cr = await api('/api/requests', { method: 'POST', token: hrMgr, body: {
    title: 'Site Engineer', justification: 'new_hire', projectId: meta.json.projects[0].id, departmentId: meta.json.departments[0].id,
    location: 'Aliva MV', hiringManagerId: hmUser.id, headcount: 2, priority: 'high',
    keyResponsibilities: 'Supervise site works', keyRequirements: '5y experience, AutoCAD',
  } });
  c('create with simplified fields (201)', cr.status === 201, `got ${cr.status}`);
  const reqId = cr.json.request.id;
  const det = cr.json.request;
  c('justification stored', det.justification === 'new_hire');
  c('location stored', det.location === 'Aliva MV');
  c('key responsibilities stored', det.keyResponsibilities === 'Supervise site works');
  c('key requirements stored', det.keyRequirements === '5y experience, AutoCAD');
  c('hiring manager stored', det.hiringManager && det.hiringManager.id === hmUser.id);
  c('removed fields absent (employmentType/discipline/staffCategory/salaryBand)', det.employmentType === undefined && det.discipline === undefined && det.staffCategory === undefined && det.salaryBandMin === undefined);

  console.log('\n— Single HR Director approval (no budget step) —');
  const sub = await api(`/api/requests/${reqId}/submit`, { method: 'POST', token: hrMgr });
  c('chain is exactly 1 level (HR Director)', sub.json.request.approvals.length === 1 && sub.json.request.approvals[0].role_code === 'hr_director');
  const ap = await api(`/api/requests/${reqId}/approve`, { method: 'POST', token: hrMgr, body: {} });
  c('single approve → approved', ap.json.request.status === 'approved', ap.json.request.status);
  const budgetGone = await api(`/api/requests/${reqId}/budget`, { method: 'POST', token: hrMgr, body: { decision: 'validated' } });
  c('budget endpoint removed (404)', budgetGone.status === 404, `got ${budgetGone.status}`);

  console.log('\n— Request attachment (real file upload + download) —');
  const up = await upload(`/api/requests/${reqId}/attachment`, hrMgr, 'jd.pdf', 'PDF-CONTENT-REQ');
  c('attachment upload (201)', up.status === 201, `got ${up.status}`);
  c('request shows hasAttachment', up.json.request.hasAttachment === true && up.json.request.attachmentName === 'jd.pdf');
  const dl = await fetch(B + `/api/requests/${reqId}/attachment`, { headers: { Authorization: 'Bearer ' + hrMgr } });
  const dlText = await dl.text();
  c('attachment downloads with content', dl.status === 200 && dlText.includes('PDF-CONTENT-REQ'));

  console.log('\n— Assign + candidate + resume upload —');
  const recId = meta.json.recruiters.find((r) => r.name === 'Karim Adel').id;
  await api(`/api/requests/${reqId}/assign`, { method: 'POST', token: recMgr, body: { ownerId: recId } });
  const cand = await api('/api/candidates', { method: 'POST', token: recruiter, body: { fullName: 'Resume Cand', phone: '+201230001111' } });
  const candId = cand.json.candidate.id;
  const ru = await upload(`/api/candidates/${candId}/resume`, recruiter, 'cv.pdf', 'RESUME-BYTES');
  c('resume upload (201)', ru.status === 201, `got ${ru.status}`);
  c('candidate shows hasResume', ru.json.candidate.hasResume === true && ru.json.candidate.resumeName === 'cv.pdf');
  const rdl = await fetch(B + `/api/candidates/${candId}/resume`, { headers: { Authorization: 'Bearer ' + recruiter } });
  c('resume downloads', rdl.status === 200 && (await rdl.text()).includes('RESUME-BYTES'));

  console.log('\n— Assessment form (HR + technical + final decision) —');
  const app = await api('/api/applications', { method: 'POST', token: recruiter, body: { candidateId: candId, requestId: reqId, initialStatus: 'new' } });
  const appId = app.json.application.id;
  // locked before interview stage
  const locked = await api(`/api/assessments/application/${appId}`, { token: recruiter });
  c('assessment locked before interview stage', locked.json.assessment.unlocked === false);
  const blocked = await api(`/api/assessments/application/${appId}`, { method: 'POST', token: recruiter, body: { evaluatorType: 'hr', recommendation: 'proceed' } });
  c('submit blocked before interview stage (409)', blocked.status === 409, `got ${blocked.status}`);
  // move to interview, then assess
  await api(`/api/applications/${appId}/move`, { method: 'POST', token: recruiter, body: { status: 'interview_1' } });
  const amInfo = await api('/api/assessments/meta', { token: recruiter });
  c('assessment meta has 5 behavioral + 5 technical criteria', amInfo.json.behavioralCriteria.length === 5 && amInfo.json.technicalCriteria.length === 5);
  const hrEval = await api(`/api/assessments/application/${appId}`, { method: 'POST', token: recruiter, body: {
    evaluatorType: 'hr', behavioral: { openness: { score: 4 }, conscientiousness: { score: 5 } },
    criticalFlags: { blaming: false }, recommendation: 'proceed', behavioralFit: 'strong', behavioralJustification: 'Great fit',
  } });
  c('HR eval submitted (201)', hrEval.status === 201);
  c('HR eval stored', hrEval.json.assessment.hr && hrEval.json.assessment.hr.recommendation === 'proceed');
  const techEval = await api(`/api/assessments/application/${appId}`, { method: 'POST', token: interviewer, body: {
    evaluatorType: 'technical', technical: { technical_knowledge: { score: 4 } }, technicalFit: 'acceptable', recommendation: 'proceed',
  } });
  c('technical eval by interviewer (201)', techEval.status === 201);
  c('both evals visible (shared)', techEval.json.assessment.hr && techEval.json.assessment.technical);
  const finalD = await api(`/api/assessments/application/${appId}/final`, { method: 'POST', token: recruiter, body: { decision: 'proceed', notes: 'Move to offer' } });
  c('shared final decision recorded', finalD.json.assessment.finalDecision.decision === 'proceed');

  console.log('\n— Audit —');
  const audit = await api('/api/audit?pageSize=300', { token: admin });
  const acts = new Set((audit.json.logs || []).map((l) => l.action));
  for (const a of ['request.attachment_uploaded', 'candidate.resume_uploaded', 'assessment.submitted', 'assessment.final_decision']) c('audit has ' + a, acts.has(a));

  console.log(`\n=== RESTRUCTURE: ${pass} passed, ${fail} failed ===\n`);
  process.exit(fail ? 1 : 0);
})();
