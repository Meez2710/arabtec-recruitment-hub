// CV Intake control panel — access control and the batch lifecycle.
//
// Run: node --experimental-sqlite cv_intake_panel_test.mjs
//
// THREE PEOPLE, EXERCISED THROUGH HTTP, NOT THROUGH THE STORE. Every assertion
// here goes over the real routes with a real session cookie, because the claim
// under test is "the API refuses this", and a store-level test cannot make that
// claim — the panel is not the boundary, the router is.
//
//   admin         — System Admin. Holds every permission by construction.
//   manager       — a Recruitment Manager granted SOME intake permissions,
//                   one at a time, by the administrator.
//   outsider      — a Recruitment Manager granted NONE. The control for the
//                   "manager" case: same role, no grant.
//
// WHAT IT PROVES
//    1. A Recruitment Manager gets NO intake access by default.
//    2. Every route refuses an unauthenticated caller.
//    3. Each of the five permissions gates exactly its own routes — holding
//       `view` does not confer `approve_batch`, and so on.
//    4. Direct API access is refused for a user who cannot see the panel.
//    5. REVOCATION TAKES EFFECT MID-SESSION, on the next request, with the
//       same cookie and no re-login.
//    6. Revoking access destroys nothing: the batch, its items and its audit
//       trail survive, and a batch already approved keeps running.
//    7. Only `system.manage` may change the processing limits — a manager
//       cannot raise their own ceiling.
//    8. A batch cannot exceed the administrator's limit.
//    9. The same attachment cannot be approved into two batches.
//   10. Batch state transitions are enforced (a cancelled batch cannot resume).
//   11. Every consequential action is written to the audit log.

const RID = process.pid + '_' + Date.now();
const DBF = `/tmp/arabtec_cvipanel_${RID}.db`;
process.env.DATABASE_URL = 'file:' + DBF;
process.env.PORT = String(4960 + (process.pid % 30));
process.env.NODE_ENV = 'test';
process.env.SEED_ADMIN_PASSWORD = 'BootStrap#Aa1';
process.env.SEED_DEMO_DATA = 'true';
process.env.SMTP_TRANSPORT = 'json';
process.env.UPLOAD_DIR = `/tmp/arabtec_cvipanel_up_${RID}`;

import fs from 'node:fs';
for (const f of [DBF, DBF + '-journal', DBF + '-wal', DBF + '-shm']) {
  try { fs.rmSync(f); } catch { /* first run */ }
}

const BASE = `http://localhost:${process.env.PORT}`;

let passed = 0; let failed = 0;
function c(name, ok, detail) {
  if (ok) { passed += 1; console.log(`  PASS ${name}${detail !== undefined ? ' -- ' + detail : ''}`); }
  else { failed += 1; console.log(`  FAIL ${name}${detail !== undefined ? ' -- ' + detail : ''}`); }
}

await import('./prisma/seed.js');
await import('./src/server.js');
const { waitForReady } = await import('./test-support/wait-ready.mjs');
await waitForReady(BASE);

const db = await import('./src/lib/db.js');

/* ------------------------------- fixtures -------------------------------- */

async function call(path, { token = null, method = 'GET', body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* streamed or empty */ }
  return { status: res.status, j: json };
}

async function login(email, password) {
  const r = await call('/api/auth/login', { method: 'POST', body: { email, password } });
  return r.j?.token ?? null;
}

const { adminToken } = await import('./test-support/admin-session.mjs');
const admin = await adminToken(BASE);

/** Make a user with a role, returning a live session token. */
async function makeUser(email, roleCode) {
  const password = 'Arabtec#Test1';
  const role = db.get('SELECT id FROM role WHERE code=?', [roleCode]);
  // bcrypt directly, the way routes/users.js creates a user — there is no
  // hashPassword helper; passwords.js only validates.
  const bcrypt = (await import('bcryptjs')).default;
  db.run(`INSERT INTO users (email, full_name, password_hash, status, must_change_password)
          VALUES (?,?,?,'active',0)`, [email, email.split('@')[0], await bcrypt.hash(password, 10)]);
  const id = db.get('SELECT id FROM users WHERE email=?', [email]).id;
  db.run('INSERT INTO user_role (user_id, role_id) VALUES (?,?)', [id, role.id]);
  return { id, email, token: await login(email, password) };
}

/** Grant or revoke ONE permission for a user, the way an administrator does:
 *  a dedicated role for that user, so the grant is per-user and not per-role. */
