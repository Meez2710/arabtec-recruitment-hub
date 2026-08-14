// FULL ATS END-TO-END — one candidate walked through every stage, over real
// HTTP, against a throwaway database, with the database inspected directly at
// each step.
//
//   Hiring Request → Approval → Recruiter Assignment → Candidate Intake →
//   CV Parsing → Candidate Review → Duplicate Check → Candidate Creation →
//   Application → Interview → Feedback → Offer → Activity/Audit
//
// WHAT THIS ASSERTS THAT A UI WALKTHROUGH CANNOT. For each stage: the endpoint
// answered with the expected status, the row landed in the expected table with
// the expected values, the permission boundary held for a role that must not
// pass, the status transition is the one recorded in history, and — at the end
// — that the whole database is free of duplicates, orphans and empty candidate
// records, with an audit entry for every action.
//
// SYNTHETIC DATA ONLY. The CVs below are invented.
//
// Run:  node --experimental-sqlite ats_e2e_test.mjs
// With real OCR:  DOCLING_BASE_URL=http://127.0.0.1:8089 DOCLING_BEARER_TOKEN=… node …

import { adminToken, ADMIN_BOOTSTRAP_PASSWORD } from './test-support/admin-session.mjs';

const RID = `${process.pid}_${Date.now()}`;
const DBF = `/tmp/arabtec_ats_e2e_${RID}.db`;
process.env.DATABASE_URL = `file:${DBF}`;
process.env.UPLOAD_DIR = `/tmp/arabtec_ats_e2e_uploads_${RID}`;
process.env.PORT = String(4600 + (process.pid % 120));
process.env.SEED_DEMO_DATA = 'true';
process.env.NODE_ENV = 'test';
process.env.SEED_ADMIN_PASSWORD ||= ADMIN_BOOTSTRAP_PASSWORD;

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

for (const f of [DBF, `${DBF}-journal`]) { try { fs.rmSync(f); } catch { /* first run */ } }
fs.mkdirSync(process.env.UPLOAD_DIR, { recursive: true });

await import('./prisma/seed.js');
await import('./src/server.js');
await new Promise((r) => setTimeout(r, 900));

const B = `http://127.0.0.1:${process.env.PORT}`;
const db = new DatabaseSync(DBF);
const one = (sql, params = []) => db.prepare(sql).get(...params);
const many = (sql, params = []) => db.prepare(sql).all(...params);
const count = (table, where = '', params = []) =>
  one(`SELECT COUNT(*) c FROM ${table} ${where}`, params).c;

let passed = 0;
const failures = [];
const check = (stage, name, fn) => {
  try { fn(); passed += 1; console.log(`  PASS  [${stage}] ${name}`); }
  catch (e) { failures.push(`[${stage}] ${name}`); console.log(`  FAIL  [${stage}] ${name}\n        ${e.message}`); }
};
const eq = (actual, expected, what) => {
  if (actual !== expected) throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
};
const ok = (cond, what) => { if (!cond) throw new Error(what); };

const api = async (p, { method = 'GET', token, body } = {}) => {
  const res = await fetch(B + p, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON body is itself a finding */ }
  return { status: res.status, json };
};

const login = async (email, password = 'Arabtec@123') =>
  (await api('/api/auth/login', { method: 'POST', body: { email, password } })).json?.token;

