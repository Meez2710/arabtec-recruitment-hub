// F-01 — application creation is atomic.
//
//   node --experimental-sqlite f01_test.mjs
//
// Creating an application performs EIGHT writes: the shared number counter, the
// application row, stage history, two requisition lifecycle stamps, candidate
// activity, request activity, and the audit record. Unwrapped, a failure
// part-way left an application with no history and no audit trail — corruption
// that reads as success.
//
// Failure is injected INSIDE the transaction, after all eight writes have run,
// via FAIL_INJECT_APP_CREATE. That is the strongest position for the test: every
// write has already happened, so if any of them survives the rollback, the
// transaction is not doing its job.

process.env.DATABASE_URL = 'file:/tmp/arabtec_f01.db';
process.env.PORT = '4132';
import fs from 'node:fs';
for (const f of ['/tmp/arabtec_f01.db', '/tmp/arabtec_f01.db-journal']) { try { fs.rmSync(f); } catch {} }
await import('./prisma/seed.js');
await import('./src/server.js');
await new Promise((r) => setTimeout(r, 700));

const B = 'http://localhost:4132';
let pass = 0; let fail = 0;
const c = (n, ok, x = '') => { console.log((ok ? '  ✅ ' : '  ❌ ') + n + (x ? ` ${x}` : '')); ok ? pass++ : fail++; };

async function api(p, { method = 'GET', token, body } = {}) {
  const r = await fetch(B + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, json: j };
}
const login = async (e, p = 'Arabtec@123') =>
  (await api('/api/auth/login', { method: 'POST', body: { email: e, password: p } })).json.token;

// Direct reads, so the assertions see PERSISTED state rather than a response body.
const { get, all, exec } = await import('./src/lib/db.js');
const counts = (candidateId) => ({
  apps: get('SELECT COUNT(*) c FROM application WHERE candidate_id=?', [candidateId]).c,
  history: get(
    'SELECT COUNT(*) c FROM application_stage_history WHERE application_id IN (SELECT id FROM application WHERE candidate_id=?)',
    [candidateId],
  ).c,
  activity: get("SELECT COUNT(*) c FROM candidate_activity WHERE candidate_id=? AND type='application_created'", [candidateId]).c,
  audit: get("SELECT COUNT(*) c FROM audit_log WHERE action='application.created'").c,
  counter: get("SELECT value FROM system_setting WHERE key='application_counter'")?.value,
});

