// Owner rules (2026-10-15): Shortlisted sits between Sourcing and Screening and
// is the ONLY release point — stakeholders (requester / hiring manager / panel)
// are never told about a link or any Sourcing work, and are told exactly once
// when a candidate is shortlisted. Recruitment can Unlink a candidate (undo a
// link) without a rejection being recorded or emailed. Disposable SQLite DB.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'arabtec-release-'));
process.env.DATABASE_URL = 'file:' + path.join(TMP, 'release.db');
process.env.UPLOAD_DIR = path.join(TMP, 'uploads');
process.env.PORT = process.env.RELEASE_TEST_PORT || '4603';
process.env.SEED_DEMO_DATA = 'true';
process.env.SMTP_TRANSPORT = 'json';
process.env.SEED_ADMIN_PASSWORD ||= 'ReleaseTest#2026x';
await import('./prisma/seed.js');
await import('./src/server.js');
const { waitForReady } = await import('./test-support/wait-ready.mjs');
const db = await import('./src/lib/db.js');
const { Candidates, Applications, StageHistory, Interviews } = await import('./src/lib/models.js');
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
const uid = (e) => db.get('SELECT id FROM users WHERE email=?', [e]).id;

try {
  db.run('UPDATE users SET must_change_password=0');
  const hm = uid('hiring.manager@arabtec.com'), iv = uid('interviewer@arabtec.com'), rec = uid('recruiter@arabtec.com');
  const rid = Number(db.run("INSERT INTO recruitment_request(ticket_no,title,status,headcount,requester_id,owner_id,created_by,hiring_manager_id) VALUES ('REL-1','Release test','sourcing',10,?,?,?,?)", [hm, rec, hm, hm]).lastInsertRowid);
  const hmNotes = () => db.get("SELECT COUNT(*) AS n FROM notification WHERE user_id=?", [hm]).n;
  const t = { rec: await login('recruiter@arabtec.com'), hm: await login('hiring.manager@arabtec.com') };
  const newCand = (name) => Candidates.create({ candidateNo: Candidates.nextNo(), fullName: name, email: name.replace(/\W/g, '').toLowerCase() + '@example.invalid', createdBy: rec });
  const link = async (cand, status) => (await api('/api/applications', { method: 'POST', token: t.rec, body: { candidateId: cand.id, requestId: rid, ...(status ? { initialStatus: status } : {}) } }));

  // Catalog row exists and is in-app by default, email off.
  const cfg = db.get("SELECT * FROM notification_config WHERE event_key='candidate.shortlisted'");
  c('shortlist notification is configured (in-app on, email off by default)', cfg && cfg.enabled == 1 && cfg.in_app == 1 && cfg.email == 0, JSON.stringify(cfg));

  // 1. Linking never notifies stakeholders.
  let n0 = hmNotes();
  const a = await link(newCand('Rel Alpha'));
  c('linking succeeds at Sourced', a.status === 201 && a.json.application.status === 'sourced', a.text);
  c('linking sends the hiring manager nothing', hmNotes() === n0);

  // 2. Order: Sourced cannot skip Shortlisted.
  const skip = await api(`/api/applications/${a.json.application.id}/move`, { method: 'POST', token: t.rec, body: { status: 'matched' } });
  c('Sourced → Screening is refused (Shortlisted cannot be skipped)', skip.status === 409, skip.text);
  c('…and still nobody is notified', hmNotes() === n0);

  // 3. Shortlisting releases once.
  const sl = await api(`/api/applications/${a.json.application.id}/move`, { method: 'POST', token: t.rec, body: { status: 'shortlisted' } });
  c('Sourced → Shortlisted allowed', sl.status === 200, sl.text);
  c('shortlisting notifies the hiring manager exactly once', hmNotes() === n0 + 1, `${n0} -> ${hmNotes()}`);
  const note = db.get("SELECT * FROM notification WHERE user_id=? ORDER BY id DESC LIMIT 1", [hm]);
  c('the notification names the candidate and the request', /Rel Alpha/.test(note.body || '') && /REL-1/.test((note.title || '') + (note.body || '')), JSON.stringify(note));
  const n1 = hmNotes();
  await api(`/api/applications/${a.json.application.id}/move`, { method: 'POST', token: t.rec, body: { status: 'matched' } });
  c('Shortlisted → Screening does not notify again', hmNotes() === n1);
  await api(`/api/applications/${a.json.application.id}/move`, { method: 'POST', token: t.rec, body: { status: 'rejected', reason: 'Test' } });
  c('a later rejection does not re-notify the stakeholders', hmNotes() === n1);

  // 4. Bulk shortlist notifies once per candidate; linking straight in as Shortlisted notifies too.
  const b1 = await link(newCand('Rel Bulk One')), b2 = await link(newCand('Rel Bulk Two'));
  const n2 = hmNotes();
  const bulk = await api('/api/applications/bulk', { method: 'POST', token: t.rec, body: { ids: [b1.json.application.id, b2.json.application.id], action: 'move', status: 'shortlisted' } });
  c('bulk shortlist moves both', bulk.status === 200 && bulk.json.affected === 2, bulk.text);
  c('bulk shortlist notifies once per candidate', hmNotes() === n2 + 2, `${n2} -> ${hmNotes()}`);
  const n3 = hmNotes();
  const direct = await link(newCand('Rel Direct'), 'shortlisted');
  c('linking directly as Shortlisted is a release and notifies', direct.status === 201 && hmNotes() === n3 + 1, direct.text);

  // 5. Unlink.
  const u = await link(newCand('Rel Unlink Private'));
  const uid1 = u.json.application.id;
  const hmTry = await api(`/api/applications/${uid1}/unlink`, { method: 'POST', token: t.hm, body: {} });
  c('a hiring manager cannot unlink', [403, 404].includes(hmTry.status), hmTry.text);
  const rejBefore = db.get("SELECT COUNT(*) AS n FROM audit_log WHERE action='application.status_changed'").n;
  const un = await api(`/api/applications/${uid1}/unlink`, { method: 'POST', token: t.rec, body: { reason: 'Linked by mistake' } });
  c('recruiter unlinks a Sourced candidate', un.status === 200 && un.json.unlinked === true, un.text);
  c('the application is gone', !Applications.byId(uid1));
  c('the candidate stays in the Talent Pool', !!db.get('SELECT id FROM candidate WHERE id=?', [u.json.application.candidateId ?? un.json.candidateId]));
  c('no rejection was recorded', db.get("SELECT COUNT(*) AS n FROM audit_log WHERE action='application.status_changed'").n === rejBefore);
  c('the unlink is audited with a snapshot', !!db.get("SELECT id FROM audit_log WHERE action='application.unlinked' AND entity_id=?", [String(uid1)]));
  const detail = await api(`/api/requests/${rid}`, { token: t.hm });
  c('the hiring manager does not see the private unlink in activity', !detail.text.includes('Rel Unlink Private'));
  c('the candidate can be linked again afterwards', (await link(Candidates.byId(un.json.candidateId))).status === 201);

  // 6. Unlink refuses once the hiring trail has started.
  const w = await link(newCand('Rel With Interview'), 'shortlisted');
  const wid = w.json.application.id;
  const ivRow = Interviews.create({ interviewNo: 'REL-IV-' + wid, applicationId: wid, candidateId: w.json.application.candidateId, requestId: rid, organizerId: rec, interviewType: 'technical', scheduledAt: '2026-11-20T10:00:00Z', createdBy: rec });
  db.run('INSERT INTO interview_panel(interview_id,interviewer_id) VALUES (?,?)', [ivRow.id, iv]);
  const blocked = await api(`/api/applications/${wid}/unlink`, { method: 'POST', token: t.rec, body: {} });
  c('unlink is refused once an interview exists (use Disqualify)', blocked.status === 409 && blocked.json.code === 'HAS_HIRING_TRAIL', blocked.text);
  c('…and nothing was removed', !!Applications.byId(wid));
} catch (e) { console.error(e); fail++; }

console.log(`\n=== RELEASE & UNLINK: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
