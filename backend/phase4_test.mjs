// Phase 4 — Interviews & Feedback tests.
process.env.DATABASE_URL = 'file:/tmp/arabtec_p4.db';
process.env.PORT = '4150';
import fs from 'node:fs';
for (const f of ['/tmp/arabtec_p4.db', '/tmp/arabtec_p4.db-journal']) { try { fs.rmSync(f); } catch {} }
await import('./prisma/seed.js');
await import('./src/server.js');
await new Promise((r) => setTimeout(r, 700));
const B = 'http://localhost:4150';
let pass = 0, fail = 0;
const c = (n, ok, x = '') => { console.log((ok ? '  ✅ ' : '  ❌ ') + n + ' ' + x); ok ? pass++ : fail++; };
async function api(p, { method = 'GET', token, body } = {}) {
  const r = await fetch(B + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, json: j };
}
const login = async (e, p = 'Arabtec@123') => (await api('/api/auth/login', { method: 'POST', body: { email: e, password: p } })).json.token;

async function approvedRequest(token, recMgr, headcount = 1) {
  const meta = await api('/api/requests/meta/form', { token });
  const cr = await api('/api/requests', { method: 'POST', token, body: { title: 'IV Role', projectId: meta.json.projects[0].id, departmentId: meta.json.departments[0].id, headcount, priority: 'high' } });
  const id = cr.json.request.id;
  await api(`/api/requests/${id}/submit`, { method: 'POST', token });
  for (let i = 0; i < 3; i++) await api(`/api/requests/${id}/approve`, { method: 'POST', token, body: {} });
  const recId = meta.json.recruiters.find((r) => r.name === 'Karim Adel').id;
  await api(`/api/requests/${id}/assign`, { method: 'POST', token: recMgr, body: { ownerId: recId } });
  return id;
}

