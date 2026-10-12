// Interview → assessment availability (owner report: interviews scheduled from
// the Interviews page showed no assessment at all).
//   • a standalone interview can be linked to the candidate's application;
//   • scheduling on an application makes the assessment available at once
//     (an active interview unlocks it, even before the pipeline card moves);
//   • a cancelled-only interview does not unlock it;
//   • a completed / no-show interview can be reopened (back to Scheduled).
import { suiteDatabaseUrl } from './test-support/suite-db.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'arabtec-ivlink-'));
process.env.DATABASE_URL = suiteDatabaseUrl('file:' + path.join(TMP, 'ivlink.db'));
process.env.UPLOAD_DIR = path.join(TMP, 'uploads');
process.env.PORT = process.env.IVLINK_TEST_PORT || '4397';
process.env.SEED_DEMO_DATA ||= 'true';
process.env.SMTP_TRANSPORT = 'json';
const { adminToken, ADMIN_BOOTSTRAP_PASSWORD } = await import('./test-support/admin-session.mjs');
process.env.SEED_ADMIN_PASSWORD ||= ADMIN_BOOTSTRAP_PASSWORD;
await import('./prisma/seed.js');
await import('./src/server.js');
// Attendance/feedback need an interview that has started (audit A4/A5); see test-support/backdate.mjs.
const db = await import('./src/lib/db.js');
const { backdateInterview } = await import('./test-support/backdate.mjs');
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
const future = (d) => new Date(Date.now() + d * 86400000).toISOString();
const TECH = ['technical_knowledge', 'relevant_experience', 'problem_solving', 'tools_software', 'planning_organizing'];

