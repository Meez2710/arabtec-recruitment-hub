// Audit F4/F5 (25 Oct 2026). F5: opening a CV FILE is its own right
// (candidate.cv_view); read-only reporting roles keep the profile and lose the
// file. F4: hr_manager is a full-pipeline role and sees sourced candidates.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'arabtec-cvperm-'));
process.env.DATABASE_URL = 'file:' + path.join(TMP, 'cv.db');
process.env.UPLOAD_DIR = path.join(TMP, 'uploads');
process.env.PORT = process.env.CV_PERM_TEST_PORT || '4648';
process.env.SEED_DEMO_DATA = 'true';
process.env.SMTP_TRANSPORT = 'json';
process.env.SEED_ADMIN_PASSWORD ||= 'CvPerm#2026x';
await import('./prisma/seed.js');
await import('./src/server.js');
const { waitForReady } = await import('./test-support/wait-ready.mjs');
const db = await import('./src/lib/db.js');
const { Candidates } = await import('./src/lib/models.js');
const B = 'http://localhost:' + process.env.PORT;
await waitForReady(B);

let pass = 0, fail = 0;
const c = (n, ok, x = '') => { console.log((ok ? '  ✅ ' : '  ❌ ') + n + (ok ? '' : ' ' + x)); ok ? pass++ : fail++; };
async function api(p, { method = 'GET', token, body } = {}) {
  const r = await fetch(B + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}
const raw = (p, token) => fetch(B + p, { headers: { Authorization: 'Bearer ' + token } }).then((r) => r.status);
const login = async (e) => (await api('/api/auth/login', { method: 'POST', body: { email: e, password: 'Arabtec@123' } })).json.token;
const uid = (e) => db.get('SELECT id FROM users WHERE email=?', [e]).id;

try {
  db.run('UPDATE users SET must_change_password=0');
  const rec = uid('recruiter@arabtec.com');
  const t = { rec: await login('recruiter@arabtec.com'), viewer: await login('viewer@arabtec.com'), hrm: await login('hr.manager@arabtec.com'), hm: await login('hiring.manager@arabtec.com') };
  const rid = Number(db.run("INSERT INTO recruitment_request(ticket_no,title,status,headcount,requester_id,owner_id,created_by,hiring_manager_id) VALUES ('CVP-1','CV perm test','sourcing',3,?,?,?,?)", [rec, rec, rec, uid('hiring.manager@arabtec.com')]).lastInsertRowid);
  const cand = Candidates.create({ candidateNo: Candidates.nextNo(), fullName: 'File Perm Candidate', email: 'fileperm@example.invalid', createdBy: rec });
  const fd = new FormData(); fd.append('file', new Blob(['%PDF-1.4 cv'], { type: 'application/pdf' }), 'cv.pdf');
  c('recruiter stores a CV', (await fetch(`${B}/api/candidates/${cand.id}/resume?parse=0`, { method: 'POST', headers: { Authorization: 'Bearer ' + t.rec }, body: fd })).status === 201);
  const app = (await api('/api/applications', { method: 'POST', token: t.rec, body: { candidateId: cand.id, requestId: rid } })).json.application;

  // F4 — hr_manager sees the sourced candidate and can move it.
  c('hr_manager reads a sourced candidate (full pipeline)', (await api(`/api/candidates/${cand.id}`, { token: t.hrm })).status === 200);
  c('hr_manager lists the sourced application on the request', (await api(`/api/applications/request/${rid}`, { token: t.hrm })).json.applications?.some((a) => a.id === app.id) === true);
  const mv = await api(`/api/applications/${app.id}/move`, { method: 'POST', token: t.hrm, body: { status: 'shortlisted' } });
  c('hr_manager shortlists it (200)', mv.status === 200, mv.text.slice(0, 160));

  // F5 — the viewer reads the profile but not the file.
  c('viewer still reads the candidate profile (200)', (await api(`/api/candidates/${cand.id}`, { token: t.viewer })).status === 200);
  c('viewer cannot open the CV file (403)', (await raw(`/api/candidates/${cand.id}/resume`, t.viewer)) === 403);
  const doc = db.get('SELECT id FROM candidate_document WHERE candidate_id=? ORDER BY id DESC LIMIT 1', [cand.id]);
  c('viewer cannot open a CV document version (403)', !doc || (await raw(`/api/candidates/${cand.id}/documents/${doc.id}/file`, t.viewer)) === 403);
  c('the recruiter still can (200)', (await raw(`/api/candidates/${cand.id}/resume`, t.rec)) === 200);
  c('the hiring manager named on the request still can (200)', (await raw(`/api/candidates/${cand.id}/resume`, t.hm)) === 200);
  // A CV posted into the request conversation is the same right.
  const post = await fetch(`${B}/api/thread/request/${rid}/cv`, { method: 'POST', headers: { Authorization: 'Bearer ' + t.rec }, body: (() => { const f = new FormData(); f.append('file', new Blob(['%PDF-1.4 x'], { type: 'application/pdf' }), 'thread-cv.pdf'); f.append('fullName', 'Thread CV Person'); return f; })() });
  const pj = await post.json();
  c('recruiter posts a CV in the thread (201)', post.status === 201, JSON.stringify(pj).slice(0, 120));
  c('viewer reads the thread (200)', (await api(`/api/thread/request/${rid}`, { token: t.viewer })).status === 200);
  c('…and does not even see the posted CV while the candidate is unreleased (404)', (await raw(`/api/thread/post/${pj.post.id}/file`, t.viewer)) === 404);
  await api(`/api/applications/${pj.applicationId}/move`, { method: 'POST', token: t.rec, body: { status: 'shortlisted' } });
  c('…and once released, can see the post but not open the CV file (403)', (await raw(`/api/thread/post/${pj.post.id}/file`, t.viewer)) === 403);
  c('the recruiter opens it (200)', (await raw(`/api/thread/post/${pj.post.id}/file`, t.rec)) === 200);
  c('the new permission is granted to every candidate-facing role except viewer and CEO', (() => {
    const rows = db.all(`SELECT r.code FROM role r JOIN role_permission rp ON rp.role_id=r.id JOIN permission p ON p.id=rp.permission_id WHERE p.code='candidate.cv_view'`).map((x) => x.code).sort();
    return rows.includes('recruiter') && rows.includes('hiring_manager') && rows.includes('interviewer') && !rows.includes('viewer') && !rows.includes('ceo');
  })());
} catch (e) { c('suite ran without throwing', false, e.stack || e.message); }
console.log(`\n=== CV FILE PERMISSION: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
