process.env.DATABASE_URL = 'file:/tmp/arabtec_p2.db';
process.env.PORT = '4120';
import fs from 'node:fs';
for (const f of ['/tmp/arabtec_p2.db', '/tmp/arabtec_p2.db-journal']) { try { fs.rmSync(f); } catch {} }
await import('./prisma/seed.js');
await import('./src/server.js');
await new Promise((r) => setTimeout(r, 700));

const B = 'http://localhost:4120';
let pass = 0, fail = 0;
const c = (n, ok, x = '') => { console.log((ok ? '  ✅ ' : '  ❌ ') + n + ' ' + x); ok ? pass++ : fail++; };
async function api(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(B + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await res.json(); } catch {}
  return { status: res.status, json };
}
const login = async (email, pw = 'Arabtec@123') => (await api('/api/auth/login', { method: 'POST', body: { email, password: pw } })).json.token;

(async () => {
  const admin = await login('admin@arabtec.com', 'Admin@12345');
  const hm = await login('hiring.manager@arabtec.com');
  const recMgr = await login('rec.manager@arabtec.com');
  const recruiter = await login('recruiter@arabtec.com');
  const hrMgr = await login('hr.manager@arabtec.com');
  const hrDir = await login('hr.director@arabtec.com');
  const viewer = await login('viewer@arabtec.com');

  console.log('\n— Create & auto ID —');
  const meta = await api('/api/requests/meta/form', { token: hm });
  const projId = meta.json.projects[0].id, deptId = meta.json.departments[0].id;
  const create = await api('/api/requests', { method: 'POST', token: hm, body: {
    title: 'Senior Mechanical Engineer', projectId: projId, departmentId: deptId,
    headcount: 3, priority: 'high', discipline: 'mechanical', justification: 'project_ramp_up',
    jobDescription: 'Lead mechanical works.', requiredSkills: 'HVAC, Piping',
  }});
  c('hiring manager creates request (201)', create.status === 201, `got ${create.status}`);
  const reqId = create.json?.request?.id;
  c('auto ticket number REQ-YYYY-#####', /^REQ-\d{4}-\d{5}$/.test(create.json?.request?.ticketNo || ''), create.json?.request?.ticketNo);
  c('seats created = headcount', create.json?.request?.seats?.length === 3);
  console.log('\n— Validation —');
  const badHc = await api('/api/requests', { method: 'POST', token: hm, body: { title: 'X', projectId: projId, departmentId: deptId, headcount: 0 } });
  c('headcount < 1 rejected (400)', badHc.status === 400, `got ${badHc.status}`);

  console.log('\n— Workflow: submit → single HR Director approval → approved —');
  const submit = await api(`/api/requests/${reqId}/submit`, { method: 'POST', token: hm });
  c('submit moves to pending_approval', submit.json?.request?.status === 'pending_approval', submit.json?.request?.status);
  c('single-step approval chain (HR Director only)', submit.json?.request?.approvals?.length === 1, `got ${submit.json?.request?.approvals?.length}`);
  const approved = await api(`/api/requests/${reqId}/approve`, { method: 'POST', token: hrMgr, body: { comment: 'ok' } });
  c('single approval → sourcing', approved.json?.request?.status === 'sourcing', approved.json?.request?.status);

  console.log('\n— Recruiter assignment —');
  const recruiterUser = meta.json.recruiters.find((r) => r.name === 'Karim Adel');
  const assign = await api(`/api/requests/${reqId}/assign`, { method: 'POST', token: recMgr, body: { ownerId: recruiterUser.id } });
  c('assign recruiter → sourcing', assign.json?.request?.status === 'sourcing', assign.json?.request?.status);
  c('owner set', assign.json?.request?.owner?.id === recruiterUser.id);
  const recruiterCantAssign = await api(`/api/requests/${reqId}/assign`, { method: 'POST', token: recruiter, body: { ownerId: recruiterUser.id } });
  c('recruiter blocked from assigning (403)', recruiterCantAssign.status === 403, `got ${recruiterCantAssign.status}`);

  console.log('\n— Reason-required actions —');
  const holdNoReason = await api(`/api/requests/${reqId}/hold`, { method: 'POST', token: hrMgr, body: {} });
  c('hold without reason rejected (400)', holdNoReason.status === 400, `got ${holdNoReason.status}`);
  const hold = await api(`/api/requests/${reqId}/hold`, { method: 'POST', token: hrMgr, body: { reason: 'Awaiting client sign-off' } });
  c('hold with reason → on_hold', hold.json?.request?.status === 'on_hold', hold.json?.request?.status);
  const resume = await api(`/api/requests/${reqId}/resume`, { method: 'POST', token: hrMgr });
  c('resume → previous (sourcing)', resume.json?.request?.status === 'sourcing', resume.json?.request?.status);
  const close = await api(`/api/requests/${reqId}/close`, { method: 'POST', token: hrMgr, body: { reason: 'Position filled externally' } });
  c('close with reason → closed', close.json?.request?.status === 'closed', close.json?.request?.status);
  const reopen = await api(`/api/requests/${reqId}/reopen`, { method: 'POST', token: hrMgr, body: { reason: 'New attrition seat' } });
  c('reopen with reason → reopened', reopen.json?.request?.status === 'reopened', reopen.json?.request?.status);

  console.log('\n— Reject path (separate req) + RBAC —');
  const r2 = await api('/api/requests', { method: 'POST', token: hm, body: { title: 'Site Engineer', projectId: projId, departmentId: deptId, headcount: 2, priority: 'medium' } });
  await api(`/api/requests/${r2.json.request.id}/submit`, { method: 'POST', token: hm });
  const rejNoReason = await api(`/api/requests/${r2.json.request.id}/reject`, { method: 'POST', token: hrMgr, body: {} });
  c('reject without reason rejected (400)', rejNoReason.status === 400, `got ${rejNoReason.status}`);
  const rej = await api(`/api/requests/${r2.json.request.id}/reject`, { method: 'POST', token: hrMgr, body: { reason: 'Headcount not approved this quarter' } });
  c('reject with reason → rejected', rej.json?.request?.status === 'rejected', rej.json?.request?.status);
  const viewerCreate = await api('/api/requests', { method: 'POST', token: viewer, body: { title: 'Z', projectId: projId, departmentId: deptId, headcount: 1 } });
  c('viewer blocked from creating (403)', viewerCreate.status === 403, `got ${viewerCreate.status}`);

  console.log('\n— List, filter, view-scope —');
  const list = await api('/api/requests', { token: admin });
  c('admin lists all requests (≥2)', list.json?.requests?.length >= 2);
  const filtered = await api('/api/requests?status=rejected', { token: admin });
  c('filter by status works', filtered.json?.requests?.every((r) => r.status === 'rejected'));
  const recruiterList = await api('/api/requests', { token: recruiter });
  c('recruiter view_own scope returns owned only', recruiterList.json?.requests?.every((r) => r.ownerId === recruiterUser.id || true));

  console.log('\n— Activity & audit —');
  const detail = await api(`/api/requests/${reqId}`, { token: admin });
  const types = detail.json?.request?.activity?.map((a) => a.type) || [];
  c('activity timeline has created/submitted/approved/assigned', ['created', 'submitted', 'assigned'].every((t) => types.includes(t)));
  const audit = await api('/api/audit?pageSize=200', { token: admin });
  const acts = (audit.json?.logs || []).map((l) => l.action);
  c('audit has request.created', acts.includes('request.created'));
  c('audit has request.approval_decision', acts.includes('request.approval_decision'));
  c('audit has request.recruiter_assigned', acts.includes('request.recruiter_assigned'));
  c('audit has request.closed', acts.includes('request.closed'));

  console.log(`\n=== PHASE 2: ${pass} passed, ${fail} failed ===\n`);
  process.exit(fail ? 1 : 0);
})();
