// CV RULE (owner direction, 15 Oct 2026): CVs are for HR.
// Full view of every CV: System Admin, CEO (view only), HR Director,
// Recruitment Manager, Recruiter. HR Manager unchanged (every request, released
// candidates). Everyone else sees a CV only when they are on that specific
// request — named hiring manager, requester/owner/creator, or the candidate's
// interview panel — AND recruitment has moved the candidate to Shortlisted or
// later. Real HTTP routes (résumé download, thread CV file, intake document),
// disposable SQLite database, synthetic data only.
import { suiteDatabaseUrl } from './test-support/suite-db.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'arabtec-cvrule-'));
process.env.DATABASE_URL = suiteDatabaseUrl('file:' + path.join(TMP, 'cvrule.db'));
process.env.UPLOAD_DIR = path.join(TMP, 'uploads');
process.env.PORT = process.env.CVRULE_TEST_PORT || '4597';
process.env.SEED_DEMO_DATA ||= 'true';
process.env.SMTP_TRANSPORT = 'json';
const { ADMIN_BOOTSTRAP_PASSWORD } = await import('./test-support/admin-session.mjs');
process.env.SEED_ADMIN_PASSWORD ||= ADMIN_BOOTSTRAP_PASSWORD;
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
  const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch {}
  return { status: r.status, json: j, text };
}
const login = async (e) => (await api('/api/auth/login', { method: 'POST', body: { email: e, password: 'Arabtec@123' } })).json.token;
const DENIED = [403, 404];