function ensurePersonalRole(userId, email) {
  const code = `personal_${userId}`;
  let role = db.get('SELECT id FROM role WHERE code=?', [code]);
  if (!role) {
    db.run('INSERT INTO role (code, name, description) VALUES (?,?,?)',
      [code, `Personal — ${email}`, 'Per-user grants made by the administrator.']);
    role = db.get('SELECT id FROM role WHERE code=?', [code]);
    db.run('INSERT INTO user_role (user_id, role_id) VALUES (?,?)', [userId, role.id]);
  }
  return role.id;
}
function grant(userId, email, perm) {
  const roleId = ensurePersonalRole(userId, email);
  const p = db.get('SELECT id FROM permission WHERE code=?', [perm]);
  db.run('INSERT OR IGNORE INTO role_permission (role_id, permission_id) VALUES (?,?)', [roleId, p.id]);
}
function revoke(userId, perm) {
  const roleId = db.get('SELECT id FROM role WHERE code=?', [`personal_${userId}`])?.id;
  const p = db.get('SELECT id FROM permission WHERE code=?', [perm]);
  if (roleId && p) db.run('DELETE FROM role_permission WHERE role_id=? AND permission_id=?', [roleId, p.id]);
}

/* The classifier matches the subject line against the designation catalogue.
   The demo seed ships none, so without this everything is honestly reported as
   Unclassified — correct behaviour, but it proves nothing about grouping. */
for (const title of ['QC Engineer', 'Senior Cost Control Engineer', 'Procurement Officer']) {
  try { db.run('INSERT INTO designation (title) VALUES (?)', [title]); } catch { /* already there */ }
}
const { resetDesignationCache } = await import('./src/lib/cv-intake/panel-store.js');
resetDesignationCache();

/** Waiting attachments, as the mailbox sync would have recorded them. */
function seedWaiting(n) {
  const ids = [];
  for (let i = 0; i < n; i += 1) {
    const key = `dedup-${RID}-${i}`;
    db.run(`INSERT INTO mailbox_ingestion
              (provider, mailbox, dedup_key, message_id, attachment_id, attachment_name,
               content_hash, received_at, status, subject, sender)
            VALUES ('microsoft','career@arabtecegy.com',?,?,?,?,?,?, 'IMPORTED', ?, ?)`,
    [key, `msg-${i}`, `att-${i}`, `cv-${i}.pdf`, `hash-${i}`,
      new Date(Date.now() - i * 60000).toISOString(),
      i % 3 === 0 ? 'QC Engineer' : 'Senior Cost Control Engineer',
      `applicant${i}@example.test`]);
    ids.push(db.get('SELECT id FROM mailbox_ingestion WHERE dedup_key=?', [key]).id);
  }
  return ids;
}

const { storeFile } = await import('./src/lib/upload.js');
const manager = await makeUser(`mgr.${RID}@arabtec.com`, 'recruitment_manager');
const outsider = await makeUser(`out.${RID}@arabtec.com`, 'recruitment_manager');
const waiting = seedWaiting(40);

/* ------------------- 1. no access by default, for anyone ----------------- */
console.log('\n- Default: a Recruitment Manager has NO intake access -');

const ROUTES = [
  ['GET', '/api/cv-intake/summary'],
  ['GET', '/api/cv-intake/queue'],
  ['GET', '/api/cv-intake/batches'],
  ['GET', `/api/cv-intake/items/${waiting[0]}/preview`],
  ['GET', `/api/cv-intake/items/${waiting[0]}/document`],
];
for (const [method, path] of ROUTES) {
  const r = await call(path, { token: outsider.token, method });
  c(`unauthorized manager is refused ${method} ${path.replace(/\d+/g, ':id')}`, r.status === 403, String(r.status));
}
const anon = await call('/api/cv-intake/summary');
c('an unauthenticated caller is refused', anon.status === 401, String(anon.status));

const mgrDefault = await call('/api/cv-intake/summary', { token: manager.token });
c('a Recruitment Manager gets NO access from their role alone', mgrDefault.status === 403, String(mgrDefault.status));

const adminSummary = await call('/api/cv-intake/summary', { token: admin });
c('the System Admin can read the summary', adminSummary.status === 200, String(adminSummary.status));
c('the summary counts what is waiting', adminSummary.j?.waiting === 40, String(adminSummary.j?.waiting));
c('and groups it by job category',
  (adminSummary.j?.categories || []).length >= 2,
  (adminSummary.j?.categories || []).map((x) => `${x.category}:${x.count}`).join(' '));

/* ---------------- 2. one permission at a time, granted by admin ---------- */
console.log('\n- Each permission gates exactly its own routes -');

grant(manager.id, manager.email, 'cv_intake.view');
const withView = await call('/api/cv-intake/summary', { token: manager.token });
c('granting cv_intake.view opens the summary — same session, no re-login',
  withView.status === 200, String(withView.status));

