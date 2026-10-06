// Packet II/III — interview communications (INTERVIEW_IMPLEMENTATION_BRIEF.md).
//   • global templates: permission, bounded placeholders, unknown/forbidden/
//     unmatched tokens refused; per-interview edits persist
//   • explicit send: the right recipients get the right content; the CV only
//     on ticked panel emails; never to the candidate
//   • truthful outcomes: dry run, not sent (no address / switched off /
//     not configured), failed (closed loopback port) and retry of failed only
//   • double submission of one send action sends once
//   • WhatsApp is a recorded manual hand-off, never "sent"
//   • changes: notice recorded, update sent (added panelist invited, removed
//     panelist told without the new details), cancellation, calendar revision
//   • Cairo time with the right offset in summer and winter; escaping
// Synthetic recipients only (example.invalid); no real mail leaves the machine.
import { suiteDatabaseUrl } from './test-support/suite-db.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'arabtec-ivcomms-'));
process.env.DATABASE_URL = suiteDatabaseUrl('file:' + path.join(TMP, 'ivcomms.db'));
process.env.UPLOAD_DIR = path.join(TMP, 'uploads');
process.env.PORT = process.env.IV_COMMS_TEST_PORT || '4381';
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
const M = await import('./src/lib/interview-messages.js');

let pass = 0, fail = 0;
const c = (n, ok, x = '') => { console.log((ok ? '  ✅ ' : '  ❌ ') + n + (ok ? '' : ' ' + x)); ok ? pass++ : fail++; };
async function api(p, { method = 'GET', token, body } = {}) {
  const r = await fetch(B + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch {}
  return { status: r.status, json: j, text };
}
const must = async (p, o) => { const r = await api(p, o); if (r.status >= 400) throw new Error(`${o?.method || 'GET'} ${p} → ${r.status} ${r.text.slice(0, 200)}`); return r.json; };
const login = async (e) => (await api('/api/auth/login', { method: 'POST', body: { email: e, password: 'Arabtec@123' } })).json.token;
const at = (dayOffset, hh, mm = 0) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + dayOffset); d.setUTCHours(hh, mm, 0, 0); return d.toISOString(); };
let keyN = 0; const key = () => `test-batch-${Date.now()}-${++keyN}`;

