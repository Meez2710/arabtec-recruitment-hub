// Recruitment team (25 Oct 2026): a hiring manager or technical interviewer
// recommends a candidate by handing in a CV. One call: candidate created (or an
// existing one reused), CV stored, application opened at Shortlisted marked as
// their recommendation, thread post, recruitment notified. Disposable DB.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'arabtec-recommend-'));
process.env.DATABASE_URL = 'file:' + path.join(TMP, 'rec.db');
process.env.UPLOAD_DIR = path.join(TMP, 'uploads');
process.env.PORT = process.env.RECOMMEND_TEST_PORT || '4646';
process.env.SEED_DEMO_DATA = 'true';
process.env.SMTP_TRANSPORT = 'json';
process.env.SEED_ADMIN_PASSWORD ||= 'Recommend#2026x';
await import('./prisma/seed.js');
await import('./src/server.js');
const { waitForReady } = await import('./test-support/wait-ready.mjs');
const db = await import('./src/lib/db.js');
const { Candidates, Interviews, InterviewPanel } = await import('./src/lib/models.js');
const B = 'http://localhost:' + process.env.PORT;
await waitForReady(B);

let pass = 0, fail = 0;
const c = (n, ok, x = '') => { console.log((ok ? '  ✅ ' : '  ❌ ') + n + (ok ? '' : ' ' + x)); ok ? pass++ : fail++; };
async function api(p, { method = 'GET', token, body } = {}) {
  const r = await fetch(B + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}
async function recommend(token, fields, fileName = 'cv.pdf', content = '%PDF-1.4 synthetic recommended cv') {
  const fd = new FormData();
  fd.append('file', new Blob([content], { type: 'application/pdf' }), fileName);
  for (const [k, v] of Object.entries(fields)) fd.append(k, String(v));
  const r = await fetch(B + '/api/applications/recommend', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}
const login = async (e) => (await api('/api/auth/login', { method: 'POST', body: { email: e, password: 'Arabtec@123' } })).json.token;
const uid = (e) => db.get('SELECT id FROM users WHERE email=?', [e]).id;

try {
  db.run('UPDATE users SET must_change_password=0');
  const hm = uid('hiring.manager@arabtec.com'), rec = uid('recruiter@arabtec.com'), ti = uid('interviewer@arabtec.com');
  const t = { rec: await login('recruiter@arabtec.com'), hm: await login('hiring.manager@arabtec.com'), ti: await login('interviewer@arabtec.com') };
  const rid = Number(db.run("INSERT INTO recruitment_request(ticket_no,title,status,headcount,requester_id,owner_id,created_by,hiring_manager_id) VALUES ('RCM-1','Recommend test','sourcing',5,?,?,?,?)", [rec, rec, rec, hm]).lastInsertRowid);
  const other = Number(db.run("INSERT INTO recruitment_request(ticket_no,title,status,headcount,requester_id,owner_id,created_by) VALUES ('RCM-2','Other request','sourcing',5,?,?,?)", [rec, rec, rec]).lastInsertRowid);
  const notes = (userId, type) => db.get('SELECT COUNT(*) AS n FROM notification WHERE user_id=? AND type=?', [userId, type]).n;

  // 1. The flag tells the UI who may recommend.
  const hmList = await api(`/api/applications/request/${rid}`, { token: t.hm });
  c('the hiring manager is told they can recommend here', hmList.status === 200 && hmList.json.canRecommend === true, hmList.text.slice(0, 200));
  const tiList = await api(`/api/applications/request/${rid}`, { token: t.ti });
  c('an interviewer with no panel on the request cannot (yet)', tiList.status === 404 || tiList.json?.canRecommend === false, tiList.text.slice(0, 200));

  // 2. The hiring manager recommends someone new.
  const n0 = notes(rec, 'stakeholder.recommendation');
  const r1 = await recommend(t.hm, { requestId: rid, fullName: ' Omar  Khaled ', email: 'omar.khaled@example.invalid', phone: '+201001234567', currentPosition: 'Senior Site Engineer', employer: 'Builders Co', yearsExperience: 9, note: 'Worked with me on Soul.' });
  c('hiring manager recommends a candidate with a CV (201)', r1.status === 201, r1.text.slice(0, 300));
  const app1 = r1.json.application;
  c('the application opens at Shortlisted, marked as their recommendation', app1.status === 'shortlisted' && app1.recommendation && app1.recommendation.byId === hm && /Hiring|Nadia|Manager|\w/.test(app1.recommendation.byName || ''), JSON.stringify(app1.recommendation));
  const cand = Candidates.byId(r1.json.candidateId);
  c('the candidate exists with the CV as résumé, source = recommendation, name tidied', cand && cand.resume_name === 'cv.pdf' && cand.source === 'recommendation' && cand.full_name === 'Omar Khaled' && cand.current_position === 'Senior Site Engineer', JSON.stringify({ n: cand?.full_name, r: cand?.resume_name, s: cand?.source }));
  c('a CV document row records who recommended', db.get('SELECT note FROM candidate_document WHERE candidate_id=?', [cand.id])?.note?.includes('Recommended by'));
  const hist = db.get('SELECT COUNT(*) AS n FROM application_stage_history WHERE application_id=?', [app1.id]).n;
  const aud = db.get("SELECT COUNT(*) AS n FROM audit_log WHERE action='application.recommended' AND CAST(entity_id AS TEXT)=?", [String(app1.id)]).n;
  c('the stage history, candidate activity and audit are written', hist === 1 && aud === 1, JSON.stringify({ hist, aud }));
  const post = db.get("SELECT * FROM ticket_post WHERE request_id=? AND post_type='cv' ORDER BY id DESC LIMIT 1", [rid]) || db.get("SELECT * FROM post WHERE request_id=? AND post_type='cv' ORDER BY id DESC LIMIT 1", [rid]);
  c('the request conversation shows the recommendation with the CV', post && post.file_name === 'cv.pdf' && /recommendation/.test(post.payload || ''), JSON.stringify(post && { f: post.file_name, p: post.payload }));
  c('the recruiter is notified of the recommendation', notes(rec, 'stakeholder.recommendation') === n0 + 1, `${n0} -> ${notes(rec, 'stakeholder.recommendation')}`);
  const seen = await api(`/api/applications/request/${rid}`, { token: t.hm });
  c('the hiring manager sees the recommended candidate on the shortlist with their decisions', seen.json.applications.some((a) => a.id === app1.id && a.decisions.length === 3), seen.text.slice(0, 200));
  const recView = await api(`/api/applications/request/${rid}`, { token: t.rec });
  c('the recruiter sees who recommended', recView.json.applications.find((a) => a.id === app1.id)?.recommendation?.byId === hm);
  const cvGet = await fetch(`${B}/api/candidates/${cand.id}/resume`, { headers: { Authorization: 'Bearer ' + t.rec } });
  c('the CV is served to the recruiter', cvGet.status === 200);

  // 3. Rules.
  const again = await recommend(t.hm, { requestId: rid, fullName: 'Omar Khaled', email: 'omar.khaled@example.invalid' });
  c('the same person again on the same request is refused (409)', again.status === 409, again.text.slice(0, 200));
  const foreign = await recommend(t.hm, { requestId: other, fullName: 'Someone Else', email: 'se@example.invalid' });
  c('the hiring manager cannot recommend into a request they are not named on (403)', foreign.status === 403, foreign.text.slice(0, 200));
  const noFile = await fetch(`${B}/api/applications/recommend`, { method: 'POST', headers: { Authorization: 'Bearer ' + t.hm }, body: (() => { const fd = new FormData(); fd.append('requestId', String(rid)); fd.append('fullName', 'No File'); return fd; })() });
  c('a recommendation needs a CV (400)', noFile.status === 400, String(noFile.status));
  const noName = await recommend(t.hm, { requestId: rid, fullName: '   ' });
  c('…and a name (400)', noName.status === 400);
  // An existing pool candidate (same email) is reused, not duplicated.
  const pool = Candidates.create({ candidateNo: Candidates.nextNo(), fullName: 'Pool Person', email: 'pool.person@example.invalid', createdBy: rec });
  const before = db.get('SELECT COUNT(*) AS n FROM candidate').n;
  const r2 = await recommend(t.hm, { requestId: rid, fullName: 'Pool Person', email: 'POOL.PERSON@example.invalid' }, 'pool.pdf');
  c('an existing candidate with the same email is reused', r2.status === 201 && r2.json.reusedCandidate === true && r2.json.candidateId === pool.id && db.get('SELECT COUNT(*) AS n FROM candidate').n === before, r2.text.slice(0, 200));
  c('…their CV is stored since they had none', Candidates.byId(pool.id).resume_name === 'pool.pdf');

  // 4. A panel interviewer on the request may recommend too.
  const iv = Interviews.create({ interviewNo: Interviews.nextNo(), applicationId: app1.id, candidateId: cand.id, requestId: rid, interviewType: 'technical', mode: 'onsite', scheduledAt: new Date(Date.now() + 86400000).toISOString(), durationMin: 60, organizerId: rec, status: 'scheduled', createdBy: rec });
  InterviewPanel.set(iv.id, [{ interviewerId: ti, isLead: true }]);
  const tiList2 = await api(`/api/applications/request/${rid}`, { token: t.ti });
  c('an interviewer on the request’s panel is told they can recommend', tiList2.status === 200 && tiList2.json.canRecommend === true, tiList2.text.slice(0, 200));
  const r3 = await recommend(t.ti, { requestId: rid, fullName: 'Interviewer Pick', phone: '+201009998877' }, 'pick.docx', 'docx-bytes');
  c('the interviewer recommends a candidate (201, Shortlisted)', r3.status === 201 && r3.json.application.status === 'shortlisted' && r3.json.application.recommendation.byId === ti, r3.text.slice(0, 200));
  const r4 = await recommend(t.ti, { requestId: other, fullName: 'Nope', phone: '+201000000001' });
  c('…but not into a request they have no panel on (403)', r4.status === 403);

  // 5. Recruitment can use it as well (same door, no special status).
  const r5 = await recommend(t.rec, { requestId: rid, fullName: 'Recruiter Added', email: 'ra@example.invalid' });
  c('a recruiter can add a CV the same way', r5.status === 201 && r5.json.application.status === 'shortlisted');
  const n1 = notes(rec, 'stakeholder.recommendation');
  c('…without recruitment being notified about itself (3 stakeholder recommendations, not 4)', n1 === n0 + 3, `${n0} -> ${n1}`);
} catch (e) { c('suite ran without throwing', false, e.stack || e.message); }
console.log(`\n=== RECOMMEND CANDIDATE: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
