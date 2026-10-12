// Offer letter fidelity and the offer handoffs around it (audit 2026-10-05).
//   • the letter is the owner's original: fixed wording verbatim, only the
//     variable fields change; salary-gated; every variable value escaped
//   • salary components fix the total; validity follows the expiry date
//   • the live Create-offer letter (letter-draft) renders blanks, nothing saved
//   • send keeps "issued" and "emailed" apart and never claims a delivery
//   • re-approval covers every contractual term, not administrative fields,
//     and respects the approval-off setting
//   • canonical terminal stages, including legacy aliases, guard interviews
//   • a declined offer never overwrites a rejected application
//   • a sent offer is corrected by withdrawal + a new offer
// Synthetic data only; SMTP_TRANSPORT=json (no mail leaves the machine).
import { suiteDatabaseUrl } from './test-support/suite-db.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'arabtec-offerletter-'));
process.env.DATABASE_URL = suiteDatabaseUrl('file:' + path.join(TMP, 'offerletter.db'));
process.env.UPLOAD_DIR = path.join(TMP, 'uploads');
process.env.PORT = process.env.OFFER_LETTER_TEST_PORT || '4385';
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
// A Cairo calendar day as YYYY-MM-DD — the letter's own calendar, so the test
// holds whatever zone it runs in (production is UTC).
const cairoToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const day = (n) => { const [y, m, d] = cairoToday.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const COMPS = { basic: 12000, accommodation: 4800, transportation: 3600, others: 3600, area_allowance: 10800 };

try {
  const admin = await adminToken(B);
  const hrMgr = await login('hr.manager@arabtec.com');
  const hrDir = await login('hr.director@arabtec.com');
  const recMgr = await login('rec.manager@arabtec.com');
  const recruiter = await login('recruiter@arabtec.com');
  const hm = await login('hiring.manager@arabtec.com');
  const meta = await must('/api/requests/meta/form', { token: hrMgr });
  const karim = meta.recruiters.find((r) => r.name === 'Karim Adel');
  let n = 0;
  async function pipeline(email) {
    n += 1;
    const rid = (await must('/api/requests', { method: 'POST', token: hrMgr, body: { title: 'Letter Audit ' + n, justification: 'new_hire', projectId: meta.projects[0].id, departmentId: meta.departments[0].id, location: 'Cairo', headcount: 2, priority: 'high' } })).request.id;
    await api(`/api/requests/${rid}/submit`, { method: 'POST', token: hrMgr });
    await must(`/api/requests/${rid}/approve`, { method: 'POST', token: hrDir, body: {} });
    await must(`/api/requests/${rid}/assign`, { method: 'POST', token: recMgr, body: { ownerId: karim.id } });
    const cid = (await must('/api/candidates', { method: 'POST', token: recruiter, body: { fullName: `Synthetic Letter ${n}`, ...(email === false ? { phone: '+20100000' + String(4000 + n) } : { email: `letter-${n}@example.invalid` }) } })).candidate.id;
    const aid = (await must('/api/applications', { method: 'POST', token: recruiter, body: { candidateId: cid, requestId: rid, initialStatus: 'matched' } })).application.id;
    await must(`/api/applications/${aid}/move`, { method: 'POST', token: recruiter, body: { status: 'interviewing' } });
    return { rid, cid, aid };
  }
  async function approvedOffer(body = {}, email) {
    const p = await pipeline(email);
    const o = (await must('/api/offers', { method: 'POST', token: recruiter, body: { applicationId: p.aid, titlePrefix: 'Eng.', positionTitle: 'Senior Document Controller', salaryComponents: COMPS, ...body } })).offer;
    await must(`/api/offers/${o.id}/submit`, { method: 'POST', token: recruiter });
    await must(`/api/offers/${o.id}/approve`, { method: 'POST', token: hrDir, body: {} });
    return { ...p, offer: o };
  }

  console.log('\n— salary components fix the total; bad input is refused —');
  const p1 = await pipeline();
  const created = await api('/api/offers', { method: 'POST', token: recruiter, body: { applicationId: p1.aid, titlePrefix: 'Eng.', positionTitle: 'Senior Document Controller', salaryComponents: COMPS, salaryOffered: 1 } });
  c('created with a breakdown (201)', created.status === 201, created.text.slice(0, 160));
  const o1 = created.json.offer;
  c('the total is the sum of the components, whatever salaryOffered said', o1.salaryOffered === 34800, String(o1.salaryOffered));
  c('the components and title come back on the record', o1.salaryComponents?.area_allowance === 10800 && o1.titlePrefix === 'Eng.');
  for (const [label, comps, re] of [
    ['an unknown component', { basic: 1, bonus: 2 }, /Unknown salary component/],
    ['a negative amount', { basic: -5 }, /zero or more/],
    ['a breakdown without Basic Salary', { accommodation: 100 }, /Basic Salary is required/],
  ]) {
    const r = await api(`/api/offers/${o1.id}`, { method: 'PUT', token: recruiter, body: { salaryComponents: comps } });
    c(`${label} is refused (400)`, r.status === 400 && re.test(r.json?.error || ''), r.text.slice(0, 120));
  }
  c('an unknown title is refused (400)', (await api(`/api/offers/${o1.id}`, { method: 'PUT', token: recruiter, body: { titlePrefix: 'Sir' } })).status === 400);
  c('nothing changed after the refusals', (await must(`/api/offers/${o1.id}`, { token: hrMgr })).offer.salaryOffered === 34800);

  console.log('\n— the letter is the original, with only the variable fields changing —');
  const prev = await api(`/api/offers/${o1.id}/preview`, { token: hrMgr });
  const L = prev.text;
  c('preview renders (200, HTML)', prev.status === 200 && /<html/.test(L));
  const fixed = [
    'Arabtec Egypt for Real Estate Development S.A.E.',
    'أرابتك مصر للتنمية العقارية ش.م.م',
    'We are pleased to confirm our offer of employment to you on the following terms and conditions:',
    'or the regularizartion of your documents as required and requested by the government authorities will be borne by you.',
    'Three months.',
    "Your service is transferable to any of the Company's locations at any time as the business demands.",
    'Please note that the above terms and conditions are valid only if all your documents are in accordance with the employment pre-requisites in existing Egypt Labour and Immigration Laws.',
    'EMPLOYEE UNDERTAKING',
    'Failure to do so will:.',
    'For Arabtec Egypt For Real Estate Development S.A.E',
    'Human Resources Director',
    'The above terms and conditions are accepted.',
    'Tel (+202)24146760', 'Tel (+202)24146761',
    'P.O. Box 595, Heliopolis, Cairo, A.R.E.',
    '/Page 1 of 2', '/Page 2 of 2',
  ];
  const missing = fixed.filter((t) => !L.includes(t));
  c('every fixed passage of the originals is present verbatim', missing.length === 0, JSON.stringify(missing));
  c('no wording from the old template survives (HR Director / 24159266 / Fax)', !/>HR Director</.test(L) && !L.includes('24159266') && !L.includes('Fax'));
  const seq = o1.offerNo.split('-').pop().padStart(5, '0');
  c('reference follows the originals: Re YY/HR/DM/MH-ofr/NNNNN', L.includes(`Re ${String(new Date().getFullYear()).slice(-2)}/HR/DM/MH-ofr/${seq}`));
  c('addressee, salutation and position are the offer\'s', L.includes('Eng. Synthetic Letter 1') && L.includes('Dear Synthetic,') && L.includes('Senior Document Controller'));
  c('total and each component are printed', ['34,800.00', '12,000.00', '4,800.00', '3,600.00', '10,800.00'].every((v) => L.includes(v)));
  c('both conditional footnotes appear when both rows do', L.includes('Others* Includes after duty hours allowance if required') && L.includes('is linked to service outside Cairo'));
  c('no expiry → the standard 5 days', L.includes('valid for 5 days from the document date'));
  const noArea = (await must('/api/offers', { method: 'POST', token: recruiter, body: { applicationId: (await pipeline()).aid, titlePrefix: 'Mr.', positionTitle: 'Estimator', salaryComponents: { basic: 16500, accommodation: 6600, transportation: 4950, others: 4950 }, expiryDate: day(10) } })).offer;
  const L2 = (await api(`/api/offers/${noArea.id}/preview`, { token: hrMgr })).text;
  c('without an Area Allowance row, its footnote is absent', !L2.includes('is linked to service outside Cairo') && L2.includes('Others* Includes'));
  c('validity follows the expiry date (10 days)', L2.includes('valid for 10 days from the document date'));

  console.log('\n— salary permission and escaping —');
  c('a role without offer salary view cannot open the letter (403)', (await api(`/api/offers/${o1.id}/preview`, { token: hm })).status === 403);
  const evil = (await must('/api/offers', { method: 'POST', token: recruiter, body: { applicationId: (await pipeline()).aid, positionTitle: '<script>alert(1)</script>Engineer', salutationName: '<img src=x onerror=1>', salaryComponents: { basic: 1000 } } })).offer;
  const L3 = (await api(`/api/offers/${evil.id}/preview`, { token: hrMgr })).text;
  c('variable text is HTML-escaped in the letter', !L3.includes('<script>alert(1)</script>') && L3.includes('&lt;script&gt;') && !L3.includes('<img src=x'));

  console.log('\n— the live Create-offer letter —');
  const draft = await api('/api/offers/letter-draft', { method: 'POST', token: recruiter, body: { salaryComponents: { basic: 9000 } } });
  c('renders blanks for what is not entered yet', draft.status === 200 && /class="ph">Candidate full name</.test(draft.text) && /class="ph">Position</.test(draft.text) && /class="ph">assigned on save</.test(draft.text));
  c('…and the entered amount', draft.text.includes('9,000.00'));
  const draftApp = await api('/api/offers/letter-draft', { method: 'POST', token: recruiter, body: { applicationId: p1.aid, titlePrefix: 'Eng.' } });
  c('from an application it fills the candidate and the request\'s position', draftApp.text.includes('Eng. Synthetic Letter 1') && draftApp.text.includes('Letter Audit 1'));
  const before = db.get('SELECT COUNT(*) AS n FROM offer').n;
  c('nothing is saved by the live letter', db.get('SELECT COUNT(*) AS n FROM offer').n === before);
  c('a role without offer.create cannot use it (403)', (await api('/api/offers/letter-draft', { method: 'POST', token: hm, body: {} })).status === 403);
  // A recruiter stripped of offer salary rights: no live letter, no components.
  const rid = db.get("SELECT id FROM role WHERE code='recruiter'").id;
  const pids = db.all("SELECT id, code FROM permission WHERE code IN ('offer.salary_view','offer.salary_edit')");
  for (const p of pids) db.run('DELETE FROM role_permission WHERE role_id=? AND permission_id=?', [rid, p.id]);
  const rec2 = await login('recruiter@arabtec.com');
  c('without salary view the live letter is refused (403)', (await api('/api/offers/letter-draft', { method: 'POST', token: rec2, body: {} })).status === 403);
  c('without salary edit components are refused (403)', (await api(`/api/offers/${o1.id}`, { method: 'PUT', token: rec2, body: { salaryComponents: { basic: 1 } } })).status === 403);
  c('…and benefits they cannot see cannot be changed (403)', (await api(`/api/offers/${o1.id}`, { method: 'PUT', token: rec2, body: { benefits: 'Changed' } })).status === 403);
  for (const p of pids) db.run('INSERT INTO role_permission (role_id,permission_id) VALUES (?,?) ON CONFLICT DO NOTHING RETURNING role_id', [rid, p.id]);

  console.log('\n— re-approval: every contractual term, no administrative field —');
  for (const [label, body] of [['salary breakdown', { salaryComponents: { ...COMPS, others: 4000 } }], ['joining date', { joiningDate: day(30) }]]) {
    const f = await approvedOffer();
    const r = await must(`/api/offers/${f.offer.id}`, { method: 'PUT', token: recruiter, body });
    c(`${label} change → back to approval`, r.offer.status === 'pending_approval' && r.offer.approvedBy === null, r.offer.status);
  }
  for (const [label, body] of [['title', { titlePrefix: 'Mr.' }], ['salutation', { salutationName: 'Syn' }], ['expiry', { expiryDate: day(12) }], ['notes', { notes: 'internal' }], ['unchanged total resent', { salaryComponents: COMPS }]]) {
    const f = await approvedOffer();
    const r = await must(`/api/offers/${f.offer.id}`, { method: 'PUT', token: recruiter, body });
    c(`${label} change keeps the approval`, r.offer.status === 'approved', r.offer.status);
  }
  {
    await must('/api/settings/system', { method: 'PUT', token: admin, body: { settings: { offer_approval_required: 'false' } } });
    const p = await pipeline();
    const o = (await must('/api/offers', { method: 'POST', token: recruiter, body: { applicationId: p.aid, salaryComponents: { basic: 5000 } } })).offer;
    await must(`/api/offers/${o.id}/submit`, { method: 'POST', token: recruiter });
    const r = await must(`/api/offers/${o.id}`, { method: 'PUT', token: recruiter, body: { currency: 'USD' } });
    c('with the approval step switched off, a terms change stays approved', r.offer.status === 'approved', r.offer.status);
    await must('/api/settings/system', { method: 'PUT', token: admin, body: { settings: { offer_approval_required: 'true' } } });
  }

  console.log('\n— send: issued and emailed are separate facts —');
  {
    const f = await approvedOffer({ expiryDate: day(-1) });
    const r = await api(`/api/offers/${f.offer.id}/send`, { method: 'POST', token: hrMgr });
    c('an expiry already passed is refused (409), nothing moves', r.status === 409 && (await must(`/api/offers/${f.offer.id}`, { token: hrMgr })).offer.status === 'approved', r.text.slice(0, 120));
  }
  const withMail = await approvedOffer();
  const sent = await api(`/api/offers/${withMail.offer.id}/send`, { method: 'POST', token: hrMgr });
  c('send succeeds (200) and reports an email queued, not delivered', sent.status === 200 && sent.json.delivery?.state === 'queued' && sent.json.delivery.to === `letter-${n}@example.invalid`, JSON.stringify(sent.json?.delivery));
  c('no expiry → the record gets the 5-day expiry the letter states', sent.json.offer.expiryDate === day(5), sent.json.offer.expiryDate);
  const issuedLetter = (await api(`/api/offers/${withMail.offer.id}/preview`, { token: hrMgr })).text;
  c('the issued letter is marked issued and still says 5 days', issuedLetter.includes('Issued letter') && issuedLetter.includes('valid for 5 days'));
  await sleep(400);
  const actsMail = db.all('SELECT type, note FROM candidate_activity WHERE candidate_id=?', [withMail.cid]);
  c('the candidate activity records the real outcome once the mailer finished', actsMail.some((a) => a.type === 'email_sent' && /Offer letter email sent to letter-/.test(a.note || '')), JSON.stringify(actsMail.slice(-3)));
  const noMail = await approvedOffer({}, false);
  const sent2 = await api(`/api/offers/${noMail.offer.id}/send`, { method: 'POST', token: hrMgr });
  c('a candidate without an email: issued, and the response says no email went', sent2.status === 200 && sent2.json.offer.status === 'sent' && sent2.json.delivery?.state === 'not_sent' && sent2.json.delivery.reason === 'no_candidate_email', JSON.stringify(sent2.json?.delivery));
  await sleep(300);
  c('…and nothing claims an email was sent', !db.all('SELECT type FROM candidate_activity WHERE candidate_id=?', [noMail.cid]).some((a) => a.type === 'email_sent'));
  const offerActs = (await must(`/api/offers/${noMail.offer.id}`, { token: hrMgr })).offer.activity;
  c('the offer activity records "No email sent" with the reason', offerActs.some((a) => a.type === 'delivery' && /No email sent/.test(a.note || '')));

  console.log('\n— a sent offer is corrected by withdrawal and a new offer —');
  c('the sent offer cannot be edited (409)', (await api(`/api/offers/${withMail.offer.id}`, { method: 'PUT', token: recruiter, body: { positionTitle: 'Other' } })).status === 409);
  await must(`/api/offers/${withMail.offer.id}/result`, { method: 'POST', token: hrMgr, body: { result: 'withdrawn', reason: 'Correcting the salary' } });
  const again = await api('/api/offers', { method: 'POST', token: recruiter, body: { applicationId: withMail.aid, salaryComponents: { basic: 13000 } } });
  c('a new offer can be prepared for the same application', again.status === 201, again.text.slice(0, 120));
  await must(`/api/offers/${again.json.offer.id}/submit`, { method: 'POST', token: recruiter });
  await must(`/api/offers/${again.json.offer.id}/approve`, { method: 'POST', token: hrDir, body: {} });
  c('…approved and sent as the corrected offer', (await api(`/api/offers/${again.json.offer.id}/send`, { method: 'POST', token: hrMgr })).status === 200);

  console.log('\n— a declined offer never overwrites a rejected application —');
  {
    const f = await approvedOffer();
    await must(`/api/offers/${f.offer.id}/send`, { method: 'POST', token: hrMgr });
    await must(`/api/applications/${f.aid}/move`, { method: 'POST', token: recruiter, body: { status: 'rejected', reason: 'Audit' } });
    await must(`/api/offers/${f.offer.id}/result`, { method: 'POST', token: hrMgr, body: { result: 'rejected_by_candidate', reason: 'Declined' } });
    c('the application stays Rejected', (await must(`/api/applications/${f.aid}`, { token: recruiter })).application.status === 'rejected');
  }

  console.log('\n— interviews: canonical terminals, legacy aliases, override kept —');
  {
    const p = await pipeline();
    db.run("UPDATE application SET status='withdrawn' WHERE id=?", [p.aid]); // a legacy row, as stored before the stage migration
    const mona = (await must('/api/interviews/meta/form', { token: recruiter })).interviewers[0];
    const body = { applicationId: p.aid, scheduledAt: new Date(Date.now() + 86400000).toISOString(), panel: [{ interviewerId: mona.id, isLead: true }] };
    const r = await api('/api/interviews', { method: 'POST', token: recruiter, body });
    c('a legacy "withdrawn" application is treated as Rejected (409)', r.status === 409 && r.json?.applicationStatus === 'rejected', r.text.slice(0, 160));
    c('override without candidate.merge is refused (403)', (await api('/api/interviews', { method: 'POST', token: recruiter, body: { ...body, overrideTerminal: true, overrideReason: 'x' } })).status === 403);
    c('override without a reason is refused (400)', (await api('/api/interviews', { method: 'POST', token: hrMgr, body: { ...body, overrideTerminal: true } })).status === 400);
    c('authorized override with a reason still schedules (201)', (await api('/api/interviews', { method: 'POST', token: hrMgr, body: { ...body, overrideTerminal: true, overrideReason: 'Rehire review' } })).status === 201);
  }

  console.log('\n— a closed or cancelled request has no position to offer —');
  for (const [state, action] of [['cancelled', 'cancel'], ['closed', 'close']]) {
    const f = await approvedOffer();
    await must(`/api/requests/${f.rid}/${action}`, { method: 'POST', token: recMgr, body: { reason: 'Audit' } });
    const r = await api(`/api/offers/${f.offer.id}/send`, { method: 'POST', token: hrMgr });
    c(`sending an approved offer on a ${state} request is refused (409)`, r.status === 409 && r.json?.requestStatus === state, r.text.slice(0, 140));
    c(`…the offer stays approved and the application unchanged`, (await must(`/api/offers/${f.offer.id}`, { token: hrMgr })).offer.status === 'approved' && (await must(`/api/applications/${f.aid}`, { token: recruiter })).application.status === 'issuing_offer');
  }
  {
    const p = await pipeline();
    await must(`/api/requests/${p.rid}/cancel`, { method: 'POST', token: recMgr, body: { reason: 'Audit' } });
    const mona = (await must('/api/interviews/meta/form', { token: recruiter })).interviewers[0];
    // A slot of its own: the same panelist at the same instant now needs an acknowledged reason (audit 2026-10-06).
    const body = { applicationId: p.aid, scheduledAt: new Date(Date.now() + 2 * 86400000 + 5 * 3600000).toISOString(), panel: [{ interviewerId: mona.id, isLead: true }] };
    const iv = await api('/api/interviews', { method: 'POST', token: recruiter, body });
    c('scheduling for a cancelled request is refused (409), nothing created', iv.status === 409 && (await must(`/api/interviews/application/${p.aid}`, { token: recruiter })).interviews.length === 0, iv.text.slice(0, 140));
    c('…an authorized override with a reason still schedules (201)', (await api('/api/interviews', { method: 'POST', token: hrMgr, body: { ...body, overrideTerminal: true, overrideReason: 'Pool interview' } })).status === 201);
    const of = await api('/api/offers', { method: 'POST', token: recruiter, body: { applicationId: p.aid, salaryComponents: { basic: 1 } } });
    c('creating an offer for a cancelled request is refused (409)', of.status === 409 && of.json?.requestStatus === 'cancelled', of.text.slice(0, 140));
  }
  {
    const f = await approvedOffer();
    await must(`/api/requests/${f.rid}/hold`, { method: 'POST', token: recMgr, body: { reason: 'Audit' } });
    const held = await api(`/api/offers/${f.offer.id}/send`, { method: 'POST', token: hrMgr });
    c('Q-01: on hold pauses sending (409, says On Hold)', held.status === 409 && /On Hold/.test(held.json?.error || ''), held.text.slice(0, 140));
    c('…the offer stays approved', (await must(`/api/offers/${f.offer.id}`, { token: hrMgr })).offer.status === 'approved');
    const mona = (await must('/api/interviews/meta/form', { token: recruiter })).interviewers[0];
    const ivHeld = await api('/api/interviews', { method: 'POST', token: recruiter, body: { applicationId: f.aid, scheduledAt: new Date(Date.now() + 86400000).toISOString(), panel: [{ interviewerId: mona.id, isLead: true }] } });
    c('Q-01: on hold pauses interview scheduling (409)', ivHeld.status === 409 && /On Hold/.test(ivHeld.json?.error || ''), ivHeld.text.slice(0, 140));
    await must(`/api/requests/${f.rid}/resume`, { method: 'POST', token: recMgr });
    c('Q-01: after resume the same offer sends (200), nothing recreated', (await api(`/api/offers/${f.offer.id}/send`, { method: 'POST', token: hrMgr })).status === 200);
  }
} catch (e) { console.error(e); fail++; }
finally {
  console.log(`\n=== OFFER LETTER & HANDOFFS: ${pass} passed, ${fail} failed ===\n`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.exit(fail ? 1 : 0);
}
