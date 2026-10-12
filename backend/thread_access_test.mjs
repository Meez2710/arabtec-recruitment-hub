// Request-thread access is request-specific (security fix, 12 Oct 2026).
//
// Before: thread.js isParticipant() admitted ANY holder of request.create
// (project managers, hiring managers) or interview.feedback (interviewers) to
// EVERY request's thread — so a CV posted in one hiring request could be read
// and downloaded by people with no link to it, by post id. The request page
// itself (requests.js canView) never allowed that.
//
// After: org-wide request roles (admin, HR, recruitment managers, recruiters)
// are unchanged; the others reach a thread only through THIS request — owner,
// requester, creator, its hiring manager, or a panelist on one of its interviews.
// Synthetic data only.
import { suiteDatabaseUrl } from './test-support/suite-db.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'arabtec-threadacl-'));
process.env.DATABASE_URL = suiteDatabaseUrl('file:' + path.join(TMP, 'threadacl.db'));
process.env.UPLOAD_DIR = path.join(TMP, 'uploads');
process.env.PORT = process.env.THREAD_ACL_TEST_PORT || '4391';
process.env.SEED_DEMO_DATA ||= 'true';
process.env.SMTP_TRANSPORT = 'json';
process.env.MICROSOFT_TOKEN_ENCRYPTION_KEY ||= 'c'.repeat(64);
const { ADMIN_BOOTSTRAP_PASSWORD } = await import('./test-support/admin-session.mjs');
process.env.SEED_ADMIN_PASSWORD ||= ADMIN_BOOTSTRAP_PASSWORD;
await import('./prisma/seed.js');
await import('./src/server.js');
const { waitForReady } = await import('./test-support/wait-ready.mjs');
const B = 'http://localhost:' + process.env.PORT;
await waitForReady(B);
const db = await import('./src/lib/db.js');
const { storeFile } = await import('./src/lib/upload.js');
const { Posts, Interviews, InterviewPanel, Candidates } = await import('./src/lib/models.js');

let pass = 0, fail = 0;
const c = (n, ok, x = '') => { console.log((ok ? '  ✅ ' : '  ❌ ') + n + (ok ? '' : ' ' + x)); ok ? pass++ : fail++; };
const login = async (e) => (await (await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: e, password: 'Arabtec@123' }) })).json()).token;
const http = (p, token, method = 'GET', body) => fetch(B + '/api' + p, { method, headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
const userId = (email) => db.get('SELECT id FROM users WHERE email=?', [email]).id;

try {
  const T = {
    hrMgr: await login('hr.manager@arabtec.com'), hrDir: await login('hr.director@arabtec.com'),
    recMgr: await login('rec.manager@arabtec.com'), recruiter: await login('recruiter@arabtec.com'),
    viewer: await login('viewer@arabtec.com'), hm: await login('hiring.manager@arabtec.com'),
    pm: await login('pm@arabtec.com'), interviewer: await login('interviewer@arabtec.com'),
  };
  const meta = await (await http('/requests/meta/form', T.hrMgr)).json();
  const mkReq = async (title) => (await (await http('/requests', T.hrMgr, 'POST', { title, justification: 'new_hire', projectId: meta.projects[0].id, departmentId: meta.departments[0].id, location: 'Cairo', headcount: 1, priority: 'normal' })).json()).request;
  // A: nobody below is linked to it. L: the hiring manager, the PM and the interviewer are each linked to it.
  const A = await mkReq('Unrelated request (thread ACL)');
  const L = await mkReq('Linked request (thread ACL)');
  c('two requests created', !!A?.id && !!L?.id);
  db.run('UPDATE recruitment_request SET hiring_manager_id=? WHERE id=?', [userId('hiring.manager@arabtec.com'), L.id]);
  db.run('UPDATE recruitment_request SET requester_id=? WHERE id=?', [userId('pm@arabtec.com'), L.id]);
  const cand = Candidates.create({ candidateNo: Candidates.nextNo(), fullName: 'Synthetic ACL Candidate', createdBy: 1 });
  const iv = Interviews.create({ interviewNo: 'INT-ACL-1', candidateId: cand.id, requestId: L.id, organizerId: 1, createdBy: 1, scheduledAt: '2026-11-01T08:00:00.000Z' });
  InterviewPanel.set(iv.id, [{ interviewerId: userId('interviewer@arabtec.com'), isLead: true }]);

  const fileOn = (r, name) => Posts.create({ requestId: r.id, postType: 'cv', authorId: 1, authorName: 'Synthetic Admin', filePath: storeFile(name, Buffer.from(`%PDF-1.4\n% ${name}\n%%EOF\n`)).storedName, fileName: name, payload: { candidateName: 'Synthetic ACL Candidate' } });
  const pA = fileOn(A, 'Unrelated_CV.pdf');
  const pL = fileOn(L, 'Linked_CV.pdf');

  console.log('\n— 1. No CV from an unrelated request —');
  for (const role of ['hm', 'pm', 'interviewer']) {
    c(`${role}: unrelated thread is refused (403)`, (await http(`/thread/request/${A.id}`, T[role])).status === 403);
    c(`${role}: unrelated CV file is refused (403)`, (await http(`/thread/post/${pA.id}/file`, T[role])).status === 403);
    c(`${role}: unrelated CV preview is refused (403)`, (await http(`/thread/post/${pA.id}/file?as=html`, T[role])).status === 403);
    c(`${role}: cannot post into an unrelated thread (403)`, (await http(`/thread/request/${A.id}`, T[role], 'POST', { body: 'x' })).status === 403);
  }

  console.log('\n— 2. Linked people keep their access —');
  c('hiring manager of the request reads its thread and CV', (await http(`/thread/request/${L.id}`, T.hm)).status === 200 && (await http(`/thread/post/${pL.id}/file`, T.hm)).status === 200);
  c('requester (PM) reads its thread and CV', (await http(`/thread/request/${L.id}`, T.pm)).status === 200 && (await http(`/thread/post/${pL.id}/file`, T.pm)).status === 200);
  c('panelist on its interview reads its thread and CV', (await http(`/thread/request/${L.id}`, T.interviewer)).status === 200 && (await http(`/thread/post/${pL.id}/file`, T.interviewer)).status === 200);
  c('hiring manager can still post in their request', (await http(`/thread/request/${L.id}`, T.hm, 'POST', { body: 'Feedback from the hiring manager' })).status < 300);

  console.log('\n— 3. Org-wide roles are unchanged —');
  for (const role of ['hrMgr', 'hrDir', 'recMgr', 'recruiter', 'viewer']) {
    c(`${role}: reads any thread and CV (200)`, (await http(`/thread/request/${A.id}`, T[role])).status === 200 && (await http(`/thread/post/${pA.id}/file`, T[role])).status === 200);
  }
  for (const role of ['hrMgr', 'recMgr', 'recruiter']) {
    c(`${role}: still posts in any thread`, (await http(`/thread/request/${A.id}`, T[role], 'POST', { body: `note from ${role}` })).status < 300);
  }
  c('viewer and HR Director still cannot post (read-only, as before)',
    (await http(`/thread/request/${A.id}`, T.viewer, 'POST', { body: 'x' })).status === 403
    && (await http(`/thread/request/${A.id}`, T.hrDir, 'POST', { body: 'x' })).status === 403);
} catch (e) { console.error(e); fail++; }
finally {
  console.log(`\n=== THREAD ACCESS: ${pass} passed, ${fail} failed ===\n`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
}