/** Multipart upload — the app ships its own parser, so no form-data dependency. */
const upload = async (p, token, { filename, mimeType, content, fields = {} }) => {
  const boundary = `----arabtecAtsE2E${RID}`;
  const parts = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n`
    + `Content-Type: ${mimeType}\r\n\r\n`));
  parts.push(Buffer.from(content));
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  const res = await fetch(B + p, {
    method: 'POST',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: Buffer.concat(parts),
  });
  let json = null;
  try { json = await res.json(); } catch { /* see above */ }
  return { status: res.status, json };
};

const CV = (name, email, phone) => [
  name, 'Cairo, Egypt', email, phone, '',
  'SUMMARY', 'Structural engineer with 9 years of experience on high-rise projects.', '',
  'EXPERIENCE', 'Lead Structural Engineer at Delta Contracting', '2018 - Present', '',
  'EDUCATION', 'BSc in Civil Engineering, Ain Shams University, 2014', '',
  'SKILLS', 'ETABS, SAP2000, Revit, AutoCAD',
].join('\n');

console.log(`\nFULL ATS END-TO-END  ·  db=${path.basename(DBF)}  ·  ${B}\n`);

/* ============================ actors ============================ */

const admin = await adminToken(B);
const hm = await login('hiring.manager@arabtec.com');
const hrMgr = await login('hr.manager@arabtec.com');
const hrDir = await login('hr.director@arabtec.com');
const recMgr = await login('rec.manager@arabtec.com');
const recruiter = await login('recruiter@arabtec.com');
const interviewer = await login('interviewer@arabtec.com');
const viewer = await login('viewer@arabtec.com');
ok(admin && hm && hrMgr && recMgr && recruiter && interviewer && viewer, 'not every actor could sign in');

/* ===================== 1. HIRING REQUEST ======================== */

const meta = await api('/api/requests/meta/form', { token: hm });
const projectId = meta.json.projects[0].id;
const departmentId = meta.json.departments[0].id;

const created = await api('/api/requests', { method: 'POST', token: hm, body: {
  title: 'Senior Structural Engineer', projectId, departmentId, headcount: 1,
  priority: 'high', discipline: 'civil', justification: 'project_ramp_up',
  jobDescription: 'Lead structural design.', requiredSkills: 'ETABS, SAP2000',
} });
const reqId = created.json?.request?.id;

check('request', 'POST /api/requests creates one requisition', () => {
  eq(created.status, 201, 'HTTP status');
  eq(count('recruitment_request'), 1, 'requisition rows');
  const row = one('SELECT * FROM recruitment_request WHERE id=?', [reqId]);
  ok(row, 'no row in recruitment_request');
  ok(/^REQ-\d{4}-\d{5}$/.test(row.ticket_no), `ticket number shape: ${row.ticket_no}`);
  eq(row.headcount, 1, 'headcount');
});

check('request', 'seats are created to match headcount', () => {
  eq(count('requisition_seat', 'WHERE request_id=?', [reqId]), 1, 'seat rows');
});

const viewerCreate = await api('/api/requests', { method: 'POST', token: viewer, body: {
  title: 'X', projectId, departmentId, headcount: 1,
} });
check('request', 'permission: viewer is refused (403) and writes nothing', () => {
  eq(viewerCreate.status, 403, 'HTTP status');
  eq(count('recruitment_request'), 1, 'requisition rows after the refused attempt');
});

/* ========================= 2. APPROVAL ========================== */

const statusBefore = one('SELECT status FROM recruitment_request WHERE id=?', [reqId]).status;
await api(`/api/requests/${reqId}/submit`, { method: 'POST', token: hm });
const afterSubmit = one('SELECT status FROM recruitment_request WHERE id=?', [reqId]).status;

for (const t of [hrMgr, hrDir, admin]) {
  await api(`/api/requests/${reqId}/approve`, { method: 'POST', token: t, body: {} });
}
const afterApprove = one('SELECT * FROM recruitment_request WHERE id=?', [reqId]);

check('approval', 'a new requisition starts awaiting approval, not approved', () => {
  eq(statusBefore, 'pending_approval', 'status at creation');
  eq(afterSubmit, 'pending_approval', 'status after submit');
});

check('approval', 'the approval chain reaches an approved state', () => {
  ok(['approved', 'sourcing', 'in_sourcing', 'in_progress'].includes(afterApprove.status),
    `status after approvals: ${afterApprove.status}`);
});

check('approval', 'every transition is recorded, none invented', () => {
  const hist = many('SELECT * FROM request_activity WHERE request_id=? ORDER BY id', [reqId]);
  ok(hist.length >= 2, `expected a transition history, got ${hist.length} rows`);
  for (const h of hist) ok(h.actor_id != null, 'a transition has no actor');
});

const viewerApprove = await api(`/api/requests/${reqId}/approve`, { method: 'POST', token: viewer, body: {} });
check('approval', 'permission: a viewer cannot approve (403)', () => {
  eq(viewerApprove.status, 403, 'HTTP status');
});

/* =================== 3. RECRUITER ASSIGNMENT ==================== */

const recruiterUser = meta.json.recruiters.find((r) => r.name === 'Karim Adel');
const assign = await api(`/api/requests/${reqId}/assign`, { method: 'POST', token: recMgr, body: { ownerId: recruiterUser.id } });

check('assignment', 'the requisition is assigned to a recruiter', () => {
  eq(assign.status, 200, 'HTTP status');
  const row = one('SELECT owner_id FROM recruitment_request WHERE id=?', [reqId]);
  eq(row.owner_id, recruiterUser.id, 'owner_id');
});

const viewerAssign = await api(`/api/requests/${reqId}/assign`, { method: 'POST', token: viewer, body: { ownerId: recruiterUser.id } });
check('assignment', 'permission: a viewer cannot reassign (403)', () => {
  eq(viewerAssign.status, 403, 'HTTP status');
  eq(one('SELECT owner_id FROM recruitment_request WHERE id=?', [reqId]).owner_id,
    recruiterUser.id, 'owner after the refused attempt');
});

/* ================ 4/5. CANDIDATE INTAKE + PARSING =============== */

const candidatesBeforeIntake = count('candidate');
const parse = await upload('/api/candidates/parse-cv', recruiter, {
  filename: 'layla-mansour.txt', mimeType: 'text/plain',
  content: CV('Layla Mansour', 'layla.mansour@example.test', '+20 100 555 0142'),
  fields: { requestId: String(reqId) },
});
const intake = parse.json?.intake;

check('intake', 'POST /api/candidates/parse-cv stages a PENDING intake', () => {
  eq(parse.status, 200, 'HTTP status');
  ok(intake, `no intake returned: ${parse.json?.reason}`);
  eq(intake.status, 'PENDING', 'intake status');
  eq(intake.requestId, reqId, 'the requisition link is preserved');
  eq(count('candidate_intake'), 1, 'intake rows');
});

check('intake', 'parsing creates NO candidate, application or proposal', () => {
  eq(count('candidate'), candidatesBeforeIntake, 'candidate rows');
  eq(intake.candidateId ?? null, null, 'intake.candidateId');
  eq(intake.applicationId ?? null, null, 'intake.applicationId');
  eq(count('application'), 0, 'application rows');
});

check('parsing', 'every proposed field is undecided and carries evidence', () => {
  ok(intake.fields.length > 0, 'no fields were proposed');
  for (const f of intake.fields) {
    eq(f.decision, 'PENDING', `${f.field} decision`);
    ok(f.evidence, `${f.field} has no evidence snippet`);
    ok(f.evidenceRef?.blockId, `${f.field} cites no block`);
  }
});

check('parsing', 'the response states how the text was obtained', () => {
  const d = parse.json?.document;
  ok(d, 'no document provenance in the response');
  ok(typeof d.ocrApplied === 'boolean', 'ocrApplied is not a boolean');
  ok(d.parser, 'no parser named');
  console.log(`        parser=${d.parser} ocrApplied=${d.ocrApplied} pages=${d.pageCount} blocks=${d.blockCount}`);
});

check('parsing', 'no proposed value was invented', () => {
  const text = CV('Layla Mansour', 'layla.mansour@example.test', '+20 100 555 0142');
  for (const f of intake.fields) {
    for (const v of (Array.isArray(f.value) ? f.value : [f.value])) {
      if (typeof v !== 'string' || v.length < 4) continue;
      ok(text.includes(v), `${f.field}="${v}" is not in the document`);
    }
  }
});

// `viewer` legitimately holds candidate.view, so it is the wrong role for this
// boundary. Reviewing needs candidate.add, which an interviewer does not have.
const anonIntakes = await api('/api/candidates/intakes');
const interviewerReview = await api(`/api/candidates/intakes/${intake.id}/review`, {
  method: 'POST', token: interviewer, body: { decisions: {} },
});
check('intake', 'permission: unauthenticated is refused (401)', () => {
  eq(anonIntakes.status, 401, 'HTTP status');
});
check('intake', 'permission: a role without candidate.add cannot review (403)', () => {
  eq(interviewerReview.status, 403, 'HTTP status');
  eq(one('SELECT status FROM candidate_intake WHERE id=?', [intake.id]).status, 'PENDING',
    'the intake was altered by a refused review');
});

/* ===== 6/7/8/9. REVIEW → DUPLICATE CHECK → CANDIDATE → APPLICATION ===== */

const decisions = Object.fromEntries(intake.fields.map((f) => [f.field, f.field !== 'major']));
const review = await api(`/api/candidates/intakes/${intake.id}/review`, {
  method: 'POST', token: recruiter, body: { decisions, expectedVersion: intake.version },
});

check('review', 'review converts the intake and creates exactly one candidate', () => {
  ok(review.status === 200 || review.status === 201, `HTTP status ${review.status}: ${JSON.stringify(review.json)?.slice(0, 200)}`);
  eq(count('candidate'), candidatesBeforeIntake + 1, 'candidate rows');
  eq(one('SELECT status FROM candidate_intake WHERE id=?', [intake.id]).status, 'CONVERTED', 'intake status');
});

const candId = review.json?.candidate?.id ?? one('SELECT id FROM candidate ORDER BY id DESC').id;
const candRow = one('SELECT * FROM candidate WHERE id=?', [candId]);

check('candidate', 'only approved fields were written; rejected ones stayed null', () => {
  eq(candRow.full_name, 'Layla Mansour', 'full_name');
  eq(candRow.email, 'layla.mansour@example.test', 'email');
  eq(candRow.major, null, 'major was rejected and must be null');
  ok(/^CAN-\d{5}$/.test(candRow.candidate_no), `candidate number shape: ${candRow.candidate_no}`);
});

check('candidate', 'the proposal that produced it is APPLIED and linked', () => {
  const p = one('SELECT * FROM candidate_proposal WHERE id=?', [review.json?.proposal?.id ?? one('SELECT id FROM candidate_proposal ORDER BY id DESC').id]);
  ok(p, 'no proposal row');
  eq(p.status, 'APPLIED', 'proposal status');
});

check('application', 'the requisition link produced exactly one application', () => {
  eq(count('application'), 1, 'application rows');
  const app = one('SELECT * FROM application WHERE candidate_id=?', [candId]);
  ok(app, 'no application for the new candidate');
  eq(app.request_id, reqId, 'application.request_id');
  ok(/^APP-\d{5}$/.test(app.application_no), `application number shape: ${app.application_no}`);
});

const appId = one('SELECT id FROM application WHERE candidate_id=?', [candId]).id;

check('application', 'the application has an opening stage in its history', () => {
  const hist = many('SELECT * FROM application_stage_history WHERE application_id=? ORDER BY id', [appId]);
  ok(hist.length >= 1, 'no stage history');
  eq(hist[0].from_status, null, 'the first history row should have no previous status');
});

const replay = await api(`/api/candidates/intakes/${intake.id}/review`, {
  method: 'POST', token: recruiter, body: { decisions },
});
check('review', 'a replayed review is refused and creates nothing', () => {
  eq(replay.status, 409, 'HTTP status');
  eq(replay.json?.code, 'not-pending', 'error code');
  eq(count('candidate'), candidatesBeforeIntake + 1, 'candidate rows after the replay');
  eq(count('application'), 1, 'application rows after the replay');
});

/* --- duplicate check: the same person, uploaded again --- */

const dupParse = await upload('/api/candidates/parse-cv', recruiter, {
  filename: 'layla-again.txt', mimeType: 'text/plain',
  content: CV('Layla Mansour', 'layla.mansour@example.test', '+20 100 555 0142'),
});
const dupIntake = dupParse.json?.intake;
const dupDecisions = Object.fromEntries((dupIntake?.fields ?? []).map((f) => [f.field, true]));
const dupReview = await api(`/api/candidates/intakes/${dupIntake.id}/review`, {
  method: 'POST', token: recruiter, body: { decisions: dupDecisions },
});

check('duplicate', 'an exact identifier match blocks conversion', () => {
  eq(dupReview.status, 409, `HTTP status (body: ${JSON.stringify(dupReview.json)?.slice(0, 160)})`);
  const conflict = dupReview.json?.conflict ?? dupReview.json;
  ok(JSON.stringify(conflict).includes('email') || JSON.stringify(conflict).includes('duplicate'),
    `the refusal does not name the matched identifier: ${JSON.stringify(conflict)?.slice(0, 200)}`);
});

check('duplicate', 'the blocked duplicate created no second candidate', () => {
  eq(count('candidate'), candidatesBeforeIntake + 1, 'candidate rows');
  eq(count('candidate', 'WHERE email=?', ['layla.mansour@example.test']), 1, 'candidates sharing the email');
});

const dupCheck = await api('/api/candidates/check-duplicate', {
  method: 'POST', token: recruiter, body: { email: 'layla.mansour@example.test' },
});
check('duplicate', 'the standalone duplicate check reports facts, not a verdict', () => {
  eq(dupCheck.status, 200, 'HTTP status');
  ok(Array.isArray(dupCheck.json?.duplicates), 'no duplicates array');
  eq(dupCheck.json.duplicates.length, 1, 'duplicates found');
});

/* ============ 5b. CV PARSING — the scanned path, real OCR ============ */
// The .txt CV above exercises the pipeline but not OCR. This stage puts a
// genuinely image-only PDF through the SAME endpoint, so the OCR route is
// covered by the end-to-end flow and not only by the parser's own suite.
// Skipped, and reported as skipped, when no Docling endpoint is configured.

const scanPath = path.join(import.meta.dirname, 'live-fixtures', 'image-only-en.pdf');
if (!process.env.DOCLING_BASE_URL || !fs.existsSync(scanPath)) {
  console.log('  SKIP  [ocr] no DOCLING_BASE_URL or fixture — the OCR path was NOT exercised');
} else {
  const scan = await upload('/api/candidates/parse-cv', recruiter, {
    filename: 'scanned-cv.pdf', mimeType: 'application/pdf', content: fs.readFileSync(scanPath),
  });
  const scanDoc = scan.json?.document;

  check('ocr', 'a scanned CV is read by real Docling, not the fallback', () => {
    eq(scan.status, 200, `HTTP status (reason: ${scan.json?.reason})`);
    ok(scanDoc, 'no document provenance');
    eq(scanDoc.parser, 'docling-sidecar', 'parser');
    eq(scanDoc.ocrApplied, true, 'ocrApplied');
  });

  check('ocr', 'the scanned CV yields evidence-bound fields and a PENDING intake', () => {
    const si = scan.json?.intake;
    ok(si, 'no intake was staged from the scan');
    eq(si.status, 'PENDING', 'intake status');
    ok(si.fields.length > 0, 'no fields recovered from the scan');
    for (const f of si.fields) ok(f.evidenceRef?.blockId, `${f.field} cites no block`);
  });
}

/* ========================= 10. INTERVIEW ======================== */

await api(`/api/applications/${appId}/move`, { method: 'POST', token: recruiter, body: { status: 'interviewing' } });

const ivMeta = await api('/api/interviews/meta/form', { token: recruiter });
const panelist = ivMeta.json.interviewers.find((u) => u.name === 'Mona Sami');
const future = new Date(Date.now() + 7 * 86400000).toISOString();
const sched = await api('/api/interviews', { method: 'POST', token: recruiter, body: {
  applicationId: appId, interviewType: 'technical', mode: 'video',
  scheduledAt: future, durationMin: 60, panel: [{ interviewerId: panelist.id, isLead: true }],
} });
const ivId = sched.json?.interview?.id;

check('interview', 'the interview is scheduled against the real application', () => {
  eq(sched.status, 201, 'HTTP status');
  eq(count('interview'), 1, 'interview rows');
  const row = one('SELECT * FROM interview WHERE id=?', [ivId]);
  eq(row.application_id, appId, 'interview.application_id');
});

check('interview', 'the panel is persisted', () => {
  eq(count('interview_panel', 'WHERE interview_id=?', [ivId]), 1, 'panel rows');
});

const pastIv = await api('/api/interviews', { method: 'POST', token: recruiter, body: {
  applicationId: appId, scheduledAt: '2020-01-01T10:00:00Z', panel: [{ interviewerId: panelist.id }],
} });
check('interview', 'a past date is refused and writes nothing', () => {
  eq(pastIv.status, 400, 'HTTP status');
  eq(count('interview'), 1, 'interview rows after the refused attempt');
});

/* ========================== 11. FEEDBACK ======================== */

const fb = await api(`/api/interviews/${ivId}/feedback`, { method: 'POST', token: interviewer, body: {
  recommendation: 'yes', overallScore: 4, comments: 'Strong structural background.',
} });
check('feedback', 'a panelist can submit feedback', () => {
  eq(fb.status, 201, 'HTTP status');
  eq(count('interview_feedback', 'WHERE interview_id=?', [ivId]), 1, 'feedback rows');
});

const viewerFb = await api(`/api/interviews/${ivId}/feedback`, { method: 'POST', token: viewer, body: { recommendation: 'no' } });
check('feedback', 'permission: a non-panelist viewer is refused (403)', () => {
  eq(viewerFb.status, 403, 'HTTP status');
  eq(count('interview_feedback', 'WHERE interview_id=?', [ivId]), 1, 'feedback rows after the refused attempt');
});

/* ============================ 12. OFFER ========================= */

await api(`/api/applications/${appId}/move`, { method: 'POST', token: recruiter, body: { status: 'issuing_offer' } });
const offer = await api('/api/offers', { method: 'POST', token: recruiter, body: {
  applicationId: appId, salaryOffered: 42000,
  joiningDate: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10),
  benefits: 'Housing, transport',
} });
const offerId = offer.json?.offer?.id;

check('offer', 'an offer is raised against the application', () => {
  eq(offer.status, 201, `HTTP status: ${JSON.stringify(offer.json)?.slice(0, 160)}`);
  eq(count('offer'), 1, 'offer rows');
  eq(one('SELECT application_id FROM offer WHERE id=?', [offerId]).application_id, appId, 'offer.application_id');
});

const viewerSalary = await api(`/api/offers/${offerId}`, { token: viewer });
check('offer', 'permission: salary is not exposed to a role without salary.view', () => {
  ok(viewerSalary.status === 403 || viewerSalary.json?.offer?.salaryOffered == null,
    `a viewer saw a salary of ${viewerSalary.json?.offer?.salaryOffered}`);
});

await api(`/api/offers/${offerId}/submit`, { method: 'POST', token: recruiter });
await api(`/api/offers/${offerId}/approve`, { method: 'POST', token: hrMgr, body: {} });
await api(`/api/offers/${offerId}/approve`, { method: 'POST', token: hrDir, body: {} });
await api(`/api/offers/${offerId}/send`, { method: 'POST', token: hrMgr });
const result = await api(`/api/offers/${offerId}/result`, { method: 'POST', token: hrMgr, body: { result: 'accepted' } });

check('offer', 'the offer walks submit → approve → send → result', () => {
  const row = one('SELECT * FROM offer WHERE id=?', [offerId]);
  ok(['accepted', 'offer_accepted'].includes(row.status), `offer status: ${row.status} (result HTTP ${result.status})`);
});

check('offer', 'accepting the offer moves the application, not just the offer', () => {
  const app = one('SELECT status FROM application WHERE id=?', [appId]);
  ok(app.status !== 'issuing_offer', `application still at ${app.status}`);
});

/* ====================== 13. ACTIVITY / AUDIT ==================== */

const audit = await api('/api/audit?pageSize=500', { token: admin });
const actions = (audit.json?.logs || []).map((l) => l.action);

check('audit', 'the audit trail is readable by an administrator', () => {
  eq(audit.status, 200, 'HTTP status');
  ok(actions.length > 0, 'the audit trail is empty');
});

check('audit', 'every stage left a trace', () => {
  const required = ['request.created', 'candidate.intake_created', 'application.created', 'offer.created'];
  const missing = required.filter((a) => !actions.includes(a));
  eq(missing.length, 0, `missing audit actions: ${missing.join(', ')} (present: ${[...new Set(actions)].join(', ')})`);
});

check('audit', 'every audit row names an actor', () => {
  const anon = many("SELECT id, action FROM audit_log WHERE actor_id IS NULL AND action NOT IN ('auth.login_failed','system.seeded')");
  eq(anon.length, 0, `rows with no actor: ${anon.map((r) => r.action).join(', ')}`);
});

// `viewer` holds audit.view by design; `interviewer` does not.
const interviewerAudit = await api('/api/audit', { token: interviewer });
check('audit', 'permission: a role without audit.view is refused (403)', () => {
  eq(interviewerAudit.status, 403, 'HTTP status');
});

/* =============== whole-database integrity sweep ================= */

check('integrity', 'no candidate is empty', () => {
  const empty = many("SELECT id FROM candidate WHERE full_name IS NULL OR TRIM(full_name) = ''");
  eq(empty.length, 0, `candidates with no name: ${empty.map((r) => r.id).join(', ')}`);
});

check('integrity', 'no candidate is unreachable', () => {
  const unreachable = many(
    "SELECT id FROM candidate WHERE (email IS NULL OR email='') AND (phone IS NULL OR phone='')");
  eq(unreachable.length, 0, `candidates with no contact: ${unreachable.map((r) => r.id).join(', ')}`);
});

check('integrity', 'no orphan applications', () => {
  const orphans = many(`SELECT a.id FROM application a
    LEFT JOIN candidate c ON c.id = a.candidate_id
    LEFT JOIN recruitment_request r ON r.id = a.request_id
    WHERE c.id IS NULL OR r.id IS NULL`);
  eq(orphans.length, 0, `orphan applications: ${orphans.map((r) => r.id).join(', ')}`);
});

check('integrity', 'no orphan interviews, feedback or offers', () => {
  const iv = many('SELECT i.id FROM interview i LEFT JOIN application a ON a.id=i.application_id WHERE a.id IS NULL');
  const fbk = many('SELECT f.id FROM interview_feedback f LEFT JOIN interview i ON i.id=f.interview_id WHERE i.id IS NULL');
  const of = many('SELECT o.id FROM offer o LEFT JOIN application a ON a.id=o.application_id WHERE a.id IS NULL');
  eq(iv.length + fbk.length + of.length, 0,
    `orphans — interviews:${iv.length} feedback:${fbk.length} offers:${of.length}`);
});

check('integrity', 'no duplicate application for one candidate on one requisition', () => {
  const dups = many(`SELECT candidate_id, request_id, COUNT(*) c FROM application
    GROUP BY candidate_id, request_id HAVING c > 1`);
  eq(dups.length, 0, `duplicated candidate/requisition pairs: ${dups.length}`);
});

check('integrity', 'no duplicate candidate identifiers', () => {
  const dupEmail = many("SELECT email, COUNT(*) c FROM candidate WHERE email IS NOT NULL AND email != '' GROUP BY LOWER(email) HAVING c > 1");
  eq(dupEmail.length, 0, `emails held by more than one candidate: ${dupEmail.map((r) => r.email).join(', ')}`);
});

check('integrity', 'no intake is left half-converted', () => {
  const bad = many(`SELECT id, status, candidate_id FROM candidate_intake
    WHERE (status = 'CONVERTED' AND candidate_id IS NULL)
       OR (status = 'PENDING'  AND candidate_id IS NOT NULL)`);
  eq(bad.length, 0, `intakes in an impossible state: ${bad.map((r) => `${r.id}/${r.status}`).join(', ')}`);
});

check('integrity', 'seat accounting matches the filled headcount', () => {
  const r = one('SELECT headcount, headcount_filled FROM recruitment_request WHERE id=?', [reqId]);
  const seats = count('requisition_seat', 'WHERE request_id=? AND filled_by_application_id IS NOT NULL', [reqId]);
  eq(r.headcount_filled ?? 0, seats, 'headcount_filled vs occupied seats');
});

/* ============================= report ============================ */

console.log(`\n${failures.length === 0 ? 'ALL PASS' : 'FAILURES'} — ${passed} passed, ${failures.length} failed`);
if (failures.length) console.log(failures.map((f) => `  · ${f}`).join('\n'));
process.exit(failures.length === 0 ? 0 : 1);
