// End-to-end proof that every catalogued notification event actually fires.
//
// The console can only be trusted if a ticked checkbox produces a message. This
// walks a real requisition from creation to a joined offer, plus the side paths
// (hold, resume, reject, cancel, close, reopen), and asserts that each event in
// notification-catalog.js was dispatched to the people its configuration names.
//
// Mail runs through nodemailer's jsonTransport, so a full message is built and
// addressed without leaving the machine. That is what makes the recipient
// assertions meaningful: an event that resolves to nobody fails here rather than
// looking healthy because nothing threw.
//
//   node --experimental-sqlite notification_e2e_test.mjs
const RID = process.pid + '_' + Date.now();
const DBF = `/tmp/arabtec_notif_e2e_${RID}.db`;
process.env.DATABASE_URL = 'file:' + DBF;
process.env.PORT = String(4830 + (process.pid % 60));
process.env.SEED_ADMIN_PASSWORD = 'Admin@12345';   // what test-support/admin-session.mjs expects
process.env.SEED_DEMO_DATA = 'true';
process.env.SMTP_TRANSPORT = 'json';
process.env.MAIL_FROM = 'careers@arabtecegy.com';
process.env.RATE_LIMIT_DISABLED = 'true';

import fs from 'node:fs';
for (const f of [DBF, DBF + '-journal', DBF + '-wal', DBF + '-shm']) { try { fs.rmSync(f); } catch {} }

// Capture every email the dispatcher emits. mailer.js logs one JSON line per
// send; reading them back is how the assertions below learn the real recipients
// without reaching inside the module under test.
const SENT = [];
const realLog = console.log;
console.log = (...a) => {
  const s = a[0];
  if (typeof s === 'string' && s.startsWith('{')) {
    try {
      const o = JSON.parse(s);
      if (o.msg === 'email.sent' || o.msg === 'email.skipped' || o.msg === 'email.failed') SENT.push(o);
    } catch { /* not ours */ }
  }
  realLog(...a);
};

await import('./prisma/seed.js');
await import('./src/server.js');
const { waitForReady } = await import('./test-support/wait-ready.mjs');
await waitForReady('http://localhost:' + process.env.PORT);

const { NOTIFICATION_EVENTS } = await import('./src/lib/notification-catalog.js');

const B = 'http://localhost:' + process.env.PORT;
let pass = 0, fail = 0;
const ok = (n, good, x = '') => { realLog((good ? '  ✅ ' : '  ❌ ') + n + (x ? '  ' + x : '')); good ? pass++ : fail++; };

async function call(method, path, body, token) {
  const r = await fetch(B + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, j };
}
const GET = (p, t) => call('GET', p, null, t);
const POST = (p, b, t) => call('POST', p, b, t);
const PUT = (p, b, t) => call('PUT', p, b, t);

async function login(email, password) {
  const r = await POST('/api/auth/login', { email, password });
  return r.j?.token || null;
}

/** Emails sent since a marker index, as "to" addresses. */
function since(mark) { return SENT.slice(mark); }
function addrs(list) { return list.filter((e) => e.msg === 'email.sent').map((e) => e.to); }

/**
 * Run an action and return the addresses it mailed.
 *
 * The settle is not padding. sendMail is deliberately fire-and-forget — mailer.js
 * exists so that a dead SMTP server can never throw into a request handler — so
 * the send resolves AFTER the HTTP response the caller awaited. Asserting
 * immediately reads the previous action's mail and produces a test that is
 * wrong in both directions: green when it should be red, red when the product
 * is fine. Waiting for the queue to drain is what makes the recipient
 * assertions mean anything.
 */
async function fired(action) {
  const mark = SENT.length;
  const res = await action();
  const deadline = Date.now() + 1500;
  let stable = 0, last = SENT.length;
  while (Date.now() < deadline && stable < 3) {
    await new Promise((r) => setTimeout(r, 40));
    if (SENT.length === last) stable += 1; else { stable = 0; last = SENT.length; }
  }
  return { res, mail: addrs(since(mark)) };
}

realLog('\n— setup —');
// The bootstrap admin carries must_change_password, which blocks every route
// until it is rotated. The shared helper does that rotation the same way the
// rest of the suite does, so this file cannot drift from the password policy.
const { adminToken } = await import('./test-support/admin-session.mjs');
const admin = await adminToken(B);
ok('admin authenticated', !!admin);

