// Stage B — request workspace backend: lifecycle/health/displayStatus in serializer,
// next-action endpoint, pipeline rows carry new candidate fields.
process.env.DATABASE_URL = 'file:/tmp/arabtec_sbk.db';
process.env.PORT = '4250';
import fs from 'node:fs';
for (const f of ['/tmp/arabtec_sbk.db', '/tmp/arabtec_sbk.db-journal']) { try { fs.rmSync(f); } catch {} }
await import('./prisma/seed.js');
await import('./src/server.js');
await new Promise((r) => setTimeout(r, 800));
const B = 'http://localhost:4250';
let pass = 0, fail = 0;
const c = (n, ok, x = '') => { console.log((ok ? '  ✅ ' : '  ❌ ') + n + ' ' + x); ok ? pass++ : fail++; };
async function api(p, { method = 'GET', token, body } = {}) {
  const r = await fetch(B + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, json: j };
}
const login = async (e, p = 'Arabtec@123') => (await api('/api/auth/login', { method: 'POST', body: { email: e, password: p } })).json.token;

(async () => {
  const recruiter = await login('recruiter@arabtec.com');
  const hrMgr = await login('hr.manager@arabtec.com');
  const recMgr = await login('rec.manager@arabtec.com');
  const meta = await api('/api/requests/meta/form', { token: hrMgr });
  const recId = meta.json.recruiters.find((r) => r.name === 'Karim Adel').id;

  const cr = await api('/api/requests', { method: 'POST', token: hrMgr, body: { title: 'Workspace Role', projectId: meta.json.projects[0].id, departmentId: meta.json.departments[0].id, headcount: 2, priority: 'high', targetJoinDate: new Date(Date.now() + 60 * 86400000).toISOString().slice(0, 10), keyRequirements: '5y MEP', hiringManagerNotes: 'Tower 3' } });
  const reqId = cr.json.request.id;

  console.log('\n— Serializer: workspace fields present —');
  let d = await api(`/api/requests/${reqId}`, { token: hrMgr });
  c('displayStatus present', typeof d.json.request.displayStatus === 'string', d.json.request.displayStatus);
  c('health object present', d.json.request.health && d.json.request.health.level);
  c('lifecycle.daysOpen numeric', typeof d.json.request.lifecycle.daysOpen === 'number');
  c('lifecycle.daysToTargetJoin numeric', typeof d.json.request.lifecycle.daysToTargetJoin === 'number');
  c('keyRequirements + hmNotes returned', d.json.request.keyRequirements === '5y MEP' && d.json.request.hiringManagerNotes === 'Tower 3');

  // approve + assign so we can link
  await api(`/api/requests/${reqId}/submit`, { method: 'POST', token: hrMgr });
  await api(`/api/requests/${reqId}/approve`, { method: 'POST', token: hrMgr, body: {} }); // single HR Director approval
  await api(`/api/requests/${reqId}/assign`, { method: 'POST', token: recMgr, body: { ownerId: recId } });

  const cand = await api('/api/candidates', { method: 'POST', token: recruiter, body: { fullName: 'Workspace Cand', phone: '+201239990001', employer: 'Orascom', currentProject: 'Tower 1', university: 'Cairo Uni', major: 'MEP', graduationYear: 2015 } });
  const app = await api('/api/applications', { method: 'POST', token: recruiter, body: { candidateId: cand.json.candidate.id, requestId: reqId, initialStatus: 'new', matchScore: 75 } });
  const appId = app.json.application.id;

  console.log('\n— Pipeline rows carry new candidate fields —');
  const pipe = await api(`/api/applications/request/${reqId}`, { token: recruiter });
  const row = pipe.json.applications.find((a) => a.id === appId);
  c('row has employer', row.candidate.employer === 'Orascom');
  c('row has university/major/gradYear', row.candidate.university === 'Cairo Uni' && row.candidate.major === 'MEP' && row.candidate.graduationYear === 2015);
  c('pipeline statuses = new stage list', pipe.json.statuses.includes('interview_1') && pipe.json.statuses.includes('new'));

  console.log('\n— Next-action endpoint —');
  const na = await api(`/api/applications/${appId}/next-action`, { method: 'POST', token: recruiter, body: { nextAction: 'Schedule technical interview', nextActionDate: '2026-07-01' } });
  c('next action saved (200)', na.status === 200);
  c('next action returned on row', na.json.application.nextAction === 'Schedule technical interview' && !!na.json.application.nextActionDate);

  console.log('\n— displayStatus reflects pipeline activity —');
  await api(`/api/applications/${appId}/move`, { method: 'POST', token: recruiter, body: { status: 'interview_1' } });
  d = await api(`/api/requests/${reqId}`, { token: hrMgr });
  c('displayStatus = interviewing once in interview stage', d.json.request.displayStatus === 'interviewing', d.json.request.displayStatus);
  c('first_interview lifecycle stamped', !!d.json.request.lifecycle.firstInterviewAt);

  console.log('\n— Audit for next action —');
  const admin = await login('admin@arabtec.com', 'Admin@12345');
  const audit = await api('/api/audit?q=next_action&pageSize=20', { token: admin });
  c('next_action_set audited', (audit.json.logs || []).some((l) => l.action === 'application.next_action_set'));

  console.log(`\n=== STAGE B: ${pass} passed, ${fail} failed ===\n`);
  process.exit(fail ? 1 : 0);
})();