(async () => {
  const admin = await login('admin@arabtec.com', 'Admin@12345');
  const recruiter = await login('recruiter@arabtec.com');
  const hrMgr = await login('hr.manager@arabtec.com');
  const recMgr = await login('rec.manager@arabtec.com');
  const hm = await login('hiring.manager@arabtec.com');
  const interviewer = await login('interviewer@arabtec.com');
  const viewer = await login('viewer@arabtec.com');

  // user ids
  const ivMeta = await api('/api/interviews/meta/form', { token: recruiter });
  const interviewerUser = ivMeta.json.interviewers.find((u) => u.name === 'Mona Sami');   // interviewer role
  const hmUser = ivMeta.json.interviewers.find((u) => u.name === 'Nadia Fouad');           // hiring manager role
  const otherInterviewer = ivMeta.json.interviewers.find((u) => u.name === 'Hassan Ali');  // viewer (used as non-panelist)

  // Setup: request + application
  const reqId = await approvedRequest(hrMgr, recMgr, 1);
  const cand = await api('/api/candidates', { method: 'POST', token: recruiter, body: { fullName: 'IV Candidate', email: 'ivc@x.com', currentPosition: 'Engineer' } });
  const app = await api('/api/applications', { method: 'POST', token: recruiter, body: { candidateId: cand.json.candidate.id, requestId: reqId, initialStatus: 'technical_interview' } });
  const appId = app.json.application.id;
  const appStatusBefore = app.json.application.status;

  console.log('\n— Schedule + links (application+candidate+request) —');
  const futureDate = new Date(Date.now() + 86400000).toISOString();
  const sched = await api('/api/interviews', { method: 'POST', token: recruiter, body: {
    applicationId: appId, interviewType: 'technical', mode: 'video', scheduledAt: futureDate, durationMin: 60,
    panel: [{ interviewerId: interviewerUser.id, isLead: true }, { interviewerId: hmUser.id }],
  } });
  c('recruiter schedules interview (201)', sched.status === 201, `got ${sched.status}`);
  const iv = sched.json.interview;
  c('interview has INT id', /^INT-\d{5}$/.test(iv.interviewNo || ''), iv.interviewNo);
  c('interview links to application', iv.application?.id === appId);
  c('interview links to candidate', iv.candidate?.id === cand.json.candidate.id);
  c('interview links to request', iv.request?.id === reqId);
  c('interview has its own status (scheduled)', iv.status === 'scheduled');
  c('panel has 2 members', iv.panel.length === 2);
  const ivId = iv.id;

  console.log('\n— Interview status does NOT replace application status —');
  const appAfter = await api(`/api/applications/${appId}`, { token: recruiter });
  c('application status unchanged after scheduling', appAfter.json.application.status === appStatusBefore, `${appAfter.json.application.status} vs ${appStatusBefore}`);
  await api(`/api/interviews/${ivId}/status`, { method: 'POST', token: recruiter, body: { status: 'completed' } });
  const appAfter2 = await api(`/api/applications/${appId}`, { token: recruiter });
  c('completing interview does NOT change application status', appAfter2.json.application.status === appStatusBefore);
  const ivDetail = await api(`/api/interviews/${ivId}`, { token: recruiter });
  c('interview status is completed (separate lifecycle)', ivDetail.json.interview.status === 'completed');
  c('interview detail still shows application status separately', ivDetail.json.interview.application.status === appStatusBefore);

  console.log('\n— Validation —');
  const past = await api('/api/interviews', { method: 'POST', token: recruiter, body: { applicationId: appId, scheduledAt: '2020-01-01T10:00:00Z', panel: [{ interviewerId: interviewerUser.id }] } });
  c('past date rejected (400)', past.status === 400, `got ${past.status}`);
  const noPanel = await api('/api/interviews', { method: 'POST', token: recruiter, body: { applicationId: appId, scheduledAt: futureDate, panel: [] } });
  c('empty panel rejected (400)', noPanel.status === 400, `got ${noPanel.status}`);

  console.log('\n— Feedback: permission + panel scope —');
  // interviewer (panelist) can submit
  const fb1 = await api(`/api/interviews/${ivId}/feedback`, { method: 'POST', token: interviewer, body: { recommendation: 'yes', overallScore: 4, comments: 'Solid' } });
  c('panelist interviewer submits feedback (201)', fb1.status === 201, `got ${fb1.status}`);
  // hiring manager (panelist) can submit
  const fb2 = await api(`/api/interviews/${ivId}/feedback`, { method: 'POST', token: hm, body: { recommendation: 'strong_yes', comments: 'Great fit' } });
  c('panelist hiring manager submits feedback (201)', fb2.status === 201, `got ${fb2.status}`);
  // viewer (not panelist, no feedback perm) blocked
  const fb3 = await api(`/api/interviews/${ivId}/feedback`, { token: viewer, method: 'POST', body: { recommendation: 'no' } });
  c('viewer cannot submit feedback (403)', fb3.status === 403, `got ${fb3.status}`);
  c('aggregate outcome derived (positive)', fb2.json.interview.overallOutcome === 'positive', fb2.json.interview?.overallOutcome);

  console.log('\n— Scope: HM / interviewer only see assigned interviews —');
  // a second interview with a DIFFERENT panel (not interviewer/hm above)
  const cand2 = await api('/api/candidates', { method: 'POST', token: recruiter, body: { fullName: 'IV Cand 2', email: 'ivc2@x.com' } });
  const app2 = await api('/api/applications', { method: 'POST', token: recruiter, body: { candidateId: cand2.json.candidate.id, requestId: reqId, initialStatus: 'technical_interview' } });
  const sched2 = await api('/api/interviews', { method: 'POST', token: recruiter, body: { applicationId: app2.json.application.id, scheduledAt: futureDate, panel: [{ interviewerId: otherInterviewer.id }] } });
  const iv2Id = sched2.json.interview.id;
  // interviewer (Mona) is panelist on iv1 only
  const interviewerList = await api('/api/interviews', { token: interviewer });
  c('interviewer list is scoped', interviewerList.json.scoped === true);
  c('interviewer sees their interview', interviewerList.json.interviews.some((x) => x.id === ivId));
  c('interviewer does NOT see unassigned interview', !interviewerList.json.interviews.some((x) => x.id === iv2Id));
  const iv2AsInterviewer = await api(`/api/interviews/${iv2Id}`, { token: interviewer });
  c('interviewer blocked from unassigned interview detail (403)', iv2AsInterviewer.status === 403, `got ${iv2AsInterviewer.status}`);
  const hmList = await api('/api/interviews', { token: hm });
  c('hiring manager sees assigned interview', hmList.json.interviews.some((x) => x.id === ivId));
  c('hiring manager does NOT see unassigned interview', !hmList.json.interviews.some((x) => x.id === iv2Id));
  // full-view role sees all
  const recList = await api('/api/interviews', { token: recruiter });
  c('recruiter (view_all) sees both interviews', recList.json.interviews.some((x) => x.id === ivId) && recList.json.interviews.some((x) => x.id === iv2Id) && recList.json.scoped === false);

  console.log('\n— RBAC: schedule/cancel permissions —');
  const ivCannotSchedule = await api('/api/interviews', { method: 'POST', token: interviewer, body: { applicationId: appId, scheduledAt: futureDate, panel: [{ interviewerId: interviewerUser.id }] } });
  c('interviewer cannot schedule (403)', ivCannotSchedule.status === 403, `got ${ivCannotSchedule.status}`);
  const hmCannotSchedule = await api('/api/interviews', { method: 'POST', token: hm, body: { applicationId: appId, scheduledAt: futureDate, panel: [{ interviewerId: hmUser.id }] } });
  c('hiring manager cannot schedule (403)', hmCannotSchedule.status === 403, `got ${hmCannotSchedule.status}`);
  const cancelNoReason = await api(`/api/interviews/${iv2Id}/status`, { method: 'POST', token: recruiter, body: { status: 'cancelled' } });
  c('cancel without reason rejected (400)', cancelNoReason.status === 400, `got ${cancelNoReason.status}`);
  const cancelOk = await api(`/api/interviews/${iv2Id}/status`, { method: 'POST', token: recruiter, body: { status: 'cancelled', reason: 'candidate withdrew' } });
  c('cancel with reason ok', cancelOk.json.interview.status === 'cancelled');

  console.log('\n— Candidate profile interviews tab (scoped) —');
  const profRec = await api(`/api/candidates/${cand.json.candidate.id}`, { token: recruiter });
  c('recruiter sees interview on candidate profile', (profRec.json.candidate.interviews || []).some((x) => x.id === ivId));

  console.log('\n— Audit —');
  const audit = await api('/api/audit?pageSize=300', { token: admin });
  const acts = new Set((audit.json.logs || []).map((l) => l.action));
  for (const a of ['interview.scheduled', 'interview.status_changed', 'interview.feedback_submitted']) c('audit has ' + a, acts.has(a));

  console.log(`\n=== PHASE 4: ${pass} passed, ${fail} failed ===\n`);
  process.exit(fail ? 1 : 0);
})();