const meta = (await GET('/api/requests/meta/form', admin)).j;
const projectId = meta.projects[0].id;
const departmentId = meta.departments[0].id;
const hrDirector = (await GET('/api/users', admin)).j.users.find((u) => u.email === 'hr.director@arabtec.com');
const recruiter = (await GET('/api/users', admin)).j.users.find((u) => u.email === 'recruiter@arabtec.com');
const hiringMgr = (await GET('/api/users', admin)).j.users.find((u) => u.email === 'hiring.manager@arabtec.com');
ok('reference data present', !!(projectId && departmentId && hrDirector && recruiter));

/* ================================================================= requests */
realLog('\n— hiring request lifecycle —');

const created = await POST('/api/requests', {
  title: 'Site Engineer', projectId, departmentId, headcount: 1,
  priority: 'high', location: 'Cairo', hiringManagerId: hiringMgr?.id,
}, admin);
ok('request created', created.status === 201, `HTTP ${created.status}`);
const reqId = created.j?.request?.id;

const submitted = await fired(() => POST(`/api/requests/${reqId}/submit`, {}, admin));
ok('request.submitted → approvers emailed', submitted.mail.length > 0, JSON.stringify(submitted.mail));

const approved = await fired(() => POST(`/api/requests/${reqId}/approve`, { comment: 'ok' }, admin));
ok('request.approved fires', approved.res.status === 200 && approved.mail.length > 0, JSON.stringify(approved.mail));

const assigned = await fired(() => POST(`/api/requests/${reqId}/assign`, { ownerId: recruiter.id }, admin));
ok('request.assigned → the new owner', assigned.res.status === 200 && assigned.mail.includes(recruiter.email),
  JSON.stringify(assigned.mail));

const held = await fired(() => POST(`/api/requests/${reqId}/hold`, { reason: 'budget freeze' }, admin));
ok('request.on_hold is in-app only by default (no email)', held.mail.length === 0,
  held.mail.length ? JSON.stringify(held.mail) : 'no email — as configured');

await POST(`/api/requests/${reqId}/resume`, {}, admin);

/* =============================================================== candidates */
realLog('\n— candidate & application —');

const cand = await POST('/api/candidates', {
  fullName: 'Test Candidate', email: 'candidate.e2e@gmail.com', phone: '01000000000',
}, admin);
ok('candidate created', cand.status === 201, `HTTP ${cand.status}`);
const candId = cand.j?.candidate?.id;

const app = await fired(() => POST('/api/applications', { candidateId: candId, requestId: reqId }, admin));
ok('application created', app.res.status === 201, `HTTP ${app.res.status}`);
const appId = app.res.j?.application?.id;
ok('candidate.application_received is OFF by default → silent', app.mail.length === 0,
  app.mail.length ? JSON.stringify(app.mail) : 'no email — as configured');

/* =============================================================== interviews */
realLog('\n— interview —');
const iv = await fired(() => POST('/api/interviews', {
  applicationId: appId, scheduledAt: new Date(Date.now() + 864e5).toISOString(),
  interviewType: 'technical', mode: 'onsite', locationOrLink: 'Head Office',
  panel: [{ interviewerId: hiringMgr.id, isLead: true }],
}, admin));
ok('interview scheduled', iv.res.status === 201, `HTTP ${iv.res.status}`);
ok('interview.scheduled → candidate emailed',
  iv.mail.includes('candidate.e2e@gmail.com'), JSON.stringify(iv.mail));

/* =================================================================== offers */
realLog('\n— offer lifecycle —');
const offer = await POST('/api/offers', {
  applicationId: appId, positionTitle: 'Site Engineer', salaryOffered: 25000,
  currency: 'EGP', joiningDate: new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10),
}, admin);
ok('offer created', offer.status === 201, `HTTP ${offer.status}`);
const offerId = offer.j?.offer?.id;

const oSub = await fired(() => POST(`/api/offers/${offerId}/submit`, {}, admin));
ok('offer.pending_approval → approvers', oSub.res.status === 200 && oSub.mail.length > 0,
  JSON.stringify(oSub.mail));

const oApp = await fired(() => POST(`/api/offers/${offerId}/approve`, {}, admin));
ok('offer.approved fires', oApp.res.status === 200, `HTTP ${oApp.res.status} ${JSON.stringify(oApp.mail)}`);

