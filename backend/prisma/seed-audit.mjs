// Synthetic dataset for the ONLINE AUDIT / UAT environment.
//
// SYNTHETIC ONLY. Every person, CV and company below is invented for this
// environment. No real candidate data, no customer data, and nothing copied
// from a production database ever belongs in this file.
//
// WHY IT DRIVES THE HTTP API rather than inserting rows. An auditor is judging
// recruitment logic, so the data they audit has to have been produced BY that
// logic: a request reaches `sourcing` by being submitted and approved, an
// application reaches `interviewing` by legal stage transitions, and a
// duplicate is a duplicate because the domain classified it as one. Raw
// inserts would let this script fabricate states the product cannot actually
// reach, and the audit would be of the fixture rather than the application.
//
// Idempotent-ish: it detects an already-seeded environment and stops rather
// than stacking a second copy of the dataset.
//
// Usage (server must already be running):
//   AUDIT_BASE_URL=http://localhost:4173 node prisma/seed-audit.mjs

const BASE = process.env.AUDIT_BASE_URL || 'http://localhost:4173';
const PW = process.env.AUDIT_DEMO_PASSWORD || 'Arabtec@123';

let failures = 0;
const log = (m) => console.log(`  ${m}`);
const warn = (m) => { failures += 1; console.log(`  ! ${m}`); };

async function login(email) {
  const r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PW }),
  });
  const d = await r.json().catch(() => ({}));
  if (!d.token) throw new Error(`cannot sign in as ${email} (${r.status})`);
  return d.token;
}

const call = async (token, path, { method = 'GET', body } = {}) => {
  const r = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let d = null; try { d = await r.json(); } catch { /* empty body */ }
  return { status: r.status, body: d };
};

/** Create a request and walk it to `sourcing` through the real approval chain. */
async function approvedRequest(hr, dir, fields) {
  const c = await call(hr, '/api/requests', { method: 'POST', body: fields });
  const id = c.body?.request?.id;
  if (!id) throw new Error(`request create failed: ${JSON.stringify(c.body)}`);
  await call(hr, `/api/requests/${id}/submit`, { method: 'POST', body: {} });
  let a = await call(dir, `/api/requests/${id}/approve`, { method: 'POST', body: {} });
  if (a.status !== 200) a = await call(hr, `/api/requests/${id}/approve`, { method: 'POST', body: {} });
  return { id, ticketNo: c.body.request.ticketNo, approved: a.status === 200 };
}

const candidate = async (hr, fields) => {
  const r = await call(hr, '/api/candidates', { method: 'POST', body: fields });
  if (!r.body?.candidate) throw new Error(`candidate create failed: ${JSON.stringify(r.body)}`);
  return r.body.candidate;
};

const linkTo = async (hr, candidateId, requestId) =>
  call(hr, '/api/applications', { method: 'POST', body: { candidateId, requestId } });

/** Walk an application forward one legal stage at a time. */
async function advance(hr, applicationId, stages) {
  for (const status of stages) {
    const m = await call(hr, `/api/applications/${applicationId}/move`, {
      method: 'POST', body: { status, reason: 'audit dataset' },
    });
    if (m.status !== 200) { warn(`move -> ${status}: ${m.body?.error}`); return false; }
  }
  return true;
}

/* ------------------------------------------------------------------ */

console.log('\nArabtec ATS — seeding the ONLINE AUDIT dataset (synthetic only)\n');
console.log(`  target: ${BASE}\n`);

const hr = await login('hr.manager@arabtec.com');
const dir = await login('hr.director@arabtec.com');
const panel = await login('interviewer@arabtec.com');
log('signed in as HR manager, HR director and interviewer');

// Stop rather than stack a second dataset on top of an existing one.
const existing = await call(hr, '/api/requests');
if ((existing.body?.requests || []).some((r) => /Audit/i.test(r.title || ''))) {
  console.log('\n  Audit dataset already present — nothing to do.\n');
  process.exit(0);
}

/* ---------------------------- hiring requests ---------------------- */

// 1. Open + approved, and the one that carries the pipeline.
const civil = await approvedRequest(hr, dir, {
  title: 'Senior Civil Engineer (Audit)', departmentId: 2, projectId: 1,
  headcount: 2, priority: 'high',
});
await call(hr, `/api/requests/${civil.id}/assign`, { method: 'POST', body: { ownerId: 5 } });
log(`approved + assigned: ${civil.ticketNo} Senior Civil Engineer`);

// 2. A second approved request, so one candidate can plausibly fit two.
const planning = await approvedRequest(hr, dir, {
  title: 'Planning Engineer (Audit)', departmentId: 4, projectId: 1,
  headcount: 1, priority: 'medium',
});
log(`approved: ${planning.ticketNo} Planning Engineer`);

// 3. Awaiting approval — shows the pending-approval state.
const qs = await call(hr, '/api/requests', { method: 'POST', body: {
  title: 'Quantity Surveyor (Audit)', departmentId: 2, projectId: 2, headcount: 1, priority: 'low',
} });
await call(hr, `/api/requests/${qs.body.request.id}/submit`, { method: 'POST', body: {} });
log(`awaiting approval: ${qs.body.request.ticketNo} Quantity Surveyor`);

// 4. Cancelled — proves a closed requisition refuses new candidate links.
const mep = await approvedRequest(hr, dir, {
  title: 'MEP Coordinator (Audit)', departmentId: 3, projectId: 3, headcount: 1, priority: 'low',
});
await call(hr, `/api/requests/${mep.id}/cancel`, {
  method: 'POST', body: { reason: 'Audit dataset: scope withdrawn by the project.' },
});
log(`cancelled: ${mep.ticketNo} MEP Coordinator`);

/* ------------------------------- candidates ------------------------ */

