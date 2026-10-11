// Interview messages — the templates HR edits, the WhatsApp/email message a
// scheduler sends for one interview, and the candidate's recorded answer.
process.env.DATABASE_URL = 'file:/tmp/arabtec_ivmsg.db';
process.env.PORT = '4179';
process.env.APP_TIME_ZONE = 'Africa/Cairo';
import fs from 'node:fs';
import { adminToken, ADMIN_BOOTSTRAP_PASSWORD } from './test-support/admin-session.mjs';
for (const f of ['/tmp/arabtec_ivmsg.db', '/tmp/arabtec_ivmsg.db-journal']) { try { fs.rmSync(f); } catch {} }
process.env.SEED_ADMIN_PASSWORD ||= ADMIN_BOOTSTRAP_PASSWORD;

let pass = 0, fail = 0;
const c = (n, ok, x = '') => { console.log((ok ? '  ✅ ' : '  ❌ ') + n + ' ' + x); ok ? pass++ : fail++; };

const M = await import('./src/lib/interview-messages.js');
const { candidateMessage } = await import('./src/lib/email_templates.js');

console.log('\n— phone numbers for WhatsApp —');
c('Egyptian local 010… gets +20', M.whatsappNumber('0100 123 4567') === '201001234567');
c('+20 is kept', M.whatsappNumber('+20 100 123 4567') === '201001234567');
c('00971 becomes 971', M.whatsappNumber('00971501234567') === '971501234567');
c('two numbers on a CV: the first is used', M.whatsappNumber('01001234567 / 01201234567') === '201001234567');
c('nothing usable → null', M.whatsappNumber('n/a') === null && M.whatsappNumber('') === null);
c('the link carries the text', M.whatsappLink('201001234567', 'Hi & bye') === 'https://wa.me/201001234567?text=Hi%20%26%20bye');

console.log('\n— filling a template —');
c('known placeholders are filled', M.fill('Dear {candidate_name}, at {time}', { candidate_name: 'Sara', time: '10:00' }) === 'Dear Sara, at 10:00');
c('a known placeholder with no value becomes empty', M.fill('[{reason}]', {}) === '[]');
c('unknown braces are left alone', M.fill('{not_a_field}', {}) === '{not_a_field}');
c('unknown placeholders are reported', JSON.stringify(M.unknownPlaceholders('{date} {nme}')) === '["nme"]');
const v = M.interviewVars({ iv: { scheduled_at: '2031-01-06T08:00:00.000Z', duration_min: 45, mode: 'video', location_or_link: 'https://meet.google.com/abc', interview_type: 'technical', interview_no: 'INT-1' },
  candidate: { full_name: 'Sara Adel' }, request: { title: 'Site Engineer' }, panel: [{ full_name: 'Mona Sami' }], sender: { fullName: 'Rana' } });
c('date and time read in Cairo time', v.date === 'Monday, 6 January 2031' && v.time === '10:00', `${v.date} ${v.time}`);
c('a video interview says so, with the link', v.where === 'Video call — https://meet.google.com/abc');
c('position comes from the hiring request', v.position === 'Site Engineer');
c('type, length, panel and sender read as words', v.interview_type === 'Technical interview' && v.duration === '45 minutes' && v.interviewers === 'Mona Sami' && v.recruiter_name === 'Rana');

console.log('\n— the email built from a message —');
const mail = candidateMessage({ title: 'Reminder', subject: 'S', text: 'Hello <b>x</b>\n\nJoin: https://meet.google.com/abc' });
c('HR text is escaped, never HTML', mail.html.includes('&lt;b&gt;x&lt;/b&gt;') && !mail.html.includes('<b>x</b>'));
c('a web address becomes a link', mail.html.includes('href="https://meet.google.com/abc"'));

/* ---------------- the HTTP surface ---------------- */
await import('./prisma/seed.js');
await import('./src/server.js');
await new Promise((r) => setTimeout(r, 700));
const B = 'http://localhost:4179';
async function api(p, { method = 'GET', token, body } = {}) {
  const r = await fetch(B + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, json: j };
}
const login = async (e, p = 'Arabtec@123') => (await api('/api/auth/login', { method: 'POST', body: { email: e, password: p } })).json.token;

const admin = await adminToken(B);
const recruiter = await login('recruiter@arabtec.com');
const interviewer = await login('interviewer@arabtec.com');

console.log('\n— templates —');
const t0 = await api('/api/interviews/messages/templates', { token: recruiter });
c('a recruiter can read the four messages', t0.status === 200 && ['invite', 'reschedule', 'cancel', 'reminder'].every((k) => t0.json.templates[k]?.whatsapp), `got ${t0.status}`);
c('placeholders are listed for the editor', !!t0.json.placeholders?.candidate_name);
const denied = await api('/api/interviews/messages/templates/invite', { method: 'PUT', token: interviewer, body: { subject: 'x', email: 'x', whatsapp: 'x', call: 'x' } });
c('only someone who manages notifications may change them', denied.status === 403, `got ${denied.status}`);
const badPh = await api('/api/interviews/messages/templates/invite', { method: 'PUT', token: admin, body: { subject: 'Hi', email: 'Dear {nmae}', whatsapp: 'x', call: 'x' } });
c('a misspelt placeholder is refused with its name', badPh.status === 400 && /\{nmae\}/.test(badPh.json.error), JSON.stringify(badPh.json));
const empty = await api('/api/interviews/messages/templates/invite', { method: 'PUT', token: admin, body: { subject: 'Hi', email: '', whatsapp: 'x', call: 'x' } });
c('an empty text is refused', empty.status === 400);
const saved = await api('/api/interviews/messages/templates/invite', { method: 'PUT', token: admin,
  body: { subject: 'Invitation — {position}', email: 'Dear {candidate_name},\n\nSee you on {date} at {time}.', whatsapp: 'مرحبا {candidate_name}، موعد المقابلة {date} الساعة {time}', call: 'Hello {candidate_name}' } });
