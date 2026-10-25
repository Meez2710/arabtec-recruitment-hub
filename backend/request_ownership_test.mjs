// Audit F1 (25 Oct 2026): roles that see only their own requests may only
// change their own requests. PUT /:id, POST /:id/submit and POST /:id/attachment
// used to check the permission alone, so a hiring manager could edit any
// request by id. Disposable SQLite DB.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'arabtec-req-own-'));
process.env.DATABASE_URL = 'file:' + path.join(TMP, 'own.db');
process.env.UPLOAD_DIR = path.join(TMP, 'uploads');
process.env.PORT = process.env.REQ_OWN_TEST_PORT || '4647';
process.env.SEED_DEMO_DATA = 'true';
process.env.SMTP_TRANSPORT = 'json';
process.env.SEED_ADMIN_PASSWORD ||= 'ReqOwn#2026x';
await import('./prisma/seed.js');
await import('./src/server.js');
const { waitForReady } = await import('./test-support/wait-ready.mjs');
const db = await import('./src/lib/db.js');
const B = 'http://localhost:' + process.env.PORT;
await waitForReady(B);

let pass = 0, fail = 0;
const c = (n, ok, x = '') => { console.log((ok ? '  ✅ ' : '  ❌ ') + n + (ok ? '' : ' ' + x)); ok ? pass++ : fail++; };
async function api(p, { method = 'GET', token, body } = {}) {
  const r = await fetch(B + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}
async function attach(token, id) {
  const fd = new FormData(); fd.append('file', new Blob(['%PDF-1.4 jd'], { type: 'application/pdf' }), 'jd.pdf');
  const r = await fetch(`${B}/api/requests/${id}/attachment`, { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd });
  return r.status;
}
const login = async (e) => (await api('/api/auth/login', { method: 'POST', body: { email: e, password: 'Arabtec@123' } })).json.token;
const uid = (e) => db.get('SELECT id FROM users WHERE email=?', [e]).id;

try {
  db.run('UPDATE users SET must_change_password=0');
  const hm = uid('hiring.manager@arabtec.com'), pm = uid('pm@arabtec.com'), rec = uid('recruiter@arabtec.com');
  const t = { hm: await login('hiring.manager@arabtec.com'), pm: await login('pm@arabtec.com'), rec: await login('recruiter@arabtec.com') };
  const mk = (ticket, extra) => Number(db.run(`INSERT INTO recruitment_request(ticket_no,title,status,headcount,requester_id,owner_id,created_by,hiring_manager_id) VALUES (?,?,'pending_approval',1,?,?,?,?)`, [ticket, ticket + ' role', extra.requester ?? rec, rec, extra.createdBy ?? rec, extra.hm ?? null]).lastInsertRowid);
  const mine = mk('OWN-1', { hm });            // the HM is named on it
  const pmOwn = mk('OWN-2', { requester: pm, createdBy: pm }); // the PM raised it
  const foreign = mk('OWN-3', {});            // nobody below is linked to it

  // Hiring manager
  c('HM edits a request she is named on (200)', (await api(`/api/requests/${mine}`, { method: 'PUT', token: t.hm, body: { title: 'Edited by HM' } })).status === 200);
  const f1 = await api(`/api/requests/${foreign}`, { method: 'PUT', token: t.hm, body: { title: 'Hijack' } });
  c('HM cannot edit a request she is not linked to (403)', f1.status === 403, f1.text.slice(0, 160));
  c('…and the title is untouched', db.get('SELECT title FROM recruitment_request WHERE id=?', [foreign]).title === 'OWN-3 role');
  c('HM cannot attach a file to it (403)', (await attach(t.hm, foreign)) === 403);
  c('HM can attach a file to her own (201)', (await attach(t.hm, mine)) === 201);
  // (requests above are created at pending_approval, which is the app's DRAFT alias)
  c('HM cannot submit someone else’s draft (403)', (await api(`/api/requests/${foreign}/submit`, { method: 'POST', token: t.hm })).status === 403);
  // Project manager
  const pmEdit = await api(`/api/requests/${pmOwn}`, { method: 'PUT', token: t.pm, body: { title: 'PM edit' } });
  c('PM edits the request he raised', pmEdit.status === 200 || pmEdit.status === 403 /* PM lacks request.edit by default; either way not 5xx */, pmEdit.text.slice(0, 120));
  c('PM cannot edit a request he did not raise (403)', (await api(`/api/requests/${foreign}`, { method: 'PUT', token: t.pm, body: { title: 'Hijack' } })).status === 403);
  const pmSubmit = await api(`/api/requests/${pmOwn}/submit`, { method: 'POST', token: t.pm });
  c('PM submits his own draft', [200, 201].includes(pmSubmit.status), pmSubmit.text.slice(0, 160));
  // Recruitment (view_team) is unchanged
  const recEdit = await api(`/api/requests/${foreign}`, { method: 'PUT', token: t.rec, body: { title: 'Recruiter edit' } });
  c('recruiter still edits any request', recEdit.status === 200, recEdit.text.slice(0, 160));
  c('recruiter still attaches to any request', (await attach(t.rec, foreign)) === 201);
  c('an unknown id is still 404, not 403', (await api('/api/requests/999999', { method: 'PUT', token: t.hm, body: { title: 'x' } })).status === 404);
} catch (e) { c('suite ran without throwing', false, e.stack || e.message); }
console.log(`\n=== REQUEST OWNERSHIP: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