(async () => {
  const recruiter = await login('recruiter@arabtec.com');
  const hrMgr = await login('hr.manager@arabtec.com');
  const recMgr = await login('rec.manager@arabtec.com');

  const meta = await api('/api/requests/meta/form', { token: hrMgr });
  const cr = await api('/api/requests', {
    method: 'POST', token: hrMgr,
    body: {
      title: 'Atomic Probe', projectId: meta.json.projects[0].id,
      departmentId: meta.json.departments[0].id, headcount: 3, priority: 'high',
    },
  });
  const reqId = cr.json.request.id;
  await api(`/api/requests/${reqId}/submit`, { method: 'POST', token: hrMgr });
  await api(`/api/requests/${reqId}/approve`, { method: 'POST', token: hrMgr, body: {} });
  await api(`/api/requests/${reqId}/assign`, { method: 'POST', token: recMgr, body: { ownerId: meta.json.recruiters[0].id } });

  let seq = 0;
  const makeCandidate = async () => {
    seq += 1;
    return (await api('/api/candidates', {
      method: 'POST', token: recruiter,
      body: { fullName: `Atomic ${seq}`, email: `atomic.${seq}@example.com` },
    })).json.candidate.id;
  };
  const create = (candidateId, extra = {}) => api('/api/applications', {
    method: 'POST', token: recruiter, body: { candidateId, requestId: reqId, ...extra },
  });

  /* ------------------------- the happy path still works ------------------- */
  console.log('\n— a successful create writes all eight —');
  const okCand = await makeCandidate();
  const okRes = await create(okCand);
  c('create succeeds (201)', okRes.status === 201, `got ${okRes.status}`);
  const okC = counts(okCand);
  c('application row written', okC.apps === 1);
  c('stage history written', okC.history === 1);
  c('candidate activity written', okC.activity === 1);
  c('audit record written', okC.audit >= 1, `audit=${okC.audit}`);
  const reqAfterOk = get('SELECT first_candidate_at FROM recruitment_request WHERE id=?', [reqId]);
  c('requisition lifecycle stamped', !!reqAfterOk.first_candidate_at);

  /* ------------------ failure injection at EVERY boundary ----------------- */
  // The eight writes, in order:
  //   1 counter  2 application  3 stage history  4 first_candidate_at
  //   5 first_shortlist_at (conditional)  6 candidate activity
  //   7 request activity  8 audit
  console.log('\n— failure after each of the eight writes persists NOTHING —');

  const settings = () => Object.fromEntries(
    all('SELECT key, value FROM system_setting').map((r) => [r.key, r.value]),
  );

  for (let b = 1; b <= 8; b += 1) {
    const beforeAudit = get("SELECT COUNT(*) c FROM audit_log WHERE action='application.created'").c;
    const beforeSeats = get("SELECT COUNT(*) c FROM requisition_seat WHERE request_id=? AND status='filled'", [reqId]).c;
    const beforeHead = get('SELECT headcount_filled h FROM recruitment_request WHERE id=?', [reqId]).h;
    const beforeApps = get('SELECT COUNT(*) c FROM application').c;
    const cand = await makeCandidate();
    // Snapshot AFTER creating the candidate: makeCandidate legitimately advances
    // candidate_counter, and including that would make this assert the wrong thing.
    const beforeSettings = settings();

    process.env.FAIL_INJECT_APP_CREATE = String(b);
    // Boundary 5 only executes for a shortlisted create, so drive that one there.
    const res = await create(cand, b === 5 ? { initialStatus: 'shortlisted' } : {});
    delete process.env.FAIL_INJECT_APP_CREATE;

    const a = counts(cand);
    const ok = res.status >= 400
      && a.apps === 0 && a.history === 0 && a.activity === 0
      && a.audit === beforeAudit
      && get('SELECT COUNT(*) c FROM application').c === beforeApps
      && JSON.stringify(settings()) === JSON.stringify(beforeSettings)
      && get("SELECT COUNT(*) c FROM requisition_seat WHERE request_id=? AND status='filled'", [reqId]).c === beforeSeats
      && get('SELECT headcount_filled h FROM recruitment_request WHERE id=?', [reqId]).h === beforeHead;
    c(`boundary ${b}: nothing persisted`, ok,
      `status=${res.status} apps=${a.apps} hist=${a.history} act=${a.activity} audit=${a.audit}/${beforeAudit}`);

    // Retry the SAME operation and prove it yields exactly one of everything.
    const retry = await create(cand, b === 5 ? { initialStatus: 'shortlisted' } : {});
    const r = counts(cand);
    c(`boundary ${b}: retry creates exactly one`,
      retry.status === 201 && r.apps === 1 && r.history === 1 && r.activity === 1
      && r.audit === beforeAudit + 1,
      `status=${retry.status} apps=${r.apps} hist=${r.history} act=${r.activity}`);
  }

  const allNos = all('SELECT application_no FROM application').map((r) => r.application_no);
  c('no duplicate application numbers across every rollback and retry',
    new Set(allNos).size === allNos.length, `${allNos.length} rows, ${new Set(allNos).size} distinct`);

  /* ------------------ strict audit failure rolls everything back ---------- */
  console.log('\n— a failing audit write in strict mode aborts the whole create —');
  const auditCand = await makeCandidate();
  const beforeStrictApps = get('SELECT COUNT(*) c FROM application').c;
  const beforeStrictSettings = settings(); // after makeCandidate, same reason
  // Break the audit table for real — no production test hook involved.
  exec('ALTER TABLE audit_log RENAME TO audit_log_hidden');
  const auditRes = await create(auditCand);
  exec('ALTER TABLE audit_log_hidden RENAME TO audit_log');

  c('the create failed rather than committing without an audit record',
    auditRes.status >= 400, `got ${auditRes.status}`);
  c('no application survived the audit failure',
    counts(auditCand).apps === 0 && get('SELECT COUNT(*) c FROM application').c === beforeStrictApps);
  c('the application number was not burned by the audit failure',
    JSON.stringify(settings()) === JSON.stringify(beforeStrictSettings));
  const afterAuditFix = await create(auditCand);
  c('and the operation succeeds once auditing works again', afterAuditFix.status === 201,
    `got ${afterAuditFix.status}`);

  /* ------------------- strict audit inside the transaction ---------------- */
  console.log('\n— the audit write is part of the atom (BL-34, scoped) —');
  const auditSrc = fs.readFileSync('./src/lib/audit.js', 'utf8');
  c('writeAudit accepts a strict option', /strict = false/.test(auditSrc));
  c('strict rethrows instead of swallowing', /if \(strict\) throw e;/.test(auditSrc));
  const routeSrc = fs.readFileSync('./src/routes/applications.js', 'utf8');
  c('application create opts into strict audit', /\{ strict: true \}/.test(routeSrc));
  c('all eight writes are inside tx()', /const created = tx\(\(\) => \{/.test(routeSrc));

  console.log(`\n${fail === 0 ? '✓' : '✗'} F-01: ${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
})();