c('HR can save their own wording (Arabic too)', saved.status === 200 && saved.json.templates.invite.customised === true && saved.json.templates.invite.whatsapp.startsWith('مرحبا'));

console.log('\n— one interview —');
const meta = await api('/api/interviews/meta/form', { token: recruiter });
const mona = meta.json.interviewers.find((u) => u.name === 'Mona Sami');
const cand = await api('/api/candidates', { method: 'POST', token: recruiter, body: { fullName: 'Sara Adel', email: 'sara@example.test', phone: '0100 123 4567' } });
const candidateId = cand.json.candidate.id;
const start = new Date(Date.now() + 3 * 86400000); start.setUTCHours(8, 0, 0, 0);
const created = await api('/api/interviews', { method: 'POST', token: recruiter,
  body: { candidateId, scheduledAt: start.toISOString(), durationMin: 60, interviewType: 'hr', mode: 'onsite', locationOrLink: 'Head office, New Cairo', panel: [{ interviewerId: mona.id, isLead: true }] } });
const iv = created.json.interview;
c('interview scheduled', created.status === 201 && !!iv, `got ${created.status}`);
c('the candidate has not answered yet', iv.candidateResponse === 'pending');

const msg = await api(`/api/interviews/${iv.id}/messages/invite`, { token: recruiter });
c('the invitation is filled in with HR’s wording', msg.status === 200 && msg.json.message.whatsapp.startsWith('مرحبا Sara Adel') && !msg.json.message.whatsapp.includes('{'), msg.json?.message?.whatsapp);
c('the WhatsApp link goes to the candidate’s mobile', msg.json.message.whatsappLink.startsWith('https://wa.me/201001234567?text='));
const rem = await api(`/api/interviews/${iv.id}/messages/reminder`, { token: recruiter });
c('an untouched message keeps the default wording', rem.json.message.subject.startsWith('Reminder: your interview on') && rem.json.message.email.includes('Head office, New Cairo'));
c('an unknown message is refused', (await api(`/api/interviews/${iv.id}/messages/hello`, { token: recruiter })).status === 400);
c('an interviewer cannot message candidates', (await api(`/api/interviews/${iv.id}/messages/invite`, { token: interviewer })).status === 403);

const wa = await api(`/api/interviews/${iv.id}/messages/reminder/whatsapp`, { method: 'POST', token: recruiter });
c('opening WhatsApp is recorded', wa.status === 200);
c('the call script and dial link are filled in', msg.json.message.call === 'Hello Sara Adel' && msg.json.message.callLink === 'tel:+201001234567');
const call = await api(`/api/interviews/${iv.id}/messages/invite/call`, { method: 'POST', token: recruiter });
c('a call is recorded', call.status === 200);
c('an unknown channel is refused', (await api(`/api/interviews/${iv.id}/messages/invite/pigeon`, { method: 'POST', token: recruiter })).status === 400);
const mailRes = await api(`/api/interviews/${iv.id}/messages/reminder/email`, { method: 'POST', token: recruiter, body: { subject: 'Reminder', text: 'See you tomorrow.' } });
// The suite runner pins a JSON mail transport (a mailbox that sends nowhere);
// run alone, there is no mailbox at all. Both answers must be honest.
const mailOn = process.env.SMTP_TRANSPORT === 'json';
if (mailOn) c('with a mailbox, the email is sent', mailRes.status === 200 && mailRes.json.ok === true, JSON.stringify(mailRes.json));
else c('with no mailbox, email says so plainly instead of pretending', mailRes.status === 409 && /No mailbox/.test(mailRes.json.error), JSON.stringify(mailRes.json));
const emptyMail = await api(`/api/interviews/${iv.id}/messages/reminder/email`, { method: 'POST', token: recruiter, body: { subject: '', text: '' } });
c('an empty email is refused', emptyMail.status === 400);

console.log('\n— the candidate’s answer —');
const conf = await api(`/api/interviews/${iv.id}/response`, { method: 'POST', token: recruiter, body: { response: 'confirmed' } });
c('HR records that the candidate confirmed', conf.status === 200 && conf.json.interview.candidateResponse === 'confirmed');
c('the history shows the WhatsApp message and the answer',
  conf.json.interview.activity.some((a) => a.type === 'message_whatsapp') && conf.json.interview.activity.some((a) => a.type === 'message_call') && conf.json.interview.activity.some((a) => a.type === 'candidate_response' && a.note === 'Candidate confirmed'));
c('a made-up answer is refused', (await api(`/api/interviews/${iv.id}/response`, { method: 'POST', token: recruiter, body: { response: 'maybe' } })).status === 400);
const list = await api('/api/interviews', { token: recruiter });
c('the list carries the answer too', list.json.interviews.find((x) => x.id === iv.id)?.candidateResponse === 'confirmed');

const moved = await api(`/api/interviews/${iv.id}`, { method: 'PUT', token: recruiter, body: { scheduledAt: new Date(start.getTime() + 86400000).toISOString() } });
c('moving the interview asks the candidate again (answer back to pending)', moved.status === 200 && moved.json.interview.candidateResponse === 'pending', moved.json?.interview?.candidateResponse);
const reset = await api('/api/interviews/messages/templates/invite', { method: 'PUT', token: admin, body: { reset: true } });
c('a message can be put back to the default', reset.status === 200 && reset.json.templates.invite.customised === false);

console.log(`\n=== INTERVIEW MESSAGES: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
