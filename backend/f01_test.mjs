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
const { get, all } = await import('./src/lib/db.js');
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

  /* --------------------------- failure injection -------------------------- */
  console.log('\n— an injected failure after all eight writes persists NOTHING —');
  const beforeAudit = get("SELECT COUNT(*) c FROM audit_log WHERE action='application.created'").c;
  const beforeCounter = get("SELECT value FROM system_setting WHERE key='application_counter'")?.value;
  const failCand = await makeCandidate();

  process.env.FAIL_INJECT_APP_CREATE = 'after-all-writes';
  const failed = await create(failCand);
  delete process.env.FAIL_INJECT_APP_CREATE;

  c('the request failed rather than reporting success', failed.status >= 500 || failed.status >= 400,
    `got ${failed.status}`);

  const afterFail = counts(failCand);
  c('no application row survives', afterFail.apps === 0, `apps=${afterFail.apps}`);
  c('no stage history survives', afterFail.history === 0, `history=${afterFail.history}`);
  c('no orphan candidate activity survives', afterFail.activity === 0, `activity=${afterFail.activity}`);
  c('no partial audit record survives', afterFail.audit === beforeAudit, `${beforeAudit} -> ${afterFail.audit}`);
  c('the shared number counter was not burned',
    afterFail.counter === beforeCounter, `${beforeCounter} -> ${afterFail.counter}`);
  c('no seat was consumed',
    get("SELECT COUNT(*) c FROM requisition_seat WHERE request_id=? AND status='filled'", [reqId]).c === 0);
  c('headcount_filled unchanged',
    get('SELECT headcount_filled h FROM recruitment_request WHERE id=?', [reqId]).h === 0);

  /* ------------------------------- retry ---------------------------------- */
  console.log('\n— retry after the failure produces exactly one valid application —');
  const retry = await create(failCand);
  c('retry succeeds (201)', retry.status === 201, `got ${retry.status}`);
  const afterRetry = counts(failCand);
  c('exactly one application exists', afterRetry.apps === 1, `apps=${afterRetry.apps}`);
  c('exactly one stage history row', afterRetry.history === 1, `history=${afterRetry.history}`);
  c('exactly one activity row', afterRetry.activity === 1, `activity=${afterRetry.activity}`);
  c('audit grew by exactly one', afterRetry.audit === beforeAudit + 1, `${beforeAudit} -> ${afterRetry.audit}`);
  const nos = all('SELECT application_no FROM application ORDER BY id').map((r) => r.application_no);
  c('application numbers have no duplicates', new Set(nos).size === nos.length, nos.join(','));

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
