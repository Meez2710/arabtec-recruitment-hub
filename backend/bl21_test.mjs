// BL-21/BL-23 — headcount changes reconcile seats, atomically.
//
//   node --experimental-sqlite bl21_test.mjs
//
// Assertions use PERSISTED canonical statuses. `STATUS.APPROVED` in the route is
// an alias for `sourcing` and `STATUS.DRAFT` for `pending_approval` — see
// docs/REQUEST_STATUS_ALIAS_MAP.md — so there are three editable persisted
// statuses, not four, and a headcount change while `sourcing` IS a material
// change that resets approval.

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'file:/tmp/arabtec_bl21.db';
process.env.PORT = '4138';
import fs from 'node:fs';
for (const f of ['/tmp/arabtec_bl21.db', '/tmp/arabtec_bl21.db-journal']) { try { fs.rmSync(f); } catch {} }
await import('./prisma/seed.js');
await import('./src/server.js');

const B = 'http://localhost:4138';
const DEADLINE = Date.now() + 30000;
for (;;) {
  try {
    const r = await fetch(`${B}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'readiness@probe.invalid', password: 'x' }),
    });
    if (r.status !== 503) break;
  } catch { /* not up */ }
  if (Date.now() > DEADLINE) throw new Error('server never became ready');
  await new Promise((r) => setTimeout(r, 150));
}

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
const { get, all, exec } = await import('./src/lib/db.js');

const snap = (id) => ({
  req: get('SELECT status, headcount, title FROM recruitment_request WHERE id=?', [id]),
  seats: all('SELECT id, seat_no, status, filled_by_application_id link FROM requisition_seat WHERE request_id=? ORDER BY seat_no', [id]),
  edited: get("SELECT COUNT(*) c FROM request_activity WHERE request_id=? AND type='edited'", [id]).c,
  reapproval: get("SELECT COUNT(*) c FROM request_activity WHERE request_id=? AND type='reapproval_required'", [id]).c,
  // entity_id is TEXT: comparing it to a number never matches in SQLite.
  audit: get("SELECT COUNT(*) c FROM audit_log WHERE action='request.updated' AND CAST(entity_id AS INTEGER)=?", [id]).c,
});
const activeSeats = (id) => get("SELECT COUNT(*) c FROM requisition_seat WHERE request_id=? AND status IN ('open','reopened','reserved')", [id]).c;
const rows = (id) => all('SELECT id FROM requisition_seat WHERE request_id=?', [id]).length;
const filled = (id) => get("SELECT COUNT(*) c FROM requisition_seat WHERE request_id=? AND status='filled'", [id]).c;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const reload = (id) => get('SELECT id, status, headcount FROM recruitment_request WHERE id=?', [id]);

const recruiter = await login('recruiter@arabtec.com');
const hrMgr = await login('hr.manager@arabtec.com');
const meta = await api('/api/requests/meta/form', { token: hrMgr });

const step = (label, res, ok = 200) => {
  if (res.status !== ok) throw new Error(`${label} expected ${ok}, got ${res.status}: ${String(res.json?.error || '').slice(0, 100)}`);
  return res;
};
let seq = 0;
const create = async (headcount) => {
  delete process.env.FAIL_INJECT;
  seq += 1;
  return step('POST /requests', await api('/api/requests', {
    method: 'POST', token: hrMgr,
    body: { title: `HC ${seq}-${Date.now()}`, projectId: meta.json.projects[0].id, departmentId: meta.json.departments[0].id, headcount, priority: 'high' },
  }), 201).json.request.id;
};
const assertStatus = (id, expected) => {
  const s = reload(id).status;
  if (s !== expected) throw new Error(`expected ${expected}, persisted ${s}`);
  return reload(id);
};
const mkPendingReq = async (hc) => assertStatus(await create(hc), 'pending_approval');
const mkSourcingReq = async (hc) => {
  const id = await create(hc);
  step('submit', await api(`/api/requests/${id}/submit`, { method: 'POST', token: hrMgr }));
  step('approve', await api(`/api/requests/${id}/approve`, { method: 'POST', token: hrMgr, body: {} }));
  return assertStatus(id, 'sourcing');
};
const mkClosedReq = async (hc) => {
  const r = await mkSourcingReq(hc);
  step('close', await api(`/api/requests/${r.id}/close`, { method: 'POST', token: hrMgr, body: { reason: 'setup' } }));
  return assertStatus(r.id, 'closed');
};
const mkReopenedReq = async (hc) => {
  const r = await mkClosedReq(hc);
  step('reopen', await api(`/api/requests/${r.id}/reopen`, { method: 'POST', token: hrMgr, body: { reason: 'setup' } }));
  return assertStatus(r.id, 'reopened');
};
const joinOne = async (reqId, label) => {
  const cand = (await api('/api/candidates', { method: 'POST', token: recruiter, body: { fullName: label, email: `${label.replace(/\W+/g, '.')}@example.com` } })).json.candidate.id;
  const app = (await api('/api/applications', { method: 'POST', token: recruiter, body: { candidateId: cand, requestId: reqId } })).json.application.id;
  for (const st of ['matched', 'interviewing', 'issuing_offer', 'offer_sent', 'joined']) {
    await api(`/api/applications/${app}/move`, { method: 'POST', token: recruiter, body: { status: st, reason: 'test' } });
  }
};
const setHc = (id, headcount) => api(`/api/requests/${id}`, { method: 'PUT', token: hrMgr, body: { headcount: Number(headcount) } });

/* ------------------------------ pending_approval -------------------------- */
console.log('\n— pending_approval: not recruiting, so reconciliation is inventory-only —');
{
  const r = await mkPendingReq(3);
  const before = snap(r.id);
  const activeBefore = activeSeats(r.id);
  const res = await setHc(r.id, 6);
  c('increase succeeds', res.status === 200, `status=${res.status}`);
  c('status stays pending_approval', reload(r.id).status === 'pending_approval');
  c('no NEW active capacity', activeSeats(r.id) === activeBefore, `active=${activeSeats(r.id)}`);
  c('inventory grew instead', rows(r.id) > before.seats.length, `rows=${rows(r.id)}`);
  c('one edited activity', snap(r.id).edited === before.edited + 1);
  c('one audit', snap(r.id).audit === before.audit + 1);
  c('no reapproval — it was never sourcing', snap(r.id).reapproval === before.reapproval);
}
{
  const r = await mkPendingReq(5);
  const res = await setHc(r.id, 3);
  c('decrease succeeds', res.status === 200, `status=${res.status}`);
  c('no seat row deleted', rows(r.id) >= 5, `rows=${rows(r.id)}`);
  c('active capacity is not increased by a decrease', activeSeats(r.id) <= 5);
}
{
  const r = await mkPendingReq(4);
  await setHc(r.id, 2);
  const rowsAfter = rows(r.id);
  const back = await setHc(r.id, 4);
  // Non-recruiting reconciliation only ADDS inventory — it never retires — so a
  // decrease leaves capacity untouched and a later increase tops the inventory
  // up. Row count therefore grows; what must hold is that no seat number is
  // reused and no active capacity appears.
  c('inventory tops up without exposing capacity', activeSeats(r.id) <= 4, `active=${activeSeats(r.id)}`);
  c('seat numbers stay unique',
    new Set(all('SELECT seat_no FROM requisition_seat WHERE request_id=?', [r.id]).map((s) => s.seat_no)).size === rows(r.id),
    JSON.stringify(back.json?.seats));
}

/* --------------------------------- sourcing ------------------------------- */
console.log('\n— sourcing: a headcount change IS material and resets approval —');
{
  const r = await mkSourcingReq(3);
  const before = snap(r.id);
  const activeBefore = activeSeats(r.id);
  const res = await setHc(r.id, 6);
  c('increase succeeds', res.status === 200, `status=${res.status}`);
  c('status becomes pending_approval', reload(r.id).status === 'pending_approval', reload(r.id).status);
  c('one reapproval_required activity', snap(r.id).reapproval === before.reapproval + 1);
  c('one edited activity', snap(r.id).edited === before.edited + 1);
  c('one audit', snap(r.id).audit === before.audit + 1);
  c('reconciled against the FINAL status — no new active capacity',
    activeSeats(r.id) === activeBefore, `active=${activeSeats(r.id)}`);
}
{
  const r = await mkSourcingReq(3);
  const before = snap(r.id);
  const res = await api(`/api/requests/${r.id}`, { method: 'PUT', token: hrMgr, body: { title: 'Renamed' } });
  c('non-material edit succeeds', res.status === 200, `status=${res.status}`);
  c('and preserves sourcing', reload(r.id).status === 'sourcing', reload(r.id).status);
  c('and reconciles no seats', JSON.stringify(snap(r.id).seats) === JSON.stringify(before.seats));
}

/* -------------------------------- reopened -------------------------------- */
console.log('\n— reopened: recruiting, and not a material-change trigger —');
{
  const r = await mkReopenedReq(3);
  const before = snap(r.id);
  const res = await setHc(r.id, 6);
  c('increase succeeds', res.status === 200, `status=${res.status}`);
  c('status stays reopened', reload(r.id).status === 'reopened', reload(r.id).status);
  c('no reapproval', snap(r.id).reapproval === before.reapproval);
  c('active capacity follows headcount', activeSeats(r.id) === 6, `active=${activeSeats(r.id)}`);
  c('one edited activity and one audit',
    snap(r.id).edited === before.edited + 1 && snap(r.id).audit === before.audit + 1);
}
{
  const r = await mkReopenedReq(5);
  const res = await setHc(r.id, 3);
  c('decrease succeeds', res.status === 200, `status=${res.status}`);
  c('active capacity is the new headcount', activeSeats(r.id) === 3, `active=${activeSeats(r.id)}`);
  c('no seat row deleted', rows(r.id) === 5, `rows=${rows(r.id)}`);
}
{
  // FINDING: filling a seat moves the requisition to `partially_filled`, which is
  // NOT in the editable allowlist, so a requisition with any joined candidate can
  // no longer have its headcount edited through PUT /:id at all. Decrease-to-filled
  // and decrease-below-filled are therefore unreachable at the route; both are
  // proven at the helper level in reconciliation_test.mjs. Recorded, not worked
  // around — this is route validation, not a helper conflict.
  const r = await mkReopenedReq(3);
  await joinOne(r.id, `Fill ${r.id}A`); await joinOne(r.id, `Fill ${r.id}B`);
  const persisted = reload(r.id).status;
  c('joining moves the requisition out of the editable set', persisted === 'partially_filled', persisted);
  const before = snap(r.id);
  const res = await setHc(r.id, filled(r.id));
  c('so any headcount edit is refused', res.status === 409, `status=${res.status}`);
  c('with the edit-policy reason', /cannot edit a request/i.test(res.json?.error || ''), res.json?.error);
  c('and writes nothing', same(snap(r.id), before));
}

/* --------------------------------- closed --------------------------------- */
console.log('\n— closed is refused with zero writes —');
{
  const r = await mkClosedReq(3);
  const before = snap(r.id);
  const res = await setHc(r.id, 6);
  c('PUT is 409', res.status === 409, `status=${res.status}`);
  c('error names the edit policy', /cannot edit a request/i.test(res.json?.error || ''), res.json?.error);
  c('zero writes', same(snap(r.id), before));
}

/* --------------------------- failure injection ---------------------------- */
console.log('\n— failure after every executed boundary, then retry —');
for (const [label, mk] of [['pending_approval', mkPendingReq], ['reopened', mkReopenedReq]]) {
  for (const dir of ['increase', 'decrease']) {
    for (let b = 1; b <= 5; b += 1) {
      const r = await mk(4);
      const target = dir === 'decrease' ? 2 : 6;
      const before = snap(r.id);
      let res;
      try { process.env.FAIL_INJECT = `headcount:${b}`; res = await setHc(r.id, target); }
      finally { delete process.env.FAIL_INJECT; }
      c(`${label} ${dir} b${b}: rejected, state identical`,
        res.status >= 400 && same(snap(r.id), before), `status=${res.status}`);
      const retry = await setHc(reload(r.id).id, target);
      const after = snap(r.id);
      c(`${label} ${dir} b${b}: retry applies exactly once`,
        retry.status === 200 && after.edited === before.edited + 1 && after.audit === before.audit + 1,
        `status=${retry.status} edited=${after.edited} audit=${after.audit}`);
    }
  }
}

console.log('\n— strict audit failure —');
{
  const r = await mkPendingReq(3);
  const before = snap(r.id);
  exec('ALTER TABLE audit_log RENAME TO audit_log_hidden');
  const res = await setHc(r.id, 5);
  exec('ALTER TABLE audit_log_hidden RENAME TO audit_log');
  c('edit failed rather than committing without audit', res.status >= 400, `status=${res.status}`);
  c('headcount and seats unchanged', same(snap(r.id), before));
  c('succeeds once auditing works', (await setHc(reload(r.id).id, 5)).status === 200);
}

console.log(`\n${fail === 0 ? '✓' : '✗'} BL-21/BL-23: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