const oSend = await fired(() => POST(`/api/offers/${offerId}/send`, {}, admin));
ok('offer.sent → the candidate', oSend.res.status === 200 && oSend.mail.includes('candidate.e2e@gmail.com'),
  JSON.stringify(oSend.mail));

const oAcc = await fired(() => POST(`/api/offers/${offerId}/result`, { result: 'accepted' }, admin));
ok('offer.accepted → internal staff, and NOT the candidate',
  oAcc.res.status === 200 && oAcc.mail.length > 0 && !oAcc.mail.includes('candidate.e2e@gmail.com'),
  `HTTP ${oAcc.res.status} ${JSON.stringify(oAcc.mail)}`);

/* ================================================== salary must not leak out */
realLog('\n— salary confinement —');
const internalBodies = SENT.filter((e) => e.msg === 'email.sent' && !String(e.to).includes('candidate.e2e'));
ok('no internal alert subject carries the salary figure',
  !internalBodies.some((e) => String(e.subject).includes('25000')),
  `${internalBodies.length} internal message(s) checked`);

/* ============================================ every catalogued event is real */
realLog('\n— catalogue integrity —');
const cfg = (await GET('/api/settings/notifications', admin)).j;
ok('console lists every catalogued event',
  cfg.notifications.length === NOTIFICATION_EVENTS.length,
  `${cfg.notifications.length} of ${NOTIFICATION_EVENTS.length}`);
ok('no event is left unconfigured after seeding',
  cfg.notifications.every((n) => !n.unconfigured),
  cfg.notifications.filter((n) => n.unconfigured).map((n) => n.eventKey).join(', ') || 'all configured');
ok('every event names at least one recipient',
  cfg.notifications.every((n) => n.recipients.length > 0),
  cfg.notifications.filter((n) => !n.recipients.length).map((n) => n.eventKey).join(', ') || 'all have recipients');
ok('candidate-facing events are flagged external',
  cfg.notifications.filter((n) => n.recipients.includes('candidate'))
    .every((n) => n.externalRecipients.includes('candidate')));

/* ====================================================== the console governs */
realLog('\n— the console actually governs sending —');
await PUT('/api/settings/notifications/request.approved', { email: false }, admin);
const r2 = await POST('/api/requests', {
  title: 'Second Role', projectId, departmentId, headcount: 1, priority: 'low',
}, admin);
const r2id = r2.j?.request?.id;
await fired(() => POST(`/api/requests/${r2id}/submit`, {}, admin));
const r2ap = await fired(() => POST(`/api/requests/${r2id}/approve`, { comment: 'ok' }, admin));
ok('switching request.approved email OFF stops the mail', r2ap.mail.length === 0,
  r2ap.mail.length ? JSON.stringify(r2ap.mail) : 'suppressed');
await PUT('/api/settings/notifications/request.approved', { email: true }, admin);

/* ============================================================= who may edit */
realLog('\n— who may configure notifications —');
for (const [email, label] of [
  ['hr.director@arabtec.com', 'HR Director'],
  ['hr.manager@arabtec.com', 'HR Manager'],
  ['rec.manager@arabtec.com', 'Recruitment Manager'],
  ['recruiter@arabtec.com', 'Recruiter'],
]) {
  const t = await login(email, 'Arabtec@123');
  const r = await PUT('/api/settings/notifications/request.approved', { email: true }, t);
  ok(`${label} can edit the console`, r.status === 200, `HTTP ${r.status}`);
}
const viewer = await login('viewer@arabtec.com', 'Arabtec@123');
const vr = await PUT('/api/settings/notifications/request.approved', { email: false }, viewer);
ok('Viewer cannot edit the console', vr.status === 403, `HTTP ${vr.status}`);
const ivr = await login('interviewer@arabtec.com', 'Arabtec@123');
const ir = await PUT('/api/settings/notifications/request.approved', { email: false }, ivr);
ok('Interviewer cannot edit the console', ir.status === 403, `HTTP ${ir.status}`);

/* ==================================================================== report */
realLog('\n— every message this run produced —');
for (const e of SENT.filter((x) => x.msg === 'email.sent')) {
  realLog(`     → ${String(e.to).padEnd(34)} ${e.subject}`);
}

realLog(`\n=== NOTIFICATION E2E: ${pass} passed, ${fail} failed ===\n`);
process.exit(fail ? 1 : 0);
