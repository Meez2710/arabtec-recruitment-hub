// Director dashboard data (owner review, 4 Oct 2026):
//   • /api/dashboard narrows every figure by projectId / departmentId / ownerId;
//   • role age counts only approved, running requests, from approval;
//   • requests still awaiting approval are reported separately;
//   • a filter can never widen a scoped user's view; junk filter values are ignored.
import { suiteDatabaseUrl } from './test-support/suite-db.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'arabtec-dashdir-'));
process.env.DATABASE_URL = suiteDatabaseUrl('file:' + path.join(TMP, 'dashdir.db'));
process.env.UPLOAD_DIR = path.join(TMP, 'uploads');
process.env.PORT = process.env.DASHDIR_TEST_PORT || '4398';
process.env.SEED_DEMO_DATA ||= 'true';
process.env.SMTP_TRANSPORT = 'json';
const { ADMIN_BOOTSTRAP_PASSWORD } = await import('./test-support/admin-session.mjs');
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

try {
  const hrMgr = await login('hr.manager@arabtec.com');
  const hrDir = await login('hr.director@arabtec.com');
  const recMgr = await login('rec.manager@arabtec.com');
  const recruiter = await login('recruiter@arabtec.com');
  const hm = await login('hiring.manager@arabtec.com');
  const meta = (await api('/api/requests/meta/form', { token: hrMgr })).json;
  const [p1, p2] = meta.projects; const dep = meta.departments[0];
  const karim = meta.recruiters.find((r) => r.name === 'Karim Adel');
  async function request(token, title, project, headcount, approve) {
    const id = (await api('/api/requests', { method: 'POST', token, body: { title, justification: 'new_hire', projectId: project.id, departmentId: dep.id, location: 'Cairo', headcount, priority: 'high' } })).json.request.id;
    await api(`/api/requests/${id}/submit`, { method: 'POST', token });
    if (approve) {
      await api(`/api/requests/${id}/approve`, { method: 'POST', token: hrDir, body: {} });
      await api(`/api/requests/${id}/assign`, { method: 'POST', token: recMgr, body: { ownerId: karim.id } });
    }
    return id;
  }
  const r1 = await request(hrMgr, 'DASHDIR Approved P1', p1, 3, true);
  await request(hrMgr, 'DASHDIR Pending P1', p1, 2, false);
  await request(hrMgr, 'DASHDIR Approved P2', p2, 5, true);
  await request(hm, 'DASHDIR HM own P2', p2, 1, false);
  const cand = (await api('/api/candidates', { method: 'POST', token: hrMgr, body: { fullName: 'DASHDIR Candidate', phone: '+201000000801' } })).json.candidate.id;
  await api('/api/applications', { method: 'POST', token: recruiter, body: { candidateId: cand, requestId: r1, initialStatus: 'matched' } });

  console.log('\n— age counts approved roles only; waiting requests are separate —');
  const all = (await api('/api/dashboard', { token: hrDir })).json;
  const agingTotal = Object.values(all.aging).reduce((a, b) => a + b, 0);
  const activeOpen = (await api('/api/requests?pageSize=100', { token: hrDir })).json.requests.filter((r) => ['sourcing', 'in_progress', 'partially_filled', 'on_hold', 'reopened', 'approved', 'in_sourcing'].includes(r.status)).length;
  c('aging buckets hold exactly the approved, running requests', agingTotal === activeOpen, `${agingTotal} vs ${activeOpen}`);
  c('awaiting approval is reported separately, with the oldest wait', all.awaitingApproval && all.awaitingApproval.count >= 2 && typeof all.awaitingApproval.oldestDays === 'number', JSON.stringify(all.awaitingApproval));
  c('no filters echoed when none are applied', all.filters === null);

  console.log('\n— narrowing by project / department / recruiter —');
  const n1 = (await api(`/api/dashboard?projectId=${p1.id}`, { token: hrDir })).json;
  const p1Reqs = (await api('/api/requests?pageSize=100', { token: hrDir })).json.requests.filter((r) => Number(r.projectId) === Number(p1.id));
  c('requests by status sum to the project\'s requests', n1.requestsByStatus.reduce((a, r) => a + r.count, 0) === p1Reqs.length, `${n1.requestsByStatus.reduce((a, r) => a + r.count, 0)} vs ${p1Reqs.length}`);
  c('planned seats are the project\'s seats', n1.kpis.headcountTotal === p1Reqs.reduce((a, r) => a + (r.headcount || 0), 0));
  c('applications follow the project (our candidate is on P1)', n1.applicationsByStatus.reduce((a, r) => a + r.count, 0) >= 1);
  const n2 = (await api(`/api/dashboard?projectId=${p2.id}`, { token: hrDir })).json;
  c('…and do not leak into another project', n2.applicationsByStatus.every((r) => r.count === 0) || n2.kpis.totalApplications < all.kpis.totalApplications);
  c('the applied filter is echoed', n1.filters && n1.filters.projectId === p1.id);
  const byOwner = (await api(`/api/dashboard?ownerId=${karim.id}`, { token: hrDir })).json;
  c('recruiter filter narrows the workload to that recruiter', byOwner.recruiterLoad.every((r) => r.id === karim.id), JSON.stringify(byOwner.recruiterLoad));
  const byDept = (await api(`/api/dashboard?departmentId=${dep.id}&projectId=${p2.id}`, { token: hrDir })).json;
  c('filters combine (department AND project)', byDept.requestsByStatus.reduce((a, r) => a + r.count, 0) <= n2.requestsByStatus.reduce((a, r) => a + r.count, 0));
  const junk = (await api('/api/dashboard?projectId=abc&ownerId=-3&departmentId=1;DROP', { token: hrDir }));
  c('junk filter values are ignored, not errors', junk.status === 200 && junk.json.filters === null && junk.json.kpis.totalRequests === all.kpis.totalRequests);

  console.log('\n— a filter never widens a scoped view —');
  const hmAll = (await api('/api/dashboard', { token: hm })).json;
  const hmP1 = (await api(`/api/dashboard?projectId=${p1.id}`, { token: hm })).json;
  c('hiring manager sees only own requests', hmAll.scope === 'own' && hmAll.kpis.totalRequests >= 1 && hmAll.kpis.totalRequests < all.kpis.totalRequests);
  c('…and filtering to a project of HR\'s requests shows none of them', hmP1.kpis.totalRequests === 0, String(hmP1.kpis.totalRequests));
} catch (e) { console.error(e); fail++; }
finally {
  console.log(`\n=== DIRECTOR DASHBOARD DATA: ${pass} passed, ${fail} failed ===\n`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.exit(fail ? 1 : 0);
}
