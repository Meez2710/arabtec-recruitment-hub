process.env.DATABASE_URL = 'file:/tmp/arabtec_p3.db';
process.env.PORT = '4130';
import fs from 'node:fs';
for (const f of ['/tmp/arabtec_p3.db', '/tmp/arabtec_p3.db-journal']) { try { fs.rmSync(f); } catch {} }
await import('./prisma/seed.js');
await import('./src/server.js');
await new Promise((r) => setTimeout(r, 700));
const B = 'http://localhost:4130';
let pass = 0, fail = 0;
const c = (n, ok, x = '') => { console.log((ok ? '  ✅ ' : '  ❌ ') + n + ' ' + x); ok ? pass++ : fail++; };
async function api(p, { method = 'GET', token, body } = {}) {
  const r = await fetch(B + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, json: j };
}
const login = async (e, p = 'Arabtec@123') => (await api('/api/auth/login', { method: 'POST', body: { email: e, password: p } })).json.token;

(async () => {
  const admin = await login('admin@arabtec.com', 'Admin@12345');
  const recruiter = await login('recruiter@arabtec.com');
  const hrMgr = await login('hr.manager@arabtec.com');
  const recMgr = await login('rec.manager@arabtec.com');
  const hm = await login('hiring.manager@arabtec.com');
  const interviewer = await login('interviewer@arabtec.com');
  const viewer = await login('viewer@arabtec.com');

  // Prepare an approved+sourcing request to link candidates to.
  const meta = await api('/api/requests/meta/form', { token: hrMgr });
  const cr = await api('/api/requests', { method: 'POST', token: hrMgr, body: { title: 'Site Engineer', projectId: meta.json.projects[0].id, departmentId: meta.json.departments[0].id, headcount: 2, priority: 'high' } });
  const reqId = cr.json.request.id;
  await api(`/api/requests/${reqId}/submit`, { method: 'POST', token: hrMgr });
  await api(`/api/requests/${reqId}/approve`, { method: 'POST', token: hrMgr, body: {} }); // single HR Director approval
  const recId = meta.json.recruiters.find((r) => r.name === 'Karim Adel').id;
  await api(`/api/requests/${reqId}/assign`, { method: 'POST', token: recMgr, body: { ownerId: recId } });

  console.log('\n— Candidate create + separation —');
  const cand = await api('/api/candidates', { method: 'POST', token: recruiter, body: { fullName: 'Ahmed Mohamed', email: 'ahmed@example.com', phone: '+20 100 111 2222', currentPosition: 'Mechanical Engineer', currentCompany: 'Orascom', yearsExperience: 8, location: 'Cairo', noticePeriod: '1 month', source: 'referral', tags: 'mechanical, senior' } });
  c('recruiter creates candidate (201)', cand.status === 201, `got ${cand.status}`);
  c('candidate has CAN id', /^CAN-\d{5}$/.test(cand.json?.candidate?.candidateNo || ''), cand.json?.candidate?.candidateNo);
  c('candidate object has NO status field', !('status' in (cand.json?.candidate || { status: 1 })));
  const candId = cand.json.candidate.id;

  console.log('\n— Validation + dedup —');
  const noContact = await api('/api/candidates', { method: 'POST', token: recruiter, body: { fullName: 'No Contact' } });
  c('no email/phone rejected (400)', noContact.status === 400, `got ${noContact.status}`);
  const dup = await api('/api/candidates', { method: 'POST', token: recruiter, body: { fullName: 'Ahmed M', email: 'ahmed@example.com' } });
  c('duplicate email detected (409)', dup.status === 409, `got ${dup.status}`);
  c('duplicate response lists the match', dup.json?.duplicates?.[0]?.id === candId);
  const override = await api('/api/candidates', { method: 'POST', token: recruiter, body: { fullName: 'Ahmed M', email: 'ahmed@example.com', overrideDuplicate: true, overrideReason: 'different person' } });
  c('recruiter without merge perm cannot override (403)', override.status === 403, `got ${override.status}`);
  const overrideOk = await api('/api/candidates', { method: 'POST', token: hrMgr, body: { fullName: 'Ahmed Twin', email: 'ahmed@example.com', overrideDuplicate: true, overrideReason: 'genuinely different person' } });
  c('merge-perm role can override with reason (201)', overrideOk.status === 201, `got ${overrideOk.status}`);

  console.log('\n— Salary field-level visibility —');
  const candAsRecruiter = await api(`/api/candidates/${candId}`, { token: recruiter });
  c('recruiter: salaryVisible false', candAsRecruiter.json?.candidate?.salaryVisible === false);
  const candAsHr = await api(`/api/candidates/${candId}`, { token: hrMgr });
  c('HR manager: salaryVisible true', candAsHr.json?.candidate?.salaryVisible === true);

  console.log('\n— Application: link candidate ↔ request (separation) —');
  const app1 = await api('/api/applications', { method: 'POST', token: recruiter, body: { candidateId: candId, requestId: reqId, initialStatus: 'applied', matchScore: 82, source: 'referral' } });
  c('link creates application (201)', app1.status === 201, `got ${app1.status}`);
  c('application has APP id + status applied', app1.json?.application?.applicationNo?.startsWith('APP-') && app1.json?.application?.status === 'applied');
  const appId = app1.json.application.id;
  const dupApp = await api('/api/applications', { method: 'POST', token: recruiter, body: { candidateId: candId, requestId: reqId } });
  c('duplicate application to same request blocked (409)', dupApp.status === 409, `got ${dupApp.status}`);

  // Second request → same candidate, independent application
  const cr2 = await api('/api/requests', { method: 'POST', token: hrMgr, body: { title: 'Project Engineer', projectId: meta.json.projects[0].id, departmentId: meta.json.departments[0].id, headcount: 1 } });
  const app2 = await api('/api/applications', { method: 'POST', token: recruiter, body: { candidateId: candId, requestId: cr2.json.request.id, initialStatus: 'cv_screening' } });
  c('same candidate, 2nd request = independent application', app2.status === 201 && app2.json.application.status === 'cv_screening');

  console.log('\n— Candidate profile shows multiple applications with independent statuses —');
  const profile = await api(`/api/candidates/${candId}`, { token: recruiter });
  const apps = profile.json?.candidate?.applications || [];
  c('candidate linked to 2 applications', apps.length === 2);
  c('applications carry independent statuses', new Set(apps.map((a) => a.status)).size === 2);

  console.log('\n— Stage movement + reason rules —');
  const move = await api(`/api/applications/${appId}/move`, { method: 'POST', token: recruiter, body: { status: 'shortlisted' } });
  c('recruiter moves stage (applied→shortlisted)', move.json?.application?.status === 'shortlisted');
  const rejNoReason = await api(`/api/applications/${appId}/move`, { method: 'POST', token: recruiter, body: { status: 'rejected' } });
  c('reject without reason blocked (400)', rejNoReason.status === 400, `got ${rejNoReason.status}`);
  const interviewerMove = await api(`/api/applications/${appId}/move`, { method: 'POST', token: interviewer, body: { status: 'technical_interview' } });
  c('interviewer cannot move pipeline (403)', interviewerMove.status === 403, `got ${interviewerMove.status}`);
  const hmMove = await api(`/api/applications/${appId}/move`, { method: 'POST', token: hm, body: { status: 'technical_interview' } });
  c('hiring manager cannot move pipeline (403)', hmMove.status === 403, `got ${hmMove.status}`);
  const viewerView = await api(`/api/applications/request/${reqId}`, { token: viewer });
  c('viewer can read pipeline (200)', viewerView.status === 200);

  console.log('\n— Joined → vacancy automation —');
  await api(`/api/applications/${appId}/move`, { method: 'POST', token: recruiter, body: { status: 'joined' } });
  const reqAfter = await api(`/api/requests/${reqId}`, { token: hrMgr });
  c('headcount_filled incremented to 1', reqAfter.json?.request?.headcountFilled === 1, `got ${reqAfter.json?.request?.headcountFilled}`);
  c('request → partially_filled (1 of 2)', reqAfter.json?.request?.status === 'partially_filled', reqAfter.json?.request?.status);

  console.log('\n— Bulk action —');
  // link a fresh candidate to bulk-move
  const c2 = await api('/api/candidates', { method: 'POST', token: recruiter, body: { fullName: 'Sara Nabil', phone: '+20 122 333 4444', currentPosition: 'Civil Engineer' } });
  const a2 = await api('/api/applications', { method: 'POST', token: recruiter, body: { candidateId: c2.json.candidate.id, requestId: reqId } });
  const bulk = await api('/api/applications/bulk', { method: 'POST', token: recruiter, body: { ids: [a2.json.application.id], action: 'move', status: 'cv_screening' } });
  c('bulk move (200, affected 1)', bulk.status === 200 && bulk.json.affected === 1, JSON.stringify(bulk.json));
  const bulkRejNoReason = await api('/api/applications/bulk', { method: 'POST', token: recruiter, body: { ids: [a2.json.application.id], action: 'move', status: 'rejected' } });
  c('bulk reject without reason blocked (400)', bulkRejNoReason.status === 400, `got ${bulkRejNoReason.status}`);

  console.log('\n— Notes + RBAC —');
  const note = await api(`/api/candidates/${candId}/notes`, { method: 'POST', token: recruiter, body: { body: 'Strong HVAC background', noteType: 'assessment' } });
  c('recruiter adds note (201)', note.status === 201);
  const viewerCreate = await api('/api/candidates', { method: 'POST', token: viewer, body: { fullName: 'X', email: 'x@y.com' } });
  c('viewer cannot create candidate (403)', viewerCreate.status === 403, `got ${viewerCreate.status}`);

  console.log('\n— Audit —');
  const audit = await api('/api/audit?pageSize=300', { token: admin });
  const acts = (audit.json?.logs || []).map((l) => l.action);
  for (const a of ['candidate.created', 'application.created', 'application.status_changed', 'request.seat_filled', 'candidate.note_added', 'application.bulk_action']) {
    c('audit has ' + a, acts.includes(a));
  }

  console.log(`\n=== PHASE 3: ${pass} passed, ${fail} failed ===\n`);
  process.exit(fail ? 1 : 0);
})();
