// Real API regression: candidate-linked dates, documented history and scoped department paging.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-talent-table-'));
process.env.DATABASE_URL = 'file:' + path.join(tmp, 'test.db');
process.env.UPLOAD_DIR = path.join(tmp, 'uploads');
process.env.PORT = '4496';
process.env.SEED_DEMO_DATA = 'true';
process.env.SEED_ADMIN_PASSWORD = 'TestOnly#Admin123';
process.env.SMTP_TRANSPORT = 'json';
await import('./prisma/seed.js');
await import('./src/server.js');
const { waitForReady } = await import('./test-support/wait-ready.mjs');
const { run, get } = await import('./src/lib/db.js');
const base = 'http://127.0.0.1:4496';
await waitForReady(base);
let failed = 0;
const check = (name, fn) => { try { fn(); console.log('PASS', name); } catch (e) { failed++; console.error('FAIL', name, e.message); } };
const login = async (email) => (await (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'Arabtec@123' }) })).json()).token;
try {
  const hr = await login('hr.manager@arabtec.com');
  const hm = await login('hiring.manager@arabtec.com');
  const hmId = get("SELECT id FROM users WHERE email='hiring.manager@arabtec.com'").id;
  const dep = get('SELECT id FROM department ORDER BY id LIMIT 1').id;
  const dep2 = get('SELECT id FROM department WHERE id<>? ORDER BY id LIMIT 1', [dep]).id;
  const insert = (sql, args) => Number(run(sql, args).lastInsertRowid);
  const cand = (code) => insert("INSERT INTO candidate(candidate_no,full_name,current_position,university,graduation_year,location,created_at) VALUES (?,?, 'Civil Engineer','Cairo University',2014,'Cairo','2026-10-10T10:00:00Z')", [code, code]);
  const cid = cand('TABLE Original');
  const fresh = cand('TABLE New');
  const unknown = cand('TABLE Unsupported blacklist');
  run("UPDATE candidate SET candidate_state='blacklisted' WHERE id=?", [unknown]);
  const req = insert("INSERT INTO recruitment_request(ticket_no,title,department_id,requester_id,status) VALUES ('TABLE-R1','Civil Engineer',?,?,'closed')", [dep, hmId]);
  const hiddenReq = insert("INSERT INTO recruitment_request(ticket_no,title,department_id,status) VALUES ('TABLE-R2','Hidden Request',?,'closed')", [dep2]);
  const app = insert("INSERT INTO application(application_no,candidate_id,request_id,status,match_score) VALUES ('TABLE-A1',?,?,'rejected',85)", [cid, req]);
  const hiddenApp = insert("INSERT INTO application(application_no,candidate_id,request_id,status) VALUES ('TABLE-A2',?,?,'rejected')", [cid, hiddenReq]);
  run("INSERT INTO application_stage_history(application_id,from_status,to_status,actor_id,actor_name) VALUES (?,'screening','shortlisted',?,'Fixture')", [hiddenApp, hmId]);
  const intake = insert("INSERT INTO candidate_intake(candidate_id,status) VALUES (?,'CONVERTED')", [cid]);
  const otherIntake = insert("INSERT INTO candidate_intake(candidate_id,status) VALUES (?,'CONVERTED')", [fresh]);
  for (const [key, iid, date] of [['a', intake, '2026-10-01T08:00:00Z'], ['b', intake, '2026-10-03T08:00:00Z'], ['c', otherIntake, '2020-01-01T00:00:00Z']]) {
    run("INSERT INTO mailbox_ingestion(mailbox,dedup_key,intake_id,received_at,status,content_hash) VALUES ('fixture',?,?,?,'IMPORTED','same-hash')", [key, iid, date]);
  }
  const list = async (token, query='') => {
    const res = await fetch(base + '/api/candidates?q=TABLE&' + query, { headers: { Authorization: 'Bearer ' + token } });
    assert.equal(res.status, 200); return res.json();
  };
  const all = await list(hr);
  const c = all.candidates.find(c => c.id === cid);
  check('stored education and position remain exact', () => assert.deepEqual([c.currentPosition,c.university,c.graduationYear,c.location], ['Civil Engineer','Cairo University',2014,'Cairo']));
  check('original email date uses intake candidate identity, not shared hash', () => assert.equal(c.applyDate, '2026-10-01T08:00:00Z'));
  check('documented shortlist survives rejected current stage', () => assert.equal(c.poolStatus, 'shortlisted'));
  check('unexplained numeric match is not presented as ranking', () => assert.equal(c.roleRanking, null));
  check('unverified blacklist remains unknown', () => assert.equal(all.candidates.find(c => c.id === unknown).poolStatus, 'unknown'));
  check('creation date fallback', () => assert.equal(all.candidates.find(c => c.id === unknown).applyDate, '2026-10-10T10:00:00Z'));
  check('no recorded history is new for broad viewer', () => assert.equal(all.candidates.find(c => c.id === fresh).poolStatus, 'new'));
  const scoped = (await list(hm)).candidates.find(c => c.id === cid);
  check('hidden shortlist does not leak to scoped viewer', () => assert.equal(scoped.poolStatus, 'considered'));
  check('hidden request omitted', () => assert.deepEqual(scoped.links.map(l => l.requestId), [req]));
  const filtered = await list(hr, 'departmentId=' + dep + '&pageSize=1');
  check('department filter applied before paging/count', () => { assert.equal(filtered.pagination.total, 1); assert.equal(filtered.candidates[0].id,cid); });
  check('hidden department cannot identify scoped candidate', () => assert.equal((scoped.links || []).some(l => l.departmentId === dep2), false));
  const deniedDept = await list(hm, 'departmentId=' + dep2);
  check('department filter respects application scope', () => assert.equal(deniedDept.pagination.total, 0));
  const invalid = await list(hr, 'departmentId=invalid');
  check('invalid department fails closed', () => assert.equal(invalid.pagination.total, 0));
} finally {
  console.log('Talent Pool failures:', failed);
  process.exit(failed ? 1 : 0);
}