// A. One request, taken all the way to an offer.
const ahmed = await candidate(hr, {
  fullName: 'Ahmed Samir', email: 'ahmed.samir@example.test', phone: '+20 100 555 7788',
  currentPosition: 'Senior Civil Engineer', currentCompany: 'Example Construction',
  yearsExperience: 8, location: 'Cairo, Egypt', university: 'Cairo University',
  major: 'Civil Engineering', graduationYear: 2016, source: 'referral',
});
const ahmedApp = await linkTo(hr, ahmed.id, civil.id);
const ahmedAppId = ahmedApp.body?.application?.id;
log(`candidate with one request: ${ahmed.candidateNo} Ahmed Samir -> ${civil.ticketNo}`);

// B. Two applicable requests — the Talent Pool shows both relationships.
const mona = await candidate(hr, {
  fullName: 'Mona Hassan', email: 'mona.hassan@example.test', phone: '+20 111 222 3344',
  currentPosition: 'Planning Engineer', currentCompany: 'Example Contracting',
  yearsExperience: 10, location: 'Cairo, Egypt', university: 'Ain Shams University',
  major: 'Civil Engineering', graduationYear: 2014, source: 'linkedin',
});
await linkTo(hr, mona.id, planning.id);
await linkTo(hr, mona.id, civil.id);
log(`candidate on two requests: ${mona.candidateNo} Mona Hassan`);

// C. Unlinked — the "Link to Request" path an auditor should exercise.
const youssef = await candidate(hr, {
  fullName: 'Youssef Nabil', email: 'youssef.nabil@example.test', phone: '+20 128 555 1212',
  currentPosition: 'Site Engineer', currentCompany: 'Example Builders',
  yearsExperience: 5, location: 'Giza, Egypt', source: 'careers_site',
});
log(`candidate with no request: ${youssef.candidateNo} Youssef Nabil`);

// D. Exact duplicate — same email AND phone as Ahmed, so the identifiers the
// domain treats as exact both collide. Creating it deliberately exercises the
// override path (overrideDuplicate + a reason, and candidate.merge), which is
// itself part of what the auditor should see.
const dup = await call(hr, '/api/candidates', { method: 'POST', body: {
  fullName: 'A. Samir', email: 'ahmed.samir@example.test', phone: '+20 100 555 7788',
  currentPosition: 'Civil Engineer', yearsExperience: 8, location: 'Cairo, Egypt',
  overrideDuplicate: true,
  overrideReason: 'Audit dataset: deliberate exact-duplicate example for duplicate-handling review.',
} });
if (dup.body?.candidate) log(`exact-duplicate example: ${dup.body.candidate.candidateNo} (email + phone match ${ahmed.candidateNo})`);
else log(`exact-duplicate example refused by the duplicate guard (${dup.body?.error}) — the guard itself is the demonstration`);

// E. Name-only match — same name, different identifiers. Amber, non-blocking.
const namesake = await candidate(hr, {
  fullName: 'Ahmed Samir', email: 'ahmed.samir.2@example.test', phone: '+20 155 999 8888',
  currentPosition: 'Structural Engineer', currentCompany: 'Example Engineering',
  yearsExperience: 4, location: 'Alexandria, Egypt', source: 'agency',
});
log(`name-only match example: ${namesake.candidateNo} (same name as ${ahmed.candidateNo}, different identifiers)`);

/* -------------------- execution: pipeline, interview, offer -------- */

if (ahmedAppId) {
  await advance(hr, ahmedAppId, ['matched', 'interviewing']);
  log('pipeline: Ahmed Samir moved sourced -> matched -> interviewing');

  const iv = await call(hr, '/api/interviews', { method: 'POST', body: {
    applicationId: ahmedAppId, interviewType: 'technical', mode: 'video', round: 1,
    scheduledAt: new Date(Date.now() + 2 * 86400000).toISOString(), durationMin: 60,
    panel: [{ interviewerId: 8 }], locationOrLink: 'https://meet.example.test/audit-demo',
  } });
  const ivId = iv.body?.interview?.id;
  if (ivId) {
    log(`interview scheduled: ${iv.body.interview.interviewNo}`);
    const fb = await call(panel, `/api/interviews/${ivId}/feedback`, { method: 'POST', body: {
      recommendation: 'yes', overallScore: 4,
      comments: 'Audit dataset: strong structural fundamentals; communicates clearly. '
        + 'Would benefit from deeper exposure to post-tension design.',
    } });
    if (fb.status === 200 || fb.status === 201) log('interview feedback recorded by the panel member');
    else warn(`feedback: ${fb.body?.error}`);
  } else { warn(`interview: ${iv.body?.error}`); }

  const offer = await call(hr, '/api/offers', { method: 'POST', body: {
    applicationId: ahmedAppId, positionTitle: 'Senior Civil Engineer',
    salaryOffered: 52000, currency: 'EGP',
    joiningDate: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10),
  } });
  if (offer.body?.offer) log(`offer raised: ${offer.body.offer.offerNo}`);
  else warn(`offer: ${offer.body?.error}`);
} else {
  warn(`could not link Ahmed to ${civil.ticketNo}: ${ahmedApp.body?.error}`);
}

/* ---------------------------------- summary ------------------------ */

const reqs = (await call(hr, '/api/requests')).body?.requests || [];
const cands = (await call(hr, '/api/candidates?pageSize=200')).body?.candidates || [];
console.log('\n  ------------------------------------------------------------');
console.log(`  requests: ${reqs.length}   candidates: ${cands.length}`);
console.log(`  ${failures === 0 ? 'Audit dataset seeded.' : `Seeded with ${failures} warning(s) — see above.`}`);
console.log('  Synthetic data only. No real candidate information.\n');
process.exit(0);
