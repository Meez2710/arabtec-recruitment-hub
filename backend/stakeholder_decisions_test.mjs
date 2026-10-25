// Recruitment team (25 Oct 2026): the hiring manager named on a request and
// the interviewers on its panels take three decisions on a Shortlisted
// candidate — Move to Interview, On Hold, Disqualify — without holding
// candidate.move_stage. The assigned hiring manager is also, at last, inside
// the request's scope (they used to see it only if they had raised it).
// Disposable SQLite DB.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'arabtec-decisions-'));
process.env.DATABASE_URL = 'file:' + path.join(TMP, 'dec.db');
process.env.UPLOAD_DIR = path.join(TMP, 'uploads');
process.env.PORT = process.env.DECISIONS_TEST_PORT || '4644';
process.env.SEED_DEMO_DATA = 'true';
process.env.SMTP_TRANSPORT = 'json';
process.env.SEED_ADMIN_PASSWORD ||= 'Decisions#2026x';
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
  const t = { rec: await login('recruiter@arabtec.com'), hm: await login('hiring.manager@arabtec.com'), ti: await login('interviewer@arabtec.com') };
  // The recruiter raised the request and NAMED the hiring manager; the HM is not its requester.
  const rid = Number(db.run("INSERT INTO recruitment_request(ticket_no,title,status,headcount,requester_id,owner_id,created_by,hiring_manager_id) VALUES ('DEC-1','Decisions test','sourcing',5,?,?,?,?)", [rec, rec, rec, hm]).lastInsertRowid);
  const other = Number(db.run("INSERT INTO recruitment_request(ticket_no,title,status,headcount,requester_id,owner_id,created_by) VALUES ('DEC-2','Someone else''s request','sourcing',5,?,?,?)", [rec, rec, rec]).lastInsertRowid);
  const mk = (name) => Candidates.create({ candidateNo: Candidates.nextNo(), fullName: name, email: name.replace(/\W/g, '').toLowerCase() + '@example.invalid', createdBy: rec });
  const link = async (cand, requestId = rid) => (await api('/api/applications', { method: 'POST', token: t.rec, body: { candidateId: cand.id, requestId } })).json.application;
  const move = (token, id, status, reason) => api(`/api/applications/${id}/move`, { method: 'POST', token, body: { status, ...(reason ? { reason } : {}) } });
  const forRequest = async (token, requestId = rid) => api(`/api/applications/request/${requestId}`, { token });

  // 1. Scope: the named hiring manager sees the request and, once released, its candidates.
  const detail = await api(`/api/requests/${rid}`, { token: t.hm });
  c('the named hiring manager can open the request', detail.status === 200, detail.text.slice(0, 200));
  const list = await api('/api/requests', { token: t.hm });
  c('…and it is in their request list', list.status === 200 && (list.json.requests || []).some((r) => r.id === rid), list.text.slice(0, 200));
  c('…but not a request they are not named on', !(list.json.requests || []).some((r) => r.id === other));
  const a1 = await link(mk('Dec Alpha')), a2 = await link(mk('Dec Beta')), a3 = await link(mk('Dec Gamma')), a4 = await link(mk('Dec Delta'));
  let seen = await forRequest(t.hm);
  c('at Sourced the hiring manager sees no candidates yet', seen.status === 404 || (seen.json.applications || []).length === 0, seen.text.slice(0, 200));
  for (const a of [a1, a2, a3, a4]) await move(t.rec, a.id, 'shortlisted');
  seen = await forRequest(t.hm);
  c('once shortlisted, the hiring manager sees them', seen.status === 200 && seen.json.applications.length === 4, seen.text.slice(0, 200));
  const d = (seen.json.applications.find((x) => x.id === a1.id) || {}).decisions;
  c('each shortlisted card carries the three decisions for the hiring manager', JSON.stringify(d) === JSON.stringify(['interviewing', 'on_hold', 'rejected']), JSON.stringify(d));
  const recView = await forRequest(t.rec);
  c('the recruiter gets no decisions (they have the whole board)', recView.json.applications.every((x) => Array.isArray(x.decisions) && x.decisions.length === 0));

  // 2. The three decisions work; nothing else does.
  const mv = await move(t.hm, a1.id, 'interviewing');
  c('hiring manager: Move to Interview', mv.status === 200 && mv.json.application.status === 'interviewing', mv.text.slice(0, 200));
  c('…after which the card carries no further decisions', JSON.stringify(mv.json.application.decisions) === '[]');
  const again = await move(t.hm, a1.id, 'issuing_offer');
  c('hiring manager cannot move an interviewing candidate any further', again.status === 403, again.text.slice(0, 200));
  const holdNoReason = await move(t.hm, a2.id, 'on_hold');
  c('On Hold needs a reason, as for everyone', holdNoReason.status === 400, holdNoReason.text.slice(0, 200));
  const hold = await move(t.hm, a2.id, 'on_hold', 'Waiting for budget');
  c('hiring manager: On Hold with a reason', hold.status === 200 && hold.json.application.status === 'on_hold', hold.text.slice(0, 200));
  const dq = await move(t.hm, a3.id, 'rejected', 'Not the right profile');
  c('hiring manager: Disqualify with a reason', dq.status === 200 && dq.json.application.status === 'rejected', dq.text.slice(0, 200));
  const skip = await move(t.hm, a4.id, 'issuing_offer');
  c('hiring manager cannot jump a shortlisted candidate to Offer', skip.status === 403, skip.text.slice(0, 200));
  const back = await move(t.hm, a4.id, 'sourced');
  c('…nor send them back to Sourced', back.status === 403 || back.status === 409, back.text.slice(0, 200));
  c('the decisions are in the stage history and the audit log',
    db.get('SELECT COUNT(*) AS n FROM application_stage_history WHERE application_id IN (?,?,?) AND actor_id=?', [a1.id, a2.id, a3.id, hm]).n === 3
    || db.get("SELECT COUNT(*) AS n FROM audit_log WHERE action='application.status_changed' AND actor_id=?", [hm]).n >= 3);

  // 3. Someone else's request: nothing.
  const foreign = await link(mk('Dec Foreign'), other);
  await move(t.rec, foreign.id, 'shortlisted');
  const nope = await move(t.hm, foreign.id, 'interviewing');
  c("the hiring manager cannot decide on another request's candidate", nope.status === 403 || nope.status === 404, nope.text.slice(0, 200));

  // 4. A panel interviewer on this request gets the same three decisions.
  const iv = Interviews.create({ interviewNo: Interviews.nextNo(), applicationId: a1.id, candidateId: a1.candidateId, requestId: rid, interviewType: 'technical', mode: 'onsite', scheduledAt: new Date(Date.now() + 86400000).toISOString(), durationMin: 60, organizerId: rec, status: 'scheduled', createdBy: rec });
  InterviewPanel.set(iv.id, [{ interviewerId: ti, isLead: true }]);
  const tiSeen = await forRequest(t.ti);
  c("an interviewer on the request's panel sees its shortlisted candidates, not only the one they interview", tiSeen.status === 200 && tiSeen.json.applications.some((x) => x.id === a4.id), tiSeen.text.slice(0, 300));
  const tiDec = (tiSeen.json.applications.find((x) => x.id === a4.id) || {}).decisions;
  c('…with the three decisions on each shortlisted card', JSON.stringify(tiDec) === JSON.stringify(['interviewing', 'on_hold', 'rejected']), JSON.stringify(tiDec));
  const tiMove = await move(t.ti, a4.id, 'interviewing');
  c('interviewer: Move to Interview', tiMove.status === 200 && tiMove.json.application.status === 'interviewing', tiMove.text.slice(0, 200));
  const tiForeign = await move(t.ti, foreign.id, 'rejected', 'x');
  c('the interviewer cannot decide on a request they have no panel on', tiForeign.status === 403 || tiForeign.status === 404, tiForeign.text.slice(0, 200));

  // 5. The recruiter is unaffected.
  const recMove = await move(t.rec, a4.id, 'issuing_offer');
  c('the recruiter still moves candidates anywhere the transition table allows', recMove.status === 200, recMove.text.slice(0, 200));
} catch (e) { c('suite ran without throwing', false, e.stack || e.message); }
console.log(`\n=== STAKEHOLDER DECISIONS: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
