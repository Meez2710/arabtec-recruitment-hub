// Recruitment team (25 Oct 2026): "Search by Department in the Talent Pool is
// not working". It only matched candidates LINKED to a request in the
// department, so a pool of imported CVs returned nobody. A candidate now also
// matches when their current position is one of the department's designations.
// Scoped readers keep the request-based rule. Disposable SQLite DB.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'arabtec-tp-dept-'));
process.env.DATABASE_URL = 'file:' + path.join(TMP, 'tp.db');
process.env.UPLOAD_DIR = path.join(TMP, 'uploads');
process.env.PORT = process.env.TP_DEPT_TEST_PORT || '4643';
process.env.SEED_DEMO_DATA = 'true';
process.env.SMTP_TRANSPORT = 'json';
process.env.SEED_ADMIN_PASSWORD ||= 'TpDept#2026x';
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
const login = async (e) => (await api('/api/auth/login', { method: 'POST', body: { email: e, password: 'Arabtec@123' } })).json.token;

try {
  db.run('UPDATE users SET must_change_password=0');
  const rec = await login('recruiter@arabtec.com'), hm = await login('hiring.manager@arabtec.com');
  const recId = db.get("SELECT id FROM users WHERE email='recruiter@arabtec.com'").id;
  // Two departments with designations of their own.
  const civil = Number(db.run("INSERT INTO department (code,name,status,created_at,updated_at) VALUES ('DPT-CIV-T','Civil Works T','active',datetime('now'),datetime('now'))").lastInsertRowid);
  const fin = Number(db.run("INSERT INTO department (code,name,status,created_at,updated_at) VALUES ('DPT-FIN-T','Finance T','active',datetime('now'),datetime('now'))").lastInsertRowid);
  for (const [t, d] of [['Site Engineer', civil], ['Quantity Surveyor', civil], ['Accountant', fin], ['Retired Title', civil]]) {
    db.run("INSERT INTO designation (title,grade,function,department_id,is_active,created_at,updated_at) VALUES (?,?,?,?,?,datetime('now'),datetime('now'))", [t, null, null, d, t === 'Retired Title' ? 0 : 1]);
  }
  const mk = (name, pos) => Candidates.create({ candidateNo: Candidates.nextNo(), fullName: name, email: name.replace(/\W/g, '').toLowerCase() + '@example.invalid', currentPosition: pos, createdBy: recId });
  const a = mk('Dept Senior Site Eng', 'Senior Site Engineer');   // contains a Civil designation
  const b = mk('Dept QS Short', 'QS');                            // not matched by name alone (short, no overlap)
  const d = mk('Dept Surveyor', 'Quantity Surveyor');            // exact Civil designation
  const e = mk('Dept Accountant', 'Senior Accountant');          // Finance
  const f = mk('Dept Retired', 'Retired Title Holder');          // inactive designation: not a match
  const g = mk('Dept Blank', null);                              // no position at all
  const list = async (token, qs) => (await api('/api/candidates?' + qs + '&pageSize=100', { token })).json;
  const ids = (r) => (r.candidates || []).map((x) => x.id);

  const civ = await list(rec, 'departmentId=' + civil);
  c('a recruiter searching Civil finds the pool candidates whose position is a Civil designation', ids(civ).includes(a.id) && ids(civ).includes(d.id), JSON.stringify(ids(civ)));
  c('…and not the accountant, the inactive-designation match or a candidate with no position', !ids(civ).includes(e.id) && !ids(civ).includes(f.id) && !ids(civ).includes(g.id), JSON.stringify(ids(civ)));
  c('the count matches the page (filter applied before paging)', civ.pagination.total === ids(civ).length, JSON.stringify(civ.pagination));
  const fi = await list(rec, 'departmentId=' + fin);
  c('Finance finds the accountant only', ids(fi).includes(e.id) && !ids(fi).includes(a.id) && !ids(fi).includes(d.id), JSON.stringify(ids(fi)));
  c("'QS' alone does not match — no guessing beyond the designation list", !ids(civ).includes(b.id));

  // A linked candidate still matches through the request's department, whatever their title says.
  const req = Number(db.run("INSERT INTO recruitment_request(ticket_no,title,department_id,requester_id,owner_id,created_by,status,headcount) VALUES ('TPD-1','Payroll Lead',?,?,?,?,'sourcing',1)", [fin, recId, recId, recId]).lastInsertRowid);
  const linked = await api('/api/applications', { method: 'POST', token: rec, body: { candidateId: a.id, requestId: req } });
  c('linking works', linked.status === 201, linked.text.slice(0, 200));
  const fi2 = await list(rec, 'departmentId=' + fin);
  c('a Civil-titled candidate linked to a Finance request is found under Finance too', ids(fi2).includes(a.id), JSON.stringify(ids(fi2)));

  // Scoped reader: request-based rule only.
  const hmId = db.get("SELECT id FROM users WHERE email='hiring.manager@arabtec.com'").id;
  db.run('UPDATE recruitment_request SET hiring_manager_id=?, requester_id=? WHERE id=?', [hmId, hmId, req]);
  await api(`/api/applications/${linked.json.application.id}/move`, { method: 'POST', token: rec, body: { status: 'shortlisted' } });
  const hmCiv = await list(hm, 'departmentId=' + civil);
  c('a hiring manager searching Civil does not see unlinked pool candidates through their titles', !ids(hmCiv).includes(d.id), JSON.stringify(ids(hmCiv)));
  const hmFin = await list(hm, 'departmentId=' + fin);
  c('…but does see the shortlisted candidate on their own Finance request', ids(hmFin).includes(a.id), JSON.stringify(ids(hmFin)));
} catch (err) { c('suite ran without throwing', false, err.stack || err.message); }
console.log(`\n=== TALENT POOL DEPARTMENT: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
