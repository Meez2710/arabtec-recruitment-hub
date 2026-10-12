// Packet I — interview booking integrity and CV (INTERVIEW_IMPLEMENTATION_BRIEF.md).
//   • separate simultaneous appointments for different candidates and panels
//   • candidate overlap blocked; shared panelist needs an acknowledged reason;
//     back-to-back is fine; cancelled interviews free their slot
//   • the same rules on reschedule (excluding the interview itself)
//   • request guards: awaiting approval (Q-05), on hold, closed — on create,
//     reschedule and reopen; cancellation always possible
//   • idempotent create; no automatic invitations on save
//   • CV stored without AI parsing, shown on the interview, panel-scoped
// Synthetic data, SMTP_TRANSPORT=json.
import { suiteDatabaseUrl } from './test-support/suite-db.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'arabtec-ivbook-'));
process.env.DATABASE_URL = suiteDatabaseUrl('file:' + path.join(TMP, 'ivbook.db'));
process.env.UPLOAD_DIR = path.join(TMP, 'uploads');
process.env.PORT = process.env.IV_BOOKING_TEST_PORT || '4382';
process.env.SEED_DEMO_DATA ||= 'true';
process.env.SMTP_TRANSPORT = 'json';
const { adminToken, ADMIN_BOOTSTRAP_PASSWORD } = await import('./test-support/admin-session.mjs');
process.env.SEED_ADMIN_PASSWORD ||= ADMIN_BOOTSTRAP_PASSWORD;
await import('./prisma/seed.js');
await import('./src/server.js');
const { waitForReady } = await import('./test-support/wait-ready.mjs');
const B = 'http://localhost:' + process.env.PORT;
await waitForReady(B);
const db = await import('./src/lib/db.js');

let pass = 0, fail = 0;
const c = (n, ok, x = '') => { console.log((ok ? '  ✅ ' : '  ❌ ') + n + (ok ? '' : ' ' + x)); ok ? pass++ : fail++; };
async function api(p, { method = 'GET', token, body } = {}) {
  const r = await fetch(B + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch {}
  return { status: r.status, json: j, text };
}
const must = async (p, o) => { const r = await api(p, o); if (r.status >= 400) throw new Error(`${o?.method || 'GET'} ${p} → ${r.status} ${r.text.slice(0, 200)}`); return r.json; };
const login = async (e) => (await api('/api/auth/login', { method: 'POST', body: { email: e, password: 'Arabtec@123' } })).json.token;
// A future slot: day N at HH:MM UTC.
const at = (dayOffset, hh, mm = 0) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + dayOffset); d.setUTCHours(hh, mm, 0, 0); return d.toISOString(); };