try {
  const { Candidates, Applications, StageHistory, Interviews, Posts } = await import('./src/lib/models.js');
  const uid = (email) => db.get('SELECT id FROM users WHERE email=?', [email]).id;
  const ins = (sql, params) => Number(db.run(sql, params).lastInsertRowid);
  const hm = uid('hiring.manager@arabtec.com'), iv = uid('interviewer@arabtec.com'), rec = uid('recruiter@arabtec.com');

  // Request R: the hiring manager is ONLY named on it (not requester, owner or creator).
  const R = ins("INSERT INTO recruitment_request(ticket_no,title,status,headcount,requester_id,owner_id,created_by,hiring_manager_id) VALUES ('CV-R','CV rule request','open',5,?,?,?,?)", [rec, rec, rec, hm]);
  const OTHER = ins("INSERT INTO recruitment_request(ticket_no,title,status,headcount,requester_id,owner_id,created_by) VALUES ('CV-O','Other request','open',5,?,?,?)", [rec, rec, rec]);

  const tokens = {};
  for (const [k, e] of Object.entries({ recruiter: 'recruiter@arabtec.com', director: 'hr.director@arabtec.com', recMgr: 'rec.manager@arabtec.com', hrMgr: 'hr.manager@arabtec.com', hm: 'hiring.manager@arabtec.com', interviewer: 'interviewer@arabtec.com', pm: 'pm@arabtec.com', viewer: 'viewer@arabtec.com' })) tokens[k] = await login(e);

  const withCv = async (name, requestId, released, panel = false) => {
    const cand = Candidates.create({ candidateNo: Candidates.nextNo(), fullName: 'CVR ' + name, createdBy: rec });
    const app = Applications.create({ applicationNo: Applications.nextNo(), candidateId: cand.id, requestId, status: released ? 'shortlisted' : 'sourced', createdBy: rec });
    StageHistory.add(app.id, null, 'sourced', { id: rec });
    if (released) StageHistory.add(app.id, 'sourced', 'shortlisted', { id: rec });
    const fd = new FormData(); fd.append('file', new Blob(['CV-BYTES-' + name], { type: 'application/pdf' }), name + '.pdf');
    const up = await fetch(`${B}/api/candidates/${cand.id}/resume`, { method: 'POST', headers: { Authorization: 'Bearer ' + tokens.recruiter }, body: fd });
    if (up.status !== 201) throw new Error('fixture resume upload ' + up.status);
    const stored = db.get('SELECT resume_path FROM candidate WHERE id=?', [cand.id]).resume_path;
    const post = Posts.create({ requestId, postType: 'cv', authorId: rec, authorName: 'Recruiter', authorRole: 'recruiter', body: 'CV', filePath: stored, fileName: name + '.pdf', candidateId: cand.id, applicationId: app.id });
    if (panel) {
      const i = Interviews.create({ interviewNo: 'CVR-IV-' + app.id, applicationId: app.id, candidateId: cand.id, requestId, organizerId: rec, interviewType: 'technical', scheduledAt: '2026-11-20T10:00:00Z', createdBy: rec });
      db.run('INSERT INTO interview_panel(interview_id,interviewer_id) VALUES (?,?)', [i.id, iv]);
    }
    return { cand, app, post };
  };
  const sourced = await withCv('sourced', R, false, true);       // on R, still private (panel set, still hidden)
  const shortlisted = await withCv('shortlisted', R, true, true); // on R, released
  const elsewhere = await withCv('elsewhere', OTHER, true);       // released, but on a request these people are not on

  const resume = async (who, f) => (await fetch(`${B}/api/candidates/${f.cand.id}/resume`, { headers: { Authorization: 'Bearer ' + tokens[who] } })).status;
  const threadFile = async (who, f) => (await fetch(`${B}/api/thread/post/${f.post.id}/file`, { headers: { Authorization: 'Bearer ' + tokens[who] } })).status;

  // HR with full view: every CV, sourced included.
  for (const who of ['recruiter', 'director', 'recMgr']) {
    for (const f of [sourced, shortlisted, elsewhere]) c(`${who} opens ${f.app.status} CV (${f.cand.full_name})`, (await resume(who, f)) === 200);
  }
  // HR Manager: unchanged — released candidates on every request, sourcing private.
  c('hr_manager opens shortlisted CV', (await resume('hrMgr', shortlisted)) === 200);
  c('hr_manager opens shortlisted CV on another request', (await resume('hrMgr', elsewhere)) === 200);
  c('hr_manager does not open sourced CV (unchanged)', DENIED.includes(await resume('hrMgr', sourced)));

  // Named hiring manager: on R, so the released CV only.
  c('named hiring manager opens the request', (await api('/api/requests/' + R, { token: tokens.hm })).status === 200);
  c('named hiring manager opens shortlisted CV', (await resume('hm', shortlisted)) === 200);
  c('named hiring manager opens shortlisted CV in the thread', (await threadFile('hm', shortlisted)) === 200);
  c('named hiring manager cannot open sourced CV', DENIED.includes(await resume('hm', sourced)));
  c('named hiring manager cannot open sourced CV in the thread', DENIED.includes(await threadFile('hm', sourced)));
  c('named hiring manager cannot open CV on another request', DENIED.includes(await resume('hm', elsewhere)));
  const hmThread = await api('/api/thread/request/' + R, { token: tokens.hm });
  c('named hiring manager thread lists only the released CV', hmThread.status === 200 && hmThread.text.includes('shortlisted.pdf') && !hmThread.text.includes('sourced.pdf'));

  // Interview panel: released candidate on their panel only.
  c('panel interviewer opens shortlisted CV', (await resume('interviewer', shortlisted)) === 200);
  c('panel interviewer cannot open sourced CV even on the panel', DENIED.includes(await resume('interviewer', sourced)));
  c('panel interviewer cannot open CV off their panel', DENIED.includes(await resume('interviewer', elsewhere)));

  // Outside HR and not on the request: nothing, released or not.
  for (const who of ['pm', 'viewer']) {
    for (const f of [sourced, shortlisted, elsewhere]) {
      c(`${who} cannot open ${f.cand.full_name} CV`, DENIED.includes(await resume(who, f)));
      c(`${who} cannot open ${f.cand.full_name} CV in the thread`, DENIED.includes(await threadFile(who, f)));
    }
  }
  const viewerList = await api('/api/candidates?pageSize=100', { token: tokens.viewer });
  c('viewer Talent Pool lists no CV-rule candidates', viewerList.status === 200 && !viewerList.text.includes('CVR '));
  c('viewer is refused the intake document route (HR only)', DENIED.includes((await api('/api/candidates/intakes/1/document', { token: tokens.viewer })).status));

  // Requester on a request (not named HM) still counts.
  const pmId = uid('pm@arabtec.com');
  db.run('UPDATE recruitment_request SET requester_id=? WHERE id=?', [pmId, OTHER]);
  c('requester opens shortlisted CV on their own request', (await resume('pm', elsewhere)) === 200);

  // CEO: sees every CV, but cannot change anything.
  const ceoRole = db.get("SELECT id FROM role WHERE code='ceo'").id;
  db.run('DELETE FROM user_role WHERE user_id=?', [uid('viewer@arabtec.com')]);
  db.run('INSERT INTO user_role(user_id,role_id) VALUES (?,?)', [uid('viewer@arabtec.com'), ceoRole]);
  tokens.ceo = await login('viewer@arabtec.com');
  c('CEO opens sourced CV', (await resume('ceo', sourced)) === 200);
  c('CEO opens CV on any request', (await resume('ceo', elsewhere)) === 200);
  const ceoMove = await api('/api/applications/' + sourced.app.id + '/move', { method: 'POST', token: tokens.ceo, body: { status: 'shortlisted' } });
  c('CEO cannot move a candidate (view only)', DENIED.includes(ceoMove.status), String(ceoMove.status));
  c('CEO cannot upload a CV (view only)', DENIED.includes((await fetch(`${B}/api/candidates/${sourced.cand.id}/resume`, { method: 'POST', headers: { Authorization: 'Bearer ' + tokens.ceo }, body: new FormData() })).status));

  // Release point: once recruitment shortlists, the named hiring manager gets the CV.
  const moved = await api('/api/applications/' + sourced.app.id + '/move', { method: 'POST', token: tokens.recruiter, body: { status: 'shortlisted' } });
  c('recruiter shortlists the sourced candidate', moved.status === 200, moved.text);
  c('named hiring manager opens the CV after shortlisting', (await resume('hm', sourced)) === 200);
} catch (e) { console.error(e); fail++; }
finally { console.log(`\n=== CV ACCESS RULE: ${pass} passed, ${fail} failed ===`); try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {} process.exit(fail ? 1 : 0); }