try {
  console.log('\n— library: Cairo time, escaping, calendar —');
  const summer = M.cairoParts('2026-07-15T07:00:00Z');
  const winter = M.cairoParts('2026-12-15T08:00:00Z');
  c('summer: 07:00 UTC is 10:00 Cairo time (GMT+3)', summer.time === '10:00' && summer.timezone === 'Cairo time (GMT+3)', JSON.stringify(summer));
  c('winter: 08:00 UTC is 10:00 Cairo time (GMT+2)', winter.time === '10:00' && winter.timezone === 'Cairo time (GMT+2)', JSON.stringify(winter));
  const html = M.textToHtml(M.fill('Dear {{candidateName}}', { candidateName: '<img src=x onerror=alert(1)> & "Co"' }));
  c('substituted values are escaped in the email HTML', !html.includes('<img') && html.includes('&lt;img') && html.includes('&amp;'));
  const ivx = { id: 9, interview_no: 'INT-09', scheduled_at: '2026-12-15T08:00:00Z', duration_min: 60, calendar_seq: 3, location_or_link: 'HQ' };
  const ics = M.interviewIcs({ iv: ivx, summary: 's', description: 'd', cancelled: true });
  c('cancellation calendar entry: same UID, SEQUENCE = revision, STATUS:CANCELLED, UTC start',
    ics.includes('UID:INT-09@arabtec-recruitment-hub') && ics.includes('SEQUENCE:3') && ics.includes('STATUS:CANCELLED') && ics.includes('DTSTART:20261215T080000Z'));
  c('international phone check', M.intlPhone('+20 100 123 4567') === '+201001234567' && M.intlPhone('01001234567') === null);

  const hrMgr = await login('hr.manager@arabtec.com');
  const hrDir = await login('hr.director@arabtec.com');
  const recMgr = await login('rec.manager@arabtec.com');
  const recruiter = await login('recruiter@arabtec.com');
  const interviewer = await login('interviewer@arabtec.com');
  const meta = await must('/api/requests/meta/form', { token: hrMgr });
  const karim = meta.recruiters.find((r) => r.name === 'Karim Adel');
  const people = (await must('/api/interviews/meta/form', { token: recruiter })).interviewers;
  const mona = people.find((u) => u.name === 'Mona Sami');
  const p2 = people.find((u) => u.id !== mona.id);
  const rid = (await must('/api/requests', { method: 'POST', token: hrMgr, body: { title: 'Comms Audit Site Engineer', justification: 'new_hire', projectId: meta.projects[0].id, departmentId: meta.departments[0].id, location: 'Cairo', headcount: 3, priority: 'high' } })).request.id;
  await api(`/api/requests/${rid}/submit`, { method: 'POST', token: hrMgr });
  await must(`/api/requests/${rid}/approve`, { method: 'POST', token: hrDir, body: {} });
  await must(`/api/requests/${rid}/assign`, { method: 'POST', token: recMgr, body: { ownerId: karim.id } });
  let n = 0;
  async function booked({ email = true, phone = null, mode = 'video', link = 'https://meet.example.invalid/abc', panel = [mona.id] } = {}) {
    n += 1;
    const ph = phone || `+20100123${String(4500 + n)}`; // unique per candidate (duplicate detection)
    const cid = (await must('/api/candidates', { method: 'POST', token: recruiter, body: { fullName: `Synthetic Comms ${n}`, ...(email ? { email: `comms-${n}@example.invalid` } : {}), phone: ph } })).candidate.id;
    const aid = (await must('/api/applications', { method: 'POST', token: recruiter, body: { candidateId: cid, requestId: rid, initialStatus: 'matched' } })).application.id;
    const iv = (await must('/api/interviews', { method: 'POST', token: recruiter, body: { applicationId: aid, scheduledAt: at(2 + n, 7), durationMin: 60, mode, locationOrLink: link, panel: panel.map((id, i) => ({ interviewerId: id, isLead: i === 0 })) } })).interview;
    return { cid, aid, iv };
  }

  console.log('\n— templates —');
  const tpl = await must('/api/interviews/message-templates', { token: recruiter });
  c('templates load with placeholders and the defaults', tpl.templates.invite.candidate.body.includes('{{candidateName}}') && tpl.placeholders.some((p) => p.name === 'cvLink'));
  c('an interviewer cannot change the organisation templates (403)', (await api('/api/interviews/message-templates', { method: 'PUT', token: interviewer, body: { templates: { invite: { candidate: { subject: 'x' } } } } })).status === 403);
  for (const [label, text, aud] of [['an unknown placeholder', 'Hi {{salary}}', 'candidate'], ['the CV link in a candidate message', 'See {{cvLink}}', 'candidate'], ['an unmatched brace', 'Hi {{candidateName', 'candidate'], ['the CV link in WhatsApp', '{{cvLink}}', 'whatsapp']]) {
    const r = await api('/api/interviews/message-templates', { method: 'PUT', token: hrMgr, body: { templates: { invite: { [aud]: { body: text } } } } });
    c(`${label} is refused (400)`, r.status === 400, r.text.slice(0, 140));
  }
  const ok = await api('/api/interviews/message-templates', { method: 'PUT', token: hrMgr, body: { templates: { invite: { candidate: { subject: 'Your Arabtec interview — {{position}}' } } } } });
  c('a valid change to the organisation template is saved (200)', ok.status === 200 && ok.json.templates.invite.candidate.subject === 'Your Arabtec interview — {{position}}');

  console.log('\n— one interview: preview, edit, send —');
  const A = await booked({ panel: [mona.id, p2.id] });
  // Attach a CV so the panel CV option can be exercised.
  const fd = new FormData(); fd.append('file', new Blob(['Synthetic CV'], { type: 'text/plain' }), 'synthetic-cv.txt');
  await fetch(`${B}/api/candidates/${A.cid}/resume?parse=0`, { method: 'POST', headers: { Authorization: 'Bearer ' + recruiter }, body: fd });
  const msg = await must(`/api/interviews/${A.iv.id}/messages?kind=invite`, { token: recruiter });
  c('preview addresses the candidate and each panelist separately', msg.recipients.filter((r) => r.audience === 'panel').length === 2 && msg.recipients.some((r) => r.audience === 'candidate' && r.reachable));
  c('the candidate text has the Cairo time and no CV link or interview reference', msg.rendered.candidate.body.includes('Cairo time (GMT') && !msg.rendered.candidate.body.includes('#interviews/') && !msg.rendered.candidate.body.includes(A.iv.interviewNo));
  c('the panel text carries the authenticated interview/CV pointer', Object.values(msg.rendered.panel).every((p) => p.body.includes(A.iv.interviewNo)));
  c('a panelist cannot read the messages (403)', (await api(`/api/interviews/${A.iv.id}/messages`, { token: interviewer })).status === 403);
  c('a per-interview edit with a forbidden token is refused (400)', (await api(`/api/interviews/${A.iv.id}/messages`, { method: 'PUT', token: recruiter, body: { kind: 'invite', messages: { candidate: { subject: 'x', body: 'CV: {{cvLink}}' } } } })).status === 400);
  await must(`/api/interviews/${A.iv.id}/messages`, { method: 'PUT', token: recruiter, body: { kind: 'invite', messages: { candidate: { subject: 'Interview on {{date}}', body: 'Dear {{candidateFirstName}},\nSee you at {{time}} ({{timezone}}).\n{{where}}' } } } });
  const after = await must(`/api/interviews/${A.iv.id}/messages?kind=invite`, { token: recruiter });
  c('the per-interview message persists after reload', after.messages.candidate.custom === true && after.rendered.candidate.subject.startsWith('Interview on '));
  const bk = key();
  const sent = await api(`/api/interviews/${A.iv.id}/send`, { method: 'POST', token: recruiter, body: { kind: 'invite', batchKey: bk, candidate: true, panel: [mona.id, p2.id], attachCv: [mona.id] } });
  const rows = sent.json?.dispatches || [];
  c('send: one row per recipient (candidate + 2 panelists)', sent.status === 200 && rows.length === 3, sent.text.slice(0, 200));
  c('…marked as test transport, not delivered', rows.every((r) => r.status === 'dry_run'), JSON.stringify(rows.map((r) => r.status)));
  c('…the CV only on Mona\'s email, never the candidate\'s', rows.find((r) => r.recipientUserId === mona.id)?.attachCv === true && rows.filter((r) => r.attachCv).length === 1 && !rows.find((r) => r.audience === 'candidate').attachCv);
  c('…each recipient got their own subject', new Set(rows.map((r) => r.subject)).size >= 2 && rows.find((r) => r.audience === 'candidate').subject.startsWith('Interview on '));
  const again = await api(`/api/interviews/${A.iv.id}/send`, { method: 'POST', token: recruiter, body: { kind: 'invite', batchKey: bk, candidate: true, panel: [mona.id, p2.id] } });
  c('the same send action twice sends once (replayed, no new rows)', again.json?.replayed === true && Number(db.get('SELECT COUNT(*) AS n FROM interview_dispatch WHERE interview_id=?', [A.iv.id]).n) === 3);
  const acts = db.all('SELECT type, note FROM candidate_activity WHERE candidate_id=?', [A.cid]);
  c('the candidate activity says test transport, not "sent"', acts.some((a) => /not delivered/.test(a.note || '')) && !acts.some((a) => a.type === 'email_sent'), JSON.stringify(acts.slice(-2)));

  console.log('\n— truthful when something is missing or off —');
  const N = await booked({ email: false });
  const noMail = await must(`/api/interviews/${N.iv.id}/send`, { method: 'POST', token: recruiter, body: { kind: 'invite', batchKey: key(), candidate: true, panel: [mona.id] } });
  const cr = noMail.dispatches.find((r) => r.audience === 'candidate');
  c('a candidate without an email: not sent, with the reason', cr.status === 'not_sent' && /no email/i.test(cr.reason || ''), JSON.stringify(cr));
  const V = await booked({ link: 'not a link' });
  const badLink = await api(`/api/interviews/${V.iv.id}/send`, { method: 'POST', token: recruiter, body: { kind: 'invite', batchKey: key(), candidate: true } });
  c('a video interview without a valid https link cannot be sent (400)', badLink.status === 400 && badLink.json?.code === 'details_incomplete');
  db.run("UPDATE notification_config SET enabled=0 WHERE event_key='interview.scheduled'");
  const off = await must(`/api/interviews/${N.iv.id}/send`, { method: 'POST', token: recruiter, body: { kind: 'invite', batchKey: key(), candidate: false, panel: [mona.id] } });
  c('switched off in Notifications: not sent, saying so', off.dispatches.every((r) => r.status === 'not_sent' && /switched off/i.test(r.reason || '')), JSON.stringify(off.dispatches));
  db.run("UPDATE notification_config SET enabled=1 WHERE event_key='interview.scheduled'");

  console.log('\n— a failing provider, then retry of the failed only —');
  const F = await booked({ panel: [mona.id, p2.id] });
  // A closed loopback port: the attempt fails at once and nothing leaves the machine.
  Object.assign(process.env, { SMTP_TRANSPORT: '', SMTP_HOST: '127.0.0.1', SMTP_PORT: '1', SMTP_USER: 'synthetic@example.invalid', SMTP_PASS: 'synthetic-test-value', SMTP_ENCRYPTION: 'none' });
  const failed = await must(`/api/interviews/${F.iv.id}/send`, { method: 'POST', token: recruiter, body: { kind: 'invite', batchKey: key(), candidate: true, panel: [mona.id] } });
  c('a refused connection is recorded as failed, with the error', failed.dispatches.length === 2 && failed.dispatches.every((r) => r.status === 'failed' && r.reason), JSON.stringify(failed.dispatches.map((r) => [r.status, (r.reason || '').slice(0, 40)])));
  // The panelist p2 gets a separate, successful send before the retry.
  process.env.SMTP_TRANSPORT = 'json';
  await must(`/api/interviews/${F.iv.id}/send`, { method: 'POST', token: recruiter, body: { kind: 'invite', batchKey: key(), candidate: false, panel: [p2.id] } });
  const retry = await must(`/api/interviews/${F.iv.id}/send`, { method: 'POST', token: recruiter, body: { kind: 'invite', batchKey: key(), retryFailed: true } });
  c('retry resends only the failed recipients (candidate + Mona), not p2', retry.dispatches.length === 2 && retry.dispatches.every((r) => r.status === 'dry_run' && r.retryOf) && !retry.dispatches.some((r) => r.recipientUserId === p2.id), JSON.stringify(retry.dispatches.map((r) => r.recipientName)));
  c('nothing left to retry → 409', (await api(`/api/interviews/${F.iv.id}/send`, { method: 'POST', token: recruiter, body: { kind: 'invite', batchKey: key(), retryFailed: true } })).status === 409);
  for (const k of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_ENCRYPTION']) delete process.env[k];

  console.log('\n— WhatsApp: a manual hand-off —');
  const W = await booked({ phone: '0100 123 4567' });
  c('a local-format phone is refused for WhatsApp (400)', (await api(`/api/interviews/${W.iv.id}/whatsapp-handoff`, { method: 'POST', token: recruiter, body: { kind: 'invite' } })).status === 400);
  const wa = await must(`/api/interviews/${A.iv.id}/whatsapp-handoff`, { method: 'POST', token: recruiter, body: { kind: 'invite' } });
  c('WhatsApp opens a wa.me link with the editable text, no CV link', /^https:\/\/wa\.me\/201001234501\?text=/.test(wa.link) && !decodeURIComponent(wa.link).includes('#interviews/'));
  c('…recorded as a manual hand-off, not as sent', wa.dispatches[0]?.status === 'manual_handoff' && wa.dispatches[0]?.channel === 'whatsapp');

  console.log('\n— change, update, cancellation —');
  const U = await booked({ panel: [mona.id] });
  const seq0 = (await must(`/api/interviews/${U.iv.id}`, { token: recruiter })).interview.calendarSeq;
  const moved = await must(`/api/interviews/${U.iv.id}`, { method: 'PUT', token: recruiter, body: { scheduledAt: at(20, 9), panel: [{ interviewerId: p2.id, isLead: true }] } });
  c('a material change raises the calendar revision and records an uncommunicated notice',
    moved.interview.calendarSeq === seq0 + 1 && moved.interview.notice?.kind === 'update' && moved.interview.notice.communicated === false && moved.changes.includes('date_time') && moved.changes.includes('panel'));
  const um = await must(`/api/interviews/${U.iv.id}/messages?kind=update`, { token: recruiter });
  c('the update says what changed', /date and time/.test(um.rendered.candidate.body) && /interview panel/.test(um.rendered.candidate.body));
  c('the added panelist receives the invitation, the removed one a note without the new details',
    um.rendered.panel[p2.id]?.asInvite === true && um.rendered.panelRemoved[mona.id] && !um.rendered.panelRemoved[mona.id].body.includes(um.when.date));
  const us = await must(`/api/interviews/${U.iv.id}/send`, { method: 'POST', token: recruiter, body: { kind: 'update', batchKey: key(), candidate: true, panel: [p2.id, mona.id] } });
  c('update sent to candidate, new panelist, and the removed panelist told', us.dispatches.length === 3 && us.dispatches.some((r) => r.audience === 'panel_removed' && r.recipientUserId === mona.id));
  c('…the notice is now communicated', us.interview.notice?.communicated === true);
  await must(`/api/interviews/${U.iv.id}/status`, { method: 'POST', token: recruiter, body: { status: 'cancelled', reason: 'Internal: role re-scoped' } });
  const cm = await must(`/api/interviews/${U.iv.id}/messages?kind=cancel`, { token: recruiter });
  c('cancellation: candidate text has no internal reason; panel text has it', !cm.rendered.candidate.body.includes('re-scoped') && Object.values(cm.rendered.panel).some((p) => p.body.includes('re-scoped')));
  const cs = await must(`/api/interviews/${U.iv.id}/send`, { method: 'POST', token: recruiter, body: { kind: 'cancel', batchKey: key(), candidate: true, panel: [p2.id] } });
  c('cancellation sent; calendar revision rose again', cs.dispatches.length === 2 && cs.interview.calendarSeq === seq0 + 2);
  const S = await booked();
  await must(`/api/interviews/${S.iv.id}`, { method: 'PUT', token: recruiter, body: { durationMin: 90 } });
  c('choosing not to notify needs a reason (400)', (await api(`/api/interviews/${S.iv.id}/notice/skip`, { method: 'POST', token: recruiter, body: {} })).status === 400);
  const sk = await must(`/api/interviews/${S.iv.id}/notice/skip`, { method: 'POST', token: recruiter, body: { reason: 'Told the candidate by phone' } });
  c('…and is recorded as a decision, not as communicated', sk.interview.notice?.skipped === true && sk.interview.notice.communicated === false);

  console.log('\n— save & send from the API —');
  const cid = (await must('/api/candidates', { method: 'POST', token: recruiter, body: { fullName: 'Synthetic Send On Save', email: 'send-on-save@example.invalid' } })).candidate.id;
  const aid = (await must('/api/applications', { method: 'POST', token: recruiter, body: { candidateId: cid, requestId: rid, initialStatus: 'matched' } })).application.id;
  const sos = await must('/api/interviews', { method: 'POST', token: recruiter, body: { applicationId: aid, scheduledAt: at(30, 8), mode: 'onsite', locationOrLink: 'Head Office', panel: [{ interviewerId: mona.id, isLead: true }], sendInvitations: true } });
  c('sendInvitations: true sends to candidate and panel, recorded per recipient', sos.delivery?.dispatches?.length === 2 && sos.delivery.state === 'queued');
} catch (e) { console.error(e); fail++; }
finally {
  console.log(`\n=== INTERVIEW COMMUNICATIONS: ${pass} passed, ${fail} failed ===\n`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.exit(fail ? 1 : 0);
}