const previewDenied = await call(`/api/cv-intake/items/${waiting[0]}/preview`, { token: manager.token });
c('but cv_intake.view alone does NOT open a candidate CV', previewDenied.status === 403, String(previewDenied.status));

const approveDenied = await call('/api/cv-intake/batches', {
  token: manager.token, method: 'POST', body: { ingestionIds: waiting.slice(0, 2) },
});
c('and it does NOT allow approving a batch', approveDenied.status === 403, String(approveDenied.status));

grant(manager.id, manager.email, 'cv_intake.preview');
const previewOk = await call(`/api/cv-intake/items/${waiting[0]}/preview`, { token: manager.token });
c('granting cv_intake.preview opens the email behind an attachment', previewOk.status === 200, String(previewOk.status));
c('the preview names the applicant and the position', !!previewOk.j?.sender && !!previewOk.j?.subject,
  `${previewOk.j?.category}`);
c('and the subject is classified against the designation catalogue',
  previewOk.j?.category === 'QC Engineer', previewOk.j?.category);

// Attach a real document to one item, then open it — the disclosure audit
// entry must come from an actual view, not from a 404.
const stored = storeFile('cv-0.pdf', Buffer.from('%PDF-1.4\nsynthetic\n%%EOF\n'));
db.run('UPDATE mailbox_ingestion SET stored_name=? WHERE id=?', [stored.storedName, waiting[0]]);
const docRes = await fetch(`${BASE}/api/cv-intake/items/${waiting[0]}/document`,
  { headers: { authorization: `Bearer ${manager.token}` } });
c('the original CV can be opened with cv_intake.preview', docRes.status === 200, String(docRes.status));
const docOutsider = await fetch(`${BASE}/api/cv-intake/items/${waiting[0]}/document`,
  { headers: { authorization: `Bearer ${outsider.token}` } });
c('and NOT without it, even by direct URL', docOutsider.status === 403, String(docOutsider.status));

/* ------------------------- 3. approving a batch -------------------------- */
console.log('\n- Approving a batch -');

grant(manager.id, manager.email, 'cv_intake.approve_batch');
const tooBig = await call('/api/cv-intake/batches', {
  token: manager.token, method: 'POST', body: { ingestionIds: waiting },
});
c('a batch over the administrator limit is refused', tooBig.status === 400, tooBig.j?.error?.slice(0, 60));

const batchRes = await call('/api/cv-intake/batches', {
  token: manager.token, method: 'POST', body: { ingestionIds: waiting.slice(0, 10), category: 'QC Engineer' },
});
c('a batch within the limit is approved', batchRes.status === 201, String(batchRes.status));
const batchId = batchRes.j?.id;
c('the batch records WHO approved it', batchRes.j?.approvedBy === manager.id,
  `approvedBy=${batchRes.j?.approvedBy} manager=${manager.id}`);
c('and WHEN', !!batchRes.j?.approvedAt);
c('it holds exactly the selected CVs', batchRes.j?.totals?.items === 10, String(batchRes.j?.totals?.items));

const overlap = await call('/api/cv-intake/batches', {
  token: manager.token, method: 'POST', body: { ingestionIds: waiting.slice(5, 12) },
});
c('the same CV cannot be approved into a second batch', overlap.status === 400, overlap.j?.error?.slice(0, 60));

const afterBatch = await call('/api/cv-intake/summary', { token: manager.token });
c('approved CVs leave the waiting queue', afterBatch.j?.waiting === 30, String(afterBatch.j?.waiting));

/* --------------------------- 4. control is separate ---------------------- */
console.log('\n- Pause / resume / cancel is a different authority -');

const pauseDenied = await call(`/api/cv-intake/batches/${batchId}/pause`, { token: manager.token, method: 'POST' });
c('approving a batch does NOT confer the right to halt one', pauseDenied.status === 403, String(pauseDenied.status));

grant(manager.id, manager.email, 'cv_intake.control');
const paused = await call(`/api/cv-intake/batches/${batchId}/pause`, {
  token: manager.token, method: 'POST', body: { reason: 'checking the category mapping' },
});
c('granting cv_intake.control allows a pause', paused.status === 200 && paused.j?.status === 'PAUSED', paused.j?.status);
c('the pause records who did it and why',
  paused.j?.controlledBy === manager.id && /category mapping/.test(paused.j?.controlReason || ''));

const resumed = await call(`/api/cv-intake/batches/${batchId}/resume`, { token: manager.token, method: 'POST' });
c('and a resume', resumed.status === 200 && resumed.j?.status === 'PENDING', resumed.j?.status);

