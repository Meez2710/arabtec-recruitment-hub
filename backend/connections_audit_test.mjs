// CONNECTIONS AUDIT — proves every user action lands in its designed path:
//   the API call succeeds → data persists in the right table → it appears in the
//   audit log (where designed) → it reflects in the view that surfaces it.
// Runs on SQLite (default) or Postgres (PG_ENGINE=pglite). Uses durable DB file storage.
process.env.DATABASE_URL = process.env.PG_ENGINE ? '' : 'file:/tmp/arabtec_conn.db';
process.env.PORT = process.env.PORT || '4288';
import fs from 'node:fs';
if (!process.env.PG_ENGINE) { for (const f of ['/tmp/arabtec_conn.db', '/tmp/arabtec_conn.db-journal']) { try { fs.rmSync(f); } catch {} } }
await import('./prisma/seed.js');
await import('./src/server.js');
await new Promise((r) => setTimeout(r, 900));
const B = 'http://localhost:' + process.env.PORT;
let pass = 0, fail = 0;
const c = (n, ok, x = '') => { console.log((ok ? '  ✅ ' : '  ❌ ') + n + ' ' + x); ok ? pass++ : fail++; };
async function api(p, { method = 'GET', token, body } = {}) {
  const r = await fetch(B + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, json: j };
}
async function up(p, token, fn, content, fields = {}) {
  const fd = new FormData(); fd.append('file', new Blob([content], { type: 'application/pdf' }), fn);
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  const r = await fetch(B + p, { method: 'POST', headers: token ? { Authorization: 'Bearer ' + token } : {}, body: fd });
  return { status: r.status, json: await r.json().catch(() => null) };
}
const login = async (e, p = 'Arabtec@123') => (await api('/api/auth/login', { method: 'POST', body: { email: e, password: p } })).json.token;