try {
  const admin = await adminToken(B);
  const hrMgr = await login('hr.manager@arabtec.com');
  const hrDir = await login('hr.director@arabtec.com');
  const recMgr = await login('rec.manager@arabtec.com');
  const recruiter = await login('recruiter@arabtec.com');
  const interviewer = await login('interviewer@arabtec.com');
  const meta = (await api('/api/requests/meta/form', { token: hrMgr })).json;
  const recId = meta.recruiters.find((r) => r.name === 'Karim Adel').id;
  async function request(title) {
    const id = (await api('/api/requests', { method: 'POST', token: hrMgr, body: { title, justification: 'new_hire', projectId: meta.projects[0].id, departmentId: meta.departments[0].id, location: 'Cairo', headcount: 2, priority: 'high' } })).json.request.id;
    await api(`/api/requests/${id}/submit`, { method: 'POST', token: hrMgr });
    await api(`/api/requests/${id}/approve`, { method: 'POST', token: hrDir, body: {} });
    await api(`/api/requests/${id}/assign`, { method: 'POST', token: recMgr, body: { ownerId: recId } });
    return id;
  }
  const rA = await request('IVLINK Request A');
  const rB = await request('IVLINK Request B');
  const cand = async (n, ph) => (await api('/api/candidates', { method: 'POST', token: hrMgr, body: { fullName: n, phone: ph } })).json.candidate.id;
  const cA = await cand('IVLINK Candidate A', '+201000000701');
  const cOther = await cand('IVLINK Other', '+201000000702');
  const cC = await cand('IVLINK Cancelled', '+201000000703');
  const mona = (await api('/api/interviews/meta/form', { token: recruiter })).json.interviewers.find((u) => u.name === 'Mona Sami');
  const app = async (cid, rid) => (await api('/api/applications', { method: 'POST', token: recruiter, body: { candidateId: cid, requestId: rid, initialStatus: 'matched' } })).json.application.id;

  console.log('\n— a standalone interview can be linked to the candidate\'s application —');
  const iv = (await api('/api/interviews', { method: 'POST', token: recruiter, body: { candidateId: cA, requestId: rA, scheduledAt: future(2), panel: [{ interviewerId: mona.id }] } })).json.interview;
  c('standalone interview has no application', iv && !iv.application, JSON.stringify(iv?.application));
  const appA = await app(cA, rA);
  const appOther = await app(cOther, rB);
  c('interviewer cannot link (403)', (await api(`/api/interviews/${iv.id}/link-application`, { method: 'POST', token: interviewer, body: { applicationId: appA } })).status === 403);
  const wrongCand = await api(`/api/interviews/${iv.id}/link-application`, { method: 'POST', token: recruiter, body: { applicationId: appOther } });
  c('another candidate\'s application is refused (400)', wrongCand.status === 400 && /different candidate/.test(wrongCand.json?.error || ''), wrongCand.text);
  const linked = await api(`/api/interviews/${iv.id}/link-application`, { method: 'POST', token: recruiter, body: { applicationId: appA } });
  c('recruiter links it (200)', linked.status === 200 && linked.json?.interview?.application?.id === appA, linked.text.slice(0, 200));
  c('…and the request follows the application', linked.json?.interview?.request?.id === rA);
  c('a second link is refused (409)', (await api(`/api/interviews/${iv.id}/link-application`, { method: 'POST', token: recruiter, body: { applicationId: appA } })).status === 409);
  const audit = (await api('/api/audit?pageSize=100', { token: admin })).json.logs.find((l) => l.action === 'interview.application_linked' && String(l.entityId) === String(iv.id));
  c('the link is audited', !!audit);

  console.log('\n— an active interview unlocks the assessment —');
  const appRow = (await api(`/api/applications/${appA}`, { token: recruiter })).json.application;
  c('the application is still at an entry stage (not moved by hand)', ['matched', 'sourced', 'screening'].includes(appRow.status), appRow.status);
  const bundle = (await api(`/api/assessments/application/${appA}`, { token: interviewer })).json?.assessment;
  c('panel interviewer opens the assessment, unlocked', bundle?.unlocked === true, JSON.stringify(bundle && { unlocked: bundle.unlocked }));
  const save = await api(`/api/assessments/application/${appA}`, { method: 'POST', token: interviewer, body: { evaluatorType: 'technical', technical: Object.fromEntries(TECH.map((k) => [k, { score: 4 }])) } });
  c('…and saves a technical draft (201)', save.status === 201, save.text.slice(0, 160));

  console.log('\n— a cancelled-only interview does not unlock it —');
  const appC = await app(cC, rB);
  const ivC = (await api('/api/interviews', { method: 'POST', token: recruiter, body: { applicationId: appC, scheduledAt: future(3), panel: [{ interviewerId: mona.id }] } })).json.interview;
  c('scheduling on the application unlocks it immediately', (await api(`/api/assessments/application/${appC}`, { token: recruiter })).json?.assessment?.unlocked === true);
  await api(`/api/interviews/${ivC.id}/status`, { method: 'POST', token: recruiter, body: { status: 'cancelled', reason: 'test' } });
  c('after cancelling its only interview it is locked again', (await api(`/api/assessments/application/${appC}`, { token: recruiter })).json?.assessment?.unlocked === false);
  c('…and a save is refused (409)', (await api(`/api/assessments/application/${appC}`, { method: 'POST', token: recruiter, body: { evaluatorType: 'hr', behavioral: {} } })).status === 409);
  c('a cancelled interview cannot be linked (409)', (await api(`/api/interviews/${ivC.id}/link-application`, { method: 'POST', token: recruiter, body: { applicationId: appC } })).status === 409);

  console.log('\n— a completed interview can be reopened —');
  backdateInterview(db, iv.id, -90);
  await api(`/api/interviews/${iv.id}/status`, { method: 'POST', token: recruiter, body: { status: 'completed' } });
  c('marked completed', (await api(`/api/interviews/${iv.id}`, { token: recruiter })).json.interview.status === 'completed');
  const reopen = await api(`/api/interviews/${iv.id}/status`, { method: 'POST', token: recruiter, body: { status: 'scheduled', reason: 'Reopened after Completed' } });
  c('reopened to Scheduled (200)', reopen.status === 200 && (await api(`/api/interviews/${iv.id}`, { token: recruiter })).json.interview.status === 'scheduled', reopen.text.slice(0, 160));
  c('the reopen is audited with its reason', !!(await api('/api/audit?pageSize=100', { token: admin })).json.logs.find((l) => l.action === 'interview.status_changed' && String(l.entityId) === String(iv.id) && l.newValue?.status === 'scheduled' && /Reopened/.test(l.comments || '')));
  c('the saved assessment draft survives the reopen', (await api(`/api/assessments/application/${appA}`, { token: interviewer })).json?.assessment?.technical?.status === 'draft');
} catch (e) { console.error(e); fail++; }
finally {
  console.log(`\n=== INTERVIEW ASSESSMENT LINK: ${pass} passed, ${fail} failed ===\n`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.exit(fail ? 1 : 0);
}