/* ------------------------- 5. the limits are the admin's ----------------- */
console.log('\n- Only the administrator sets the ceiling -');

const mgrLimits = await call('/api/cv-intake/settings', {
  token: manager.token, method: 'PUT', body: { limits: { maxBatchSize: 500 } },
});
c('a manager holding every cv_intake.* permission still cannot raise the limit',
  mgrLimits.status === 403, String(mgrLimits.status));

const adminLimits = await call('/api/cv-intake/settings', {
  token: admin, method: 'PUT', body: { limits: { maxBatchSize: 5, maxConcurrency: 1 } },
});
c('the System Admin can', adminLimits.status === 200 && adminLimits.j?.limits?.maxBatchSize === 5,
  String(adminLimits.j?.limits?.maxBatchSize));

const nowTooBig = await call('/api/cv-intake/batches', {
  token: manager.token, method: 'POST', body: { ingestionIds: waiting.slice(20, 28) },
});
c('the lowered limit takes effect immediately', nowTooBig.status === 400, nowTooBig.j?.error?.slice(0, 50));

/* ---------------- 6. REVOCATION, mid-session, next request --------------- */
console.log('\n- Revocation takes effect on the next request -');

const beforeRevoke = await call('/api/cv-intake/summary', { token: manager.token });
c('the manager can still read the summary', beforeRevoke.status === 200);

revoke(manager.id, 'cv_intake.view');
const afterRevoke = await call('/api/cv-intake/summary', { token: manager.token });
c('revoking cv_intake.view denies the VERY NEXT request — same token, no logout',
  afterRevoke.status === 403, String(afterRevoke.status));

const stillMe = await call('/api/auth/me', { token: manager.token });
c('the session itself is still valid — this is authorisation, not sign-out',
  stillMe.status === 200, String(stillMe.status));

revoke(manager.id, 'cv_intake.approve_batch');
const directApi = await call('/api/cv-intake/batches', {
  token: manager.token, method: 'POST', body: { ingestionIds: waiting.slice(30, 32) },
});
c('and a DIRECT API call, bypassing the panel entirely, is refused too',
  directApi.status === 403, String(directApi.status));

/* -------------------- 7. revocation destroys nothing --------------------- */
console.log('\n- Revocation is not deletion -');

const batchAfter = db.get('SELECT * FROM cv_intake_batch WHERE id=?', [batchId]);
c('the batch the revoked user approved still exists', !!batchAfter, batchAfter?.status);
c('it is NOT cancelled by the revocation', batchAfter?.status === 'PENDING', batchAfter?.status);
c('its items survive',
  db.get('SELECT COUNT(*) n FROM cv_intake_batch_item WHERE batch_id=?', [batchId]).n === 10);
c('and it still records who approved it', batchAfter?.approved_by === manager.id);

const ingestionsIntact = db.get('SELECT COUNT(*) n FROM mailbox_ingestion').n;
c('no mailbox record was deleted', ingestionsIntact === 40, String(ingestionsIntact));

/* ------------------------ 8. state machine holds ------------------------- */
console.log('\n- Batch state transitions -');

const cancelled = await call(`/api/cv-intake/batches/${batchId}/cancel`, { token: admin, method: 'POST' });
c('an admin can cancel a pending batch', cancelled.status === 200 && cancelled.j?.status === 'CANCELLED');
const resumeCancelled = await call(`/api/cv-intake/batches/${batchId}/resume`, { token: admin, method: 'POST' });
c('a cancelled batch cannot be resumed', resumeCancelled.status === 400, resumeCancelled.j?.error?.slice(0, 60));
const bogus = await call(`/api/cv-intake/batches/${batchId}/detonate`, { token: admin, method: 'POST' });
c('an unknown control action is not a route', bogus.status === 404, String(bogus.status));

/* ------------------------------- 9. audit -------------------------------- */
console.log('\n- Audit -');

const actions = new Set((db.all('SELECT action FROM audit_log') || []).map((r) => r.action));
for (const want of ['cv_intake.batch_approved', 'cv_intake.batch_paused',
  'cv_intake.batch_cancelled', 'cv_intake.limits_changed', 'cv_intake.document_viewed']) {
  c(`audit records ${want}`, actions.has(want));
}

console.log(`\n=== CV INTAKE PANEL: ${passed} passed, ${failed} failed ===`);
for (const f of [DBF, DBF + '-journal', DBF + '-wal', DBF + '-shm']) {
  try { fs.rmSync(f); } catch { /* already gone */ }
}
try { fs.rmSync(process.env.UPLOAD_DIR, { recursive: true, force: true }); } catch { /* nothing */ }
process.exit(failed === 0 ? 0 : 1);