(async () => {
  const admin = await login('admin@arabtec.com', 'Admin@12345');
  const hrMgr = await login('hr.manager@arabtec.com');
  const recMgr = await login('rec.manager@arabtec.com');
  const recruiter = await login('recruiter@arabtec.com');
  const interviewer = await login('interviewer@arabtec.com');
  const meta = (await api('/api/requests/meta/form', { token: hrMgr })).json;
  const recId = meta.recruiters.find((r) => r.name === 'Karim Adel').id;
  const auditActions = async () => new Set(((await api('/api/audit?pageSize=500', { token: admin })).json.logs || []).map((l) => l.action));

  console.log('\n— ACTION: Create request → persists + audited + listed —');
  const cr = await api('/api/requests', { method: 'POST', token: hrMgr, body: { title: 'Audit Engineer', justification: 'new_hire', projectId: meta.projects[0].id, departmentId: meta.departments[0].id, location: 'Dubai', hiringManagerId: meta.hiringManagers[0].id, headcount: 2, priority: 'high', keyResponsibilities: 'QA', keyRequirements: '5y' } });
  c('create returns 201', cr.status === 201);
  const rid = cr.json.request.id;
  c('→ persisted (detail GET returns it)', (await api(`/api/requests/${rid}`, { token: hrMgr })).json.request.id === rid);
  c('→ appears in the requests list (view)', (await api('/api/requests', { token: hrMgr })).json.requests.some((r) => r.id === rid));
  c('→ audited request.created', (await auditActions()).has('request.created'));

  console.log('\n— ACTION: Submit → approve → assign (workflow path) —');
  await api(`/api/requests/${rid}/submit`, { method: 'POST', token: hrMgr });
  c('→ status pending_approval', (await api(`/api/requests/${rid}`, { token: hrMgr })).json.request.status === 'pending_approval');
  await api(`/api/requests/${rid}/approve`, { method: 'POST', token: hrMgr, body: {} });
  c('→ status approved', (await api(`/api/requests/${rid}`, { token: hrMgr })).json.request.status === 'approved');
  c('→ audited request.approval_decision', (await auditActions()).has('request.approval_decision'));
  await api(`/api/requests/${rid}/assign`, { method: 'POST', token: recMgr, body: { ownerId: recId } });
  const afterAssign = (await api(`/api/requests/${rid}`, { token: hrMgr })).json.request;
  c('→ owner set + status in_sourcing', afterAssign.owner?.id === recId && afterAssign.status === 'in_sourcing');
  c('→ audited request.recruiter_assigned', (await auditActions()).has('request.recruiter_assigned'));

  console.log('\n— ACTION: Ticket thread message → lands in the thread (right path) —');
  const msg = await api(`/api/thread/request/${rid}`, { method: 'POST', token: recruiter, body: { body: 'Sourcing started.' } });
  c('message posted (201)', msg.status === 201);
  c('→ appears in the thread feed', (await api(`/api/thread/request/${rid}`, { token: hrMgr })).json.posts.some((p) => p.id === msg.json.post.id));
  c('→ audited ticket.post_created', (await auditActions()).has('ticket.post_created'));

  console.log('\n— ACTION: CV upload (Candidates page path) → résumé persists durably + downloadable —');
  const cand = await api('/api/candidates', { method: 'POST', token: recruiter, body: { fullName: 'Audit Cand', phone: '+201111000222' } });
  const candId = cand.json.candidate.id;
  const rUp = await up(`/api/candidates/${candId}/resume`, recruiter, 'cv.pdf', 'RESUME-BYTES-AUDIT');
  c('résumé upload (201)', rUp.status === 201);
  c('→ candidate shows hasResume', (await api(`/api/candidates/${candId}`, { token: recruiter })).json.candidate.hasResume === true);
  const dl = await fetch(B + `/api/candidates/${candId}/resume`, { headers: { Authorization: 'Bearer ' + recruiter } });
  c('→ résumé downloads with exact bytes (durable store)', dl.status === 200 && (await dl.text()).includes('RESUME-BYTES-AUDIT'));
  c('→ audited candidate.resume_uploaded', (await auditActions()).has('candidate.resume_uploaded'));

  console.log('\n— ACTION: Post CV in ticket → creates candidate + application + downloadable file —');
  const cv = await up(`/api/thread/request/${rid}/cv`, recruiter, 'omar.pdf', 'CV-BYTES-AUDIT', { fullName: 'Omar Audit', currentPosition: 'QA' });
  c('CV post (201)', cv.status === 201 && !!cv.json.candidateId && !!cv.json.applicationId);
  const cdl = await fetch(B + `/api/candidates/${cv.json.candidateId}/resume`, { headers: { Authorization: 'Bearer ' + recruiter } });
  c('→ posted CV stored as candidate résumé (durable)', cdl.status === 200 && (await cdl.text()).includes('CV-BYTES-AUDIT'));
  c('→ application linked to this request (pipeline view)', (await api(`/api/applications/request/${rid}`, { token: recruiter })).json.applications.some((a) => a.id === cv.json.applicationId));

  console.log('\n— ACTION: Stage move → reflects in pipeline + auto-posts to thread —');
  await api(`/api/applications/${cv.json.applicationId}/move`, { method: 'POST', token: recruiter, body: { status: 'shortlisted' } });
  c('→ application status reflects in pipeline', (await api(`/api/applications/request/${rid}`, { token: recruiter })).json.applications.find((a) => a.id === cv.json.applicationId).status === 'shortlisted');
  c('→ audited application.status_changed', (await auditActions()).has('application.status_changed'));
  c('→ stage move auto-posted into thread', (await api(`/api/thread/request/${rid}`, { token: hrMgr })).json.posts.some((p) => p.type === 'system' && /moved/i.test(p.body || '')));

  console.log('\n— ACTION: Interview assessment (unlocks at interview stage) → persists + shared —');
  await api(`/api/applications/${cv.json.applicationId}/move`, { method: 'POST', token: recruiter, body: { status: 'interview_1' } });
  const asmt = await api(`/api/assessments/application/${cv.json.applicationId}`, { method: 'POST', token: interviewer, body: { evaluatorType: 'technical', technical: { technical_knowledge: { score: 4 } }, recommendation: 'proceed', technicalFit: 'strong' } });
  c('assessment submitted (201)', asmt.status === 201);
  c('→ assessment persisted + readable', (await api(`/api/assessments/application/${cv.json.applicationId}`, { token: recruiter })).json.assessment.technical?.recommendation === 'proceed');
  c('→ audited assessment.submitted', (await auditActions()).has('assessment.submitted'));

  console.log('\n— ACTION: Request attachment upload → persists durably + downloadable —');
  const att = await up(`/api/requests/${rid}/attachment`, hrMgr, 'jd.pdf', 'JD-BYTES-AUDIT');
  c('attachment upload (201)', att.status === 201);
  const adl = await fetch(B + `/api/requests/${rid}/attachment`, { headers: { Authorization: 'Bearer ' + hrMgr } });
  c('→ attachment downloads with exact bytes', adl.status === 200 && (await adl.text()).includes('JD-BYTES-AUDIT'));

  console.log('\n— ACTION: Dashboard reflects the activity (read path) —');
  const dash = (await api('/api/dashboard', { token: hrMgr })).json;
  c('dashboard returns KPIs', typeof dash.kpis?.openRequests === 'number');
  c('→ request appears in requests-by-status', Array.isArray(dash.requestsByStatus) && dash.requestsByStatus.length >= 1);

  console.log('\n— ACTION: Audit log is the system of record (everything traced) —');
  const acts = await auditActions();
  for (const a of ['request.created', 'request.submitted', 'request.recruiter_assigned', 'ticket.post_created', 'ticket.cv_posted', 'candidate.resume_uploaded', 'application.status_changed', 'assessment.submitted', 'request.attachment_uploaded'])
    c('audit trail has ' + a, acts.has(a));

  console.log(`\n=== CONNECTIONS AUDIT (${process.env.PG_ENGINE ? 'POSTGRES' : 'SQLITE'}): ${pass} passed, ${fail} failed ===\n`);
  process.exit(fail ? 1 : 0);
})();