try {
  const hrMgr = await login('hr.manager@arabtec.com');
  const hrDir = await login('hr.director@arabtec.com');
  const recMgr = await login('rec.manager@arabtec.com');
  const recruiter = await login('recruiter@arabtec.com');
  const interviewer = await login('interviewer@arabtec.com'); // Mona Sami
  const hm = await login('hiring.manager@arabtec.com');
  const meta = await must('/api/requests/meta/form', { token: hrMgr });
  const karim = meta.recruiters.find((r) => r.name === 'Karim Adel');
  const people = (await must('/api/interviews/meta/form', { token: recruiter })).interviewers;
  const mona = people.find((u) => u.name === 'Mona Sami');
  const others = people.filter((u) => u.id !== mona.id);
  const [p2, p3] = [others[0], others[1]];
  let n = 0;
  async function request({ approve = true } = {}) {
    n += 1;
    const id = (await must('/api/requests', { method: 'POST', token: hrMgr, body: { title: 'Booking Audit ' + n, justification: 'new_hire', projectId: meta.projects[0].id, departmentId: meta.departments[0].id, location: 'Cairo', headcount: 3, priority: 'high' } })).request.id;
    await api(`/api/requests/${id}/submit`, { method: 'POST', token: hrMgr });
    if (approve) {
      await must(`/api/requests/${id}/approve`, { method: 'POST', token: hrDir, body: {} });
      await must(`/api/requests/${id}/assign`, { method: 'POST', token: recMgr, body: { ownerId: karim.id } });
    }
    return id;
  }
  async function candidate(tag) { return (await must('/api/candidates', { method: 'POST', token: recruiter, body: { fullName: 'Synthetic Booking ' + tag, email: `booking-${tag}@example.invalid` } })).candidate.id; }
  async function app(rid, cid) { return (await must('/api/applications', { method: 'POST', token: recruiter, body: { candidateId: cid, requestId: rid, initialStatus: 'matched' } })).application.id; }
  const book = (body, token = recruiter) => api('/api/interviews', { method: 'POST', token, body: { durationMin: 60, interviewType: 'technical', mode: 'onsite', locationOrLink: 'Head Office', ...body } });

  const rid = await request();
  const cA = await candidate('a'); const cB = await candidate('b');
  const aA = await app(rid, cA); const aB = await app(rid, cB);

  console.log('\n— separate simultaneous appointments —');
  const ivA = await book({ applicationId: aA, scheduledAt: at(3, 9), panel: [{ interviewerId: mona.id, isLead: true }] });
  const ivB = await book({ applicationId: aB, scheduledAt: at(3, 9), panel: [{ interviewerId: p2.id, isLead: true }], locationOrLink: 'Site office' });
  c('two candidates, distinct panels, same start → both booked (201, 201)', ivA.status === 201 && ivB.status === 201, `${ivA.status} ${ivB.status} ${ivB.text.slice(0, 160)}`);
  c('…as two separate interview records', ivA.json?.interview?.id && ivB.json?.interview?.id && ivA.json.interview.id !== ivB.json.interview.id);

  console.log('\n— conflicts —');
  const sameCand = await book({ applicationId: aA, scheduledAt: at(3, 9, 30), panel: [{ interviewerId: p3.id, isLead: true }] });
  c('the same candidate in an overlapping interview is blocked (409 candidate_conflict)', sameCand.status === 409 && sameCand.json?.code === 'candidate_conflict', sameCand.text.slice(0, 160));
  const cC = await candidate('c'); const aC = await app(rid, cC);
  const shared = await book({ applicationId: aC, scheduledAt: at(3, 9, 30), panel: [{ interviewerId: mona.id, isLead: true }] });
  c('a shared panelist without acknowledgement is held (409 panel_conflict) with who and when', shared.status === 409 && shared.json?.code === 'panel_conflict' && (shared.json?.clashes || []).some((x) => x.interviewerId === mona.id), shared.text.slice(0, 160));
  c('…acknowledging without a reason is refused (400)', (await book({ applicationId: aC, scheduledAt: at(3, 9, 30), panel: [{ interviewerId: mona.id, isLead: true }], ackPanelOverlap: true })).status === 400);
  const ack = await book({ applicationId: aC, scheduledAt: at(3, 9, 30), panel: [{ interviewerId: mona.id, isLead: true }], ackPanelOverlap: true, overlapReason: 'Mona joins for the first 15 minutes only' });
  c('…acknowledged with a reason it is booked (201) and the reason recorded', ack.status === 201 && ack.json?.interview?.overlapReason === 'Mona joins for the first 15 minutes only', ack.text.slice(0, 160));
  const cD = await candidate('d'); const aD = await app(rid, cD);
  const b2b = await book({ applicationId: aD, scheduledAt: at(3, 10), panel: [{ interviewerId: p2.id, isLead: true }] });
  c('back-to-back with the same panelist needs no acknowledgement (201)', b2b.status === 201, b2b.text.slice(0, 160));
  const sameRoom = await api(`/api/interviews/clashes?start=${encodeURIComponent(at(3, 9))}&durationMin=60&panel=${p3.id}&location=${encodeURIComponent('head office')}`, { token: recruiter });
  c('an identical location at the same time is reported as a warning', sameRoom.status === 200 && (sameRoom.json?.locationWarnings || []).length >= 1, sameRoom.text.slice(0, 160));
  const candCheck = await api(`/api/interviews/clashes?start=${encodeURIComponent(at(3, 9))}&durationMin=60&panel=${p3.id}&candidateId=${cA}`, { token: recruiter });
  c('the availability check reports the candidate conflict before saving', (candCheck.json?.candidateConflicts || []).length === 1, candCheck.text.slice(0, 160));

  console.log('\n— cancelled frees the slot; reschedule follows the same rules —');
  await must(`/api/interviews/${ivB.json.interview.id}/status`, { method: 'POST', token: recruiter, body: { status: 'cancelled', reason: 'Audit' } });
  c('after cancelling, the candidate can be booked in that slot (201)', (await book({ applicationId: aB, scheduledAt: at(3, 9), panel: [{ interviewerId: p3.id, isLead: true }] })).status === 201);
  // Move the 10:00 interview to 09:15 and add Mona, who is busy then.
  const moveIntoA = await api(`/api/interviews/${b2b.json.interview.id}`, { method: 'PUT', token: recruiter, body: { scheduledAt: at(3, 9, 15), panel: [{ interviewerId: mona.id, isLead: true }] } });
  c('a reschedule into a shared-panel overlap is held without acknowledgement (409)', moveIntoA.status === 409 && moveIntoA.json?.code === 'panel_conflict', moveIntoA.text.slice(0, 160));
  c('…the interview is unchanged', (await must(`/api/interviews/${b2b.json.interview.id}`, { token: recruiter })).interview.scheduledAt === at(3, 10));
  const selfMove = await api(`/api/interviews/${ivA.json.interview.id}`, { method: 'PUT', token: recruiter, body: { scheduledAt: at(3, 9, 15), ackPanelOverlap: true, overlapReason: 'Shift by 15 minutes' } });
  c('moving an interview over its own old slot does not clash with itself (200)', selfMove.status === 200, selfMove.text.slice(0, 160));

  console.log('\n— request guards (Q-05, on hold, closed) —');
  const pendingRid = await request({ approve: false });
  const cP = await candidate('p');
  const aP = await api('/api/applications', { method: 'POST', token: recruiter, body: { candidateId: cP, requestId: pendingRid, initialStatus: 'matched' } });
  c('matching a candidate to a request awaiting approval is allowed (201)', aP.status === 201, aP.text.slice(0, 160));
  const ivP = await book({ applicationId: aP.json?.application?.id, scheduledAt: at(4, 9), panel: [{ interviewerId: mona.id, isLead: true }] });
  c('…but scheduling its interview is refused until approval (409, says awaiting approval)', ivP.status === 409 && /awaiting approval/i.test(ivP.json?.error || ''), ivP.text.slice(0, 160));
  c('…standalone with that request is refused too (409)', (await book({ candidateId: cP, requestId: pendingRid, scheduledAt: at(4, 9), panel: [{ interviewerId: mona.id, isLead: true }] })).status === 409);
  const ridHold = await request(); const cH = await candidate('h'); const aH = await app(ridHold, cH);
  const ivH = (await book({ applicationId: aH, scheduledAt: at(5, 9), panel: [{ interviewerId: mona.id, isLead: true }] })).json.interview;
  await must(`/api/requests/${ridHold}/hold`, { method: 'POST', token: recMgr, body: { reason: 'Audit' } });
  const reH = await api(`/api/interviews/${ivH.id}`, { method: 'PUT', token: recruiter, body: { scheduledAt: at(5, 11) } });
  c('rescheduling while the request is on hold is refused (409)', reH.status === 409 && /On Hold/.test(reH.json?.error || ''), reH.text.slice(0, 160));
  c('…cancelling it is still possible (200)', (await api(`/api/interviews/${ivH.id}/status`, { method: 'POST', token: recruiter, body: { status: 'cancelled', reason: 'Request paused' } })).status === 200);

  console.log('\n— idempotent create; no automatic invitations —');
  const cI = await candidate('i'); const aI = await app(rid, cI);
  const key = 'ivbook-' + Date.now();
  const first = await book({ applicationId: aI, scheduledAt: at(6, 9), panel: [{ interviewerId: p3.id, isLead: true }], idempotencyKey: key });
  const again = await book({ applicationId: aI, scheduledAt: at(6, 9), panel: [{ interviewerId: p3.id, isLead: true }], idempotencyKey: key });
  c('the same submission twice creates one interview', first.status === 201 && again.status < 300 && again.json?.interview?.id === first.json?.interview?.id && again.json?.replayed === true, `${first.status} ${again.status} ${again.text.slice(0, 120)}`);
  c('…exactly one row in the database', Number(db.get('SELECT COUNT(*) AS n FROM interview WHERE application_id=?', [aI]).n) === 1);
  const acts = db.all('SELECT type FROM candidate_activity WHERE candidate_id=?', [cI]).map((r) => r.type);
  c('saving an interview sends no invitation by itself', !acts.some((t) => /^email_/.test(t)) && first.json?.delivery?.state === 'not_requested', JSON.stringify({ acts, delivery: first.json?.delivery }));

  console.log('\n— CV: stored without parsing, on the interview, panel-scoped —');
  const fd = new FormData();
  fd.append('file', new Blob(['Synthetic CV for booking audit'], { type: 'text/plain' }), 'synthetic-cv.txt');
  const up = await fetch(`${B}/api/candidates/${cI}/resume?parse=0`, { method: 'POST', headers: { Authorization: 'Bearer ' + recruiter }, body: fd });
  const upJ = await up.json();
  c('CV upload without AI parsing stores the file (201) and proposes nothing', up.status === 201 && upJ.candidate?.resumeName === 'synthetic-cv.txt' && !upJ.proposal, JSON.stringify(upJ).slice(0, 200));
  const detail = (await must(`/api/interviews/${first.json.interview.id}`, { token: recruiter })).interview;
  c('the interview shows the stored CV', detail.cv?.available === true && detail.cv?.fileName === 'synthetic-cv.txt', JSON.stringify(detail.cv));
  const p3Token = null; // p3 is a staff user without a known password; Mona covers the panel case below.
  const ivM = (await book({ applicationId: aD, scheduledAt: at(7, 9), panel: [{ interviewerId: mona.id, isLead: true }] })).json.interview;
  await fetch(`${B}/api/candidates/${cD}/resume?parse=0`, { method: 'POST', headers: { Authorization: 'Bearer ' + recruiter }, body: (() => { const f = new FormData(); f.append('file', new Blob(['CV D'], { type: 'text/plain' }), 'cv-d.txt'); return f; })() });
  const panelCv = await fetch(`${B}/api/candidates/${cD}/resume`, { headers: { Authorization: 'Bearer ' + interviewer } });
  c('the assigned panelist can open the CV (200)', panelCv.status === 200 && ivM.id > 0);
  const notPanelCv = await fetch(`${B}/api/candidates/${cI}/resume`, { headers: { Authorization: 'Bearer ' + interviewer } });
  c('an interviewer not on that candidate\'s panel cannot (403)', notPanelCv.status === 403, String(notPanelCv.status));
  const hmCv = await fetch(`${B}/api/candidates/${cI}/resume`, { headers: { Authorization: 'Bearer ' + hm } });
  c('an unrelated hiring manager cannot (403)', hmCv.status === 403, String(hmCv.status));
  void p3Token;

  // Audit A4/A5/A8 (2026-10-12): attendance and feedback describe an interview
  // that has happened; a No-Show is the attendance record.
  console.log('\n— lifecycle: nothing is recorded before the interview starts —');
  const { backdateInterview } = await import('./test-support/backdate.mjs');
  const cL = await candidate('life'); const aL = await app(rid, cL);
  const ivL = (await book({ applicationId: aL, scheduledAt: at(9, 9), panel: [{ interviewerId: mona.id, isLead: true }] })).json.interview;
  const status = (id, body) => api(`/api/interviews/${id}/status`, { method: 'POST', token: recruiter, body });
  const early = await status(ivL.id, { status: 'completed' });
  c('Completed before the start is refused (409 interview_not_started)', early.status === 409 && early.json?.code === 'interview_not_started', `${early.status} ${early.text.slice(0, 160)}`);
  const earlyNs = await status(ivL.id, { status: 'no_show', reason: 'x' });
  c('No-Show before the start is refused (409)', earlyNs.status === 409 && earlyNs.json?.code === 'interview_not_started', `${earlyNs.status}`);
  const earlyFb = await api(`/api/interviews/${ivL.id}/feedback`, { method: 'POST', token: interviewer, body: { recommendation: 'yes', comments: 'too early' } });
  c('feedback before the start is refused (409)', earlyFb.status === 409 && earlyFb.json?.code === 'interview_not_started', `${earlyFb.status} ${earlyFb.text.slice(0, 160)}`);
  const lDetail = (await must(`/api/interviews/${ivL.id}`, { token: recruiter })).interview;
  c('the interview says from when each action opens', ['completed', 'no_show', 'feedback'].every((k) => typeof lDetail.actionsOpenAt?.[k] === 'string' && !Number.isNaN(Date.parse(lDetail.actionsOpenAt[k]))), JSON.stringify(lDetail.actionsOpenAt));
  backdateInterview(db, ivL.id, -90);
  c('Completed after it started is accepted', (await status(ivL.id, { status: 'completed' })).status === 200);
  c('feedback after it was completed is accepted (201)', (await api(`/api/interviews/${ivL.id}/feedback`, { method: 'POST', token: interviewer, body: { recommendation: 'yes', comments: 'held' } })).status === 201);

  const cN = await candidate('noshow'); const aN = await app(rid, cN);
  const ivN = (await book({ applicationId: aN, scheduledAt: at(9, 12), panel: [{ interviewerId: mona.id, isLead: true }] })).json.interview;
  backdateInterview(db, ivN.id, -90);
  c('No-Show after it started is accepted', (await status(ivN.id, { status: 'no_show', reason: 'Candidate did not attend' })).status === 200);
  const nsFb = await api(`/api/interviews/${ivN.id}/feedback`, { method: 'POST', token: interviewer, body: { recommendation: 'no', comments: 'absent' } });
  c('feedback on a No-Show is refused (409)', nsFb.status === 409, `${nsFb.status}`);
  const nsCancel = await status(ivN.id, { status: 'cancelled', reason: 'tidy up' });
  c('cancelling a No-Show is refused — it is the attendance record (409)', nsCancel.status === 409, `${nsCancel.status} ${nsCancel.text.slice(0, 120)}`);
  c('…reopen, then cancel, is allowed', (await status(ivN.id, { status: 'scheduled' })).status === 200 && (await status(ivN.id, { status: 'cancelled', reason: 'Withdrawn' })).status === 200);

  console.log('\n— lifecycle: owner windows (feedback at start, No-Show +15 min, Completed at the end) —');
  const cW = await candidate('window'); const aW = await app(rid, cW);
  const ivW = (await book({ applicationId: aW, scheduledAt: at(9, 15), durationMin: 60, panel: [{ interviewerId: mona.id, isLead: true }] })).json.interview;
  backdateInterview(db, ivW.id, -10); // started 10 minutes ago, ends in 50
  c('10 min in: No-Show is still refused (opens at +15)', (await status(ivW.id, { status: 'no_show', reason: 'late' })).json?.code === 'interview_not_started');
  c('10 min in: Completed is refused (opens at the end)', (await status(ivW.id, { status: 'completed' })).json?.code === 'interview_not_started');
  c('10 min in: feedback is accepted (opens at the start)', (await api(`/api/interviews/${ivW.id}/feedback`, { method: 'POST', token: interviewer, body: { recommendation: 'yes', comments: 'in progress' } })).status === 201);
  backdateInterview(db, ivW.id, -20);
  c('20 min in: No-Show is accepted', (await status(ivW.id, { status: 'no_show', reason: 'Candidate did not attend' })).status === 200);
  c('…reopened', (await status(ivW.id, { status: 'scheduled' })).status === 200);
  backdateInterview(db, ivW.id, -61);
  c('after the scheduled end: Completed is accepted', (await status(ivW.id, { status: 'completed' })).status === 200);

  const cX = await candidate('badtime'); const aX = await app(rid, cX);
  const ivX = (await book({ applicationId: aX, scheduledAt: at(9, 18), panel: [{ interviewerId: mona.id, isLead: true }] })).json.interview;
  db.run('UPDATE interview SET scheduled_at = ? WHERE id = ?', ['not-a-date', ivX.id]);
  const bad = await status(ivX.id, { status: 'completed' });
  c('an unreadable start time refuses Completed — bad data never bypasses the guard (409)', bad.status === 409 && bad.json?.code === 'interview_time_invalid', `${bad.status} ${bad.text.slice(0, 120)}`);
  c('…and refuses feedback too', (await api(`/api/interviews/${ivX.id}/feedback`, { method: 'POST', token: interviewer, body: { recommendation: 'yes' } })).json?.code === 'interview_time_invalid');
  db.run('UPDATE interview SET status = ? WHERE id = ?', ['cancelled', ivX.id]); // keep later suites' data sane
} catch (e) { console.error(e); fail++; }
finally {
  console.log(`\n=== INTERVIEW BOOKING: ${pass} passed, ${fail} failed ===\n`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.exit(fail ? 1 : 0);
}
