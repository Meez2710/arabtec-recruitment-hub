// Request-to-offer boundary regressions, using the actual on-premises HTTP routes.
import { suiteDatabaseUrl } from './test-support/suite-db.mjs';
process.env.DATABASE_URL = suiteDatabaseUrl(`file:/tmp/arabtec_workflow_${process.pid}.db`);
process.env.PORT = '4397';
process.env.NODE_ENV = 'test';
process.env.SEED_DEMO_DATA = 'true';
process.env.SMTP_TRANSPORT = 'json';
process.env.SEED_ADMIN_PASSWORD = 'Admin@12345';
await import('./prisma/seed.js');
await import('./src/server.js');
const { waitForReady } = await import('./test-support/wait-ready.mjs');
const B = 'http://localhost:4397';
await waitForReady(B);
let passed = 0, failed = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`);
  ok ? passed++ : failed++;
}
async function api(path, token, method = 'GET', body) {
  const r = await fetch(B + '/api' + path, { method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, ...await r.json() };
}
async function must(path, token, method = 'GET', body) {
  const r = await api(path, token, method, body);
  if (r.status >= 400) throw new Error(`Fixture ${method} ${path}: ${JSON.stringify(r)}`);
  return r;
}
const login = async (email) => (await must('/auth/login', null, 'POST', { email, password: 'Arabtec@123' })).token;
const recruiter = await login('recruiter@arabtec.com');
const manager = await login('rec.manager@arabtec.com');
const hr = await login('hr.manager@arabtec.com');
const director = await login('hr.director@arabtec.com');
const meta = await must('/requests/meta/form', manager);
const panel = (await must('/interviews/meta/form', recruiter)).interviewers[0].id;
let serial = 0;
async function fixture() {
  const n = ++serial;
  const request = (await must('/requests', manager, 'POST', {
    title: 'Workflow Audit ' + n, projectId: meta.projects[0].id,
    departmentId: meta.departments[0].id, headcount: 2, priority: 'normal',
  })).request;
  await must(`/requests/${request.id}/approve`, director, 'POST', {});
  await must(`/requests/${request.id}/assign`, manager, 'POST', { ownerId: meta.recruiters.find(r => r.name === 'Karim Adel').id });
  const candidate = (await must('/candidates', recruiter, 'POST', {
    fullName: 'Synthetic Workflow ' + n, email: `workflow-${n}@example.invalid`,
  })).candidate;
  const app = (await must('/applications', recruiter, 'POST', {
    candidateId: candidate.id, requestId: request.id, initialStatus: 'matched',
  })).application;
  await must(`/applications/${app.id}/move`, recruiter, 'POST', { status: 'interviewing' });
  const offer = (await must('/offers', recruiter, 'POST', {
    applicationId: app.id, salaryOffered: 20000, currency: 'EGP', benefits: 'Transport',
  })).offer;
  await must(`/offers/${offer.id}/submit`, recruiter, 'POST', {});
  await must(`/offers/${offer.id}/approve`, director, 'POST', {});
  return { request, candidate, app, offer };
}
for (const status of ['rejected', 'on_hold', 'offer_declined']) {
  const f = await fixture();
  await must(`/applications/${f.app.id}/move`, recruiter, 'POST', { status, reason: 'Audit stop' });
  const r = await api(`/offers/${f.offer.id}/send`, hr, 'POST', {});
  check('send refuses ' + status + ' application', r.status === 409, 'HTTP ' + r.status);
  check('send preserves stopped application ' + status, (await must('/applications/' + f.app.id, recruiter)).application.status === status);
  check('refused send preserves approved offer', (await must('/offers/' + f.offer.id, hr)).offer.status === 'approved');
}
for (const [field, value] of [['currency', 'USD'], ['benefits', 'Housing and transport'], ['positionTitle', 'Senior Engineer']]) {
  const f = await fixture();
  const r = await must('/offers/' + f.offer.id, recruiter, 'PUT', { [field]: value });
  check(field + ' change requires approval again', r.offer.status === 'pending_approval');
  check(field + ' change clears approvedBy', r.offer.approvedBy === null);
  const send = await api(`/offers/${f.offer.id}/send`, hr, 'POST', {});
  check(field + ' cannot be sent before reapproval', send.status === 409);
}
{
  const f = await fixture();
  await must(`/offers/${f.offer.id}/send`, hr, 'POST', {});
  const r = await api('/offers/' + f.offer.id, recruiter, 'PUT', { salaryOffered: 99999 });
  check('sent offer is immutable', r.status === 409, 'HTTP ' + r.status);
  check('issued salary remains approved amount', (await must('/offers/' + f.offer.id, hr)).offer.salaryOffered === 20000);
}
{
  const f = await fixture();
  await must(`/applications/${f.app.id}/move`, recruiter, 'POST', { status: 'offer_declined', reason: 'Declined' });
  const r = await api('/interviews', recruiter, 'POST', {
    applicationId: f.app.id, scheduledAt: new Date(Date.now() + 86400000).toISOString(),
    panel: [{ interviewerId: panel, isLead: true }],
  });
  check('declined offer blocks new interview', r.status === 409, 'HTTP ' + r.status);
  const list = await must('/interviews/application/' + f.app.id, recruiter);
  check('refused interview creates no calendar record', list.interviews.length === 0);
}
console.log(`WORKFLOW INTEGRITY: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
