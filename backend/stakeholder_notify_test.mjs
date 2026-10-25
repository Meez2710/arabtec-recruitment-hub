// Recruitment team (25 Oct 2026): recruitment is told about everything a
// hiring manager or interviewer does — a decision on a shortlisted candidate,
// a message/reply/file/CV in the request conversation, interview feedback, an
// assessment or final decision. Actions by recruitment users are not announced
// to recruitment. All three events are catalogued and tunable. Disposable DB.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'arabtec-stk-notify-'));
process.env.DATABASE_URL = 'file:' + path.join(TMP, 'n.db');
process.env.UPLOAD_DIR = path.join(TMP, 'uploads');
process.env.PORT = process.env.STK_NOTIFY_TEST_PORT || '4645';
process.env.SEED_DEMO_DATA = 'true';
process.env.SMTP_TRANSPORT = 'json';
process.env.SEED_ADMIN_PASSWORD ||= 'StkNotify#2026x';
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
const login = async (e) => (await api('/api/auth/login', { method: 'POST', body: { email: e, password: 'Arabtec@123' } })).json.token;
const uid = (e) => db.get('SELECT id FROM users WHERE email=?', [e]).id;

try {
  db.run('UPDATE users SET must_change_password=0');
  const hm = uid('hiring.manager@arabtec.com'), rec = uid('recruiter@arabtec.com'), ti = uid('interviewer@arabtec.com');
  // A second recruitment-team member who is NOT the request's recruiter.
  const rm = db.get("SELECT u.id FROM users u JOIN user_role ur ON ur.user_id=u.id JOIN role r ON r.id=ur.role_id WHERE r.code='recruitment_manager' AND u.status='active' LIMIT 1")?.id;
  const t = { rec: await login('recruiter@arabtec.com'), hm: await login('hiring.manager@arabtec.com'), ti: await login('interviewer@arabtec.com') };
  const rid = Number(db.run("INSERT INTO recruitment_request(ticket_no,title,status,headcount,requester_id,owner_id,created_by,hiring_manager_id) VALUES ('NTF-1','Notify test','sourcing',5,?,?,?,?)", [rec, rec, rec, hm]).lastInsertRowid);
  const notes = (userId, type) => db.get('SELECT COUNT(*) AS n FROM notification WHERE user_id=?' + (type ? ' AND type=?' : ''), type ? [userId, type] : [userId]).n;
  const last = (userId) => db.get('SELECT * FROM notification WHERE user_id=? ORDER BY id DESC LIMIT 1', [userId]);

  for (const k of ['stakeholder.decision', 'stakeholder.reply', 'stakeholder.feedback']) {
    const row = db.get('SELECT * FROM notification_config WHERE event_key=?', [k]);
    c(`${k} is catalogued, on, in-app, to owner + recruitment team`, row && row.enabled == 1 && row.in_app == 1 && JSON.stringify(JSON.parse(row.recipients)) === JSON.stringify(['owner', 'recruitment_team']), JSON.stringify(row));
  }
  const cand = Candidates.create({ candidateNo: Candidates.nextNo(), fullName: 'Notify Candidate', email: 'notify.cand@example.invalid', createdBy: rec });
  const app = (await api('/api/applications', { method: 'POST', token: t.rec, body: { candidateId: cand.id, requestId: rid } })).json.application;
  await api(`/api/applications/${app.id}/move`, { method: 'POST', token: t.rec, body: { status: 'shortlisted' } });

  // 1. A decision by the hiring manager reaches the recruiter and the team.
  let r0 = notes(rec, 'stakeholder.decision'), m0 = rm ? notes(rm, 'stakeholder.decision') : 0, h0 = notes(hm);
  const mv = await api(`/api/applications/${app.id}/move`, { method: 'POST', token: t.hm, body: { status: 'interviewing' } });
  c('hiring manager moves the shortlisted candidate to Interview', mv.status === 200, mv.text.slice(0, 200));
  c('the request’s recruiter is notified of the decision', notes(rec, 'stakeholder.decision') === r0 + 1, `${r0} -> ${notes(rec, 'stakeholder.decision')}`);
  c('the recruitment manager (recruitment team, not on the request) is notified too', !rm || notes(rm, 'stakeholder.decision') === m0 + 1);
  const n1 = last(rec);
  c('the alert names who did what, the candidate and the request', /Hiring manager/.test(n1.title) && /Notify Candidate/.test(n1.title + n1.body) && /NTF-1/.test(n1.title + n1.body) && /Interview/.test(n1.title), JSON.stringify(n1));
  c('the alert links to the request', n1.link_type === 'request' && Number(n1.link_id) === rid, JSON.stringify([n1.link_type, n1.link_id]));
  c('the hiring manager is not told about their own action', notes(hm) === h0);

  // 2. Recruiter actions are not announced to recruitment.
  r0 = notes(rec); m0 = rm ? notes(rm) : 0;
  await api(`/api/thread/request/${rid}`, { method: 'POST', token: t.rec, body: { body: 'Recruiter note' } });
  await api(`/api/applications/${app.id}/move`, { method: 'POST', token: t.rec, body: { status: 'shortlisted' } });
  c('a recruiter writing or moving does not notify the recruitment team', notes(rec) === r0 && (!rm || notes(rm) === m0), `${r0} -> ${notes(rec)}`);

  // 3. Conversation: message, reply, file by the hiring manager.
  r0 = notes(rec, 'stakeholder.reply');
  const post = await api(`/api/thread/request/${rid}`, { method: 'POST', token: t.hm, body: { body: 'Can we see more senior profiles?' } });
  c('hiring manager posts in the conversation', post.status === 201, post.text.slice(0, 200));
  c('…and the recruiter is notified, with the message excerpt', notes(rec, 'stakeholder.reply') === r0 + 1 && /more senior profiles/.test(last(rec).body), JSON.stringify(last(rec)));
  const reply = await api(`/api/thread/request/${rid}`, { method: 'POST', token: t.hm, body: { body: 'Thanks', parentPostId: post.json.post.id } });
  c('a reply notifies as a reply', reply.status === 201 && notes(rec, 'stakeholder.reply') === r0 + 2 && /replied/.test(last(rec).title), JSON.stringify(last(rec).title));

  // 4. Feedback: interview feedback by the panel interviewer, assessment, final decision.
  const iv = Interviews.create({ interviewNo: Interviews.nextNo(), applicationId: app.id, candidateId: cand.id, requestId: rid, interviewType: 'technical', mode: 'onsite', scheduledAt: new Date(Date.now() - 3 * 86400000).toISOString(), durationMin: 60, organizerId: rec, status: 'completed', createdBy: rec });
  InterviewPanel.set(iv.id, [{ interviewerId: ti, isLead: true }]);
  db.run("UPDATE interview SET status='completed' WHERE id=?", [iv.id]);
  const f0 = notes(rec, 'stakeholder.feedback');
  const fb = await api(`/api/interviews/${iv.id}/feedback`, { method: 'POST', token: t.ti, body: { recommendation: 'yes', overallScore: 4, comments: 'Solid' } });
  c('interviewer submits interview feedback', fb.status === 201, fb.text.slice(0, 300));
  c('…and the recruiter is notified, with the recommendation', notes(rec, 'stakeholder.feedback') === f0 + 1 && /Interviewer/.test(last(rec).title) && /yes/i.test(last(rec).body), JSON.stringify(last(rec)));
  const fbPost = await api(`/api/thread/request/${rid}/feedback`, { method: 'POST', token: t.hm, body: { applicationId: app.id, candidateId: cand.id, recommendation: 'hire', body: 'Strong fit' } });
  c('hiring manager posts structured feedback in the thread', fbPost.status === 201, fbPost.text.slice(0, 200));
  c('…and the recruiter is notified as feedback', notes(rec, 'stakeholder.feedback') === f0 + 2, `${f0} -> ${notes(rec, 'stakeholder.feedback')}`);

  // 5. Switching the event off in the console silences it.
  db.run("UPDATE notification_config SET enabled=0 WHERE event_key='stakeholder.reply'");
  const q0 = notes(rec, 'stakeholder.reply');
  await api(`/api/thread/request/${rid}`, { method: 'POST', token: t.hm, body: { body: 'silent?' } });
  c('a disabled event sends nothing', notes(rec, 'stakeholder.reply') === q0);
  // Recipients are tunable: owner only.
  db.run("UPDATE notification_config SET enabled=1, recipients=? WHERE event_key='stakeholder.reply'", [JSON.stringify(['owner'])]);
  const m1 = rm ? notes(rm, 'stakeholder.reply') : 0;
  await api(`/api/thread/request/${rid}`, { method: 'POST', token: t.hm, body: { body: 'owner only' } });
  c('recipients follow the console setting (owner only → the team is not told)', notes(rec, 'stakeholder.reply') === q0 + 1 && (!rm || notes(rm, 'stakeholder.reply') === m1));
} catch (e) { c('suite ran without throwing', false, e.stack || e.message); }
console.log(`\n=== STAKEHOLDER NOTIFICATIONS: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
