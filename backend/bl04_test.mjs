// BL-04 — reopening a requisition restores usable capacity, atomically.
//
//   node --experimental-sqlite bl04_test.mjs
//
// Closing calls Seats.cancelOpen, which cancels every open/reserved/reopened
// seat. Reopen used to flip only the requisition status, so a reopened
// requisition had zero seats counted as capacity by hasOpenSeat() — reopened but
// unable to accept a single join. Filled seats were never lost; the requisition
// was simply dead.

process.env.DATABASE_URL = 'file:/tmp/arabtec_bl04.db';
process.env.PORT = '4133';
import fs from 'node:fs';
for (const f of ['/tmp/arabtec_bl04.db', '/tmp/arabtec_bl04.db-journal']) { try { fs.rmSync(f); } catch {} }
await import('./prisma/seed.js');
await import('./src/server.js');
await new Promise((r) => setTimeout(r, 700));

const B = 'http://localhost:4133';
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

const { get, all } = await import('./src/lib/db.js');

// A full snapshot of everything reopen may touch, for exact rollback comparison.
const snap = (reqId) => ({
  req: get('SELECT status, closed_at, close_reason, headcount, headcount_filled FROM recruitment_request WHERE id=?', [reqId]),
  seats: all('SELECT id, seat_no, status, filled_by_application_id, cancel_reason FROM requisition_seat WHERE request_id=? ORDER BY seat_no', [reqId]),
  activity: get('SELECT COUNT(*) c FROM request_activity WHERE request_id=?', [reqId]).c,
  audit: get("SELECT COUNT(*) c FROM audit_log WHERE action='request.reopened'").c,
});
const available = (reqId) => get(
  "SELECT COUNT(*) c FROM requisition_seat WHERE request_id=? AND status IN ('open','reopened','reserved')", [reqId],
).c;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

(async () => {
  const recruiter = await login('recruiter@arabtec.com');
  const hrMgr = await login('hr.manager@arabtec.com');
  const recMgr = await login('rec.manager@arabtec.com');
  const meta = await api('/api/requests/meta/form', { token: hrMgr });

  let n = 0;
  const mkReq = async (headcount) => {
    n += 1;
    const r = await api('/api/requests', {
      method: 'POST', token: hrMgr,
      body: {
        title: `Reopen Probe ${n}`, projectId: meta.json.projects[0].id,
        departmentId: meta.json.departments[0].id, headcount, priority: 'high',
      },
    });
    const id = r.json.request.id;
    await api(`/api/requests/${id}/submit`, { method: 'POST', token: hrMgr });
    await api(`/api/requests/${id}/approve`, { method: 'POST', token: hrMgr, body: {} });
    await api(`/api/requests/${id}/assign`, { method: 'POST', token: recMgr, body: { ownerId: meta.json.recruiters[0].id } });
    return id;
  };
  const joinOne = async (reqId, label) => {
    const cand = (await api('/api/candidates', {
      method: 'POST', token: recruiter, body: { fullName: label, email: `${label.replace(/\W+/g, '.')}@example.com` },
    })).json.candidate.id;
    const app = (await api('/api/applications', {
      method: 'POST', token: recruiter, body: { candidateId: cand, requestId: reqId },
    })).json.application.id;
    for (const st of ['matched', 'interviewing', 'issuing_offer', 'offer_sent', 'joined']) {
      await api(`/api/applications/${app}/move`, { method: 'POST', token: recruiter, body: { status: st, reason: 'test' } });
    }
    return app;
  };
  const close = (reqId) => api(`/api/requests/${reqId}/close`, {
    method: 'POST', token: hrMgr, body: { reason: 'closing for test' },
  });
  const reopen = (reqId) => api(`/api/requests/${reqId}/reopen`, {
    method: 'POST', token: hrMgr, body: { reason: 'reopening for test' },
  });

  /* ------------------------- A. restore-only path ------------------------ */
  console.log('\n— A. restore-only: every seat cancelled and unoccupied —');
  const a = await mkReq(3);
  await close(a);
  c('closing cancelled every seat', available(a) === 0, `available=${available(a)}`);
  const ra = await reopen(a);
  c('reopen succeeds', ra.status === 200, `got ${ra.status}`);
  c('capacity restored to the full headcount', available(a) === 3, `available=${available(a)}`);
  c('restored, not recreated', ra.json.seats.restored === 3 && ra.json.seats.created === 0,
    JSON.stringify(ra.json.seats));
  c('no extra seat rows were created',
    all('SELECT id FROM requisition_seat WHERE request_id=?', [a]).length === 3);
  c('seat identities preserved',
    all('SELECT seat_no FROM requisition_seat WHERE request_id=? ORDER BY seat_no', [a]).map((s) => s.seat_no).join(',') === '1,2,3');

  /* ---------------------------- B. mixed path ---------------------------- */
  console.log('\n— B. mixed: some seats filled, some restored —');
  const b = await mkReq(3);
  await joinOne(b, 'Filled B1');
  await close(b);
  const bFilled = get("SELECT COUNT(*) c FROM requisition_seat WHERE request_id=? AND status='filled'", [b]).c;
  c('one seat is filled and survived the close', bFilled === 1, `filled=${bFilled}`);
  const rb = await reopen(b);
  c('reopen succeeds', rb.status === 200, `got ${rb.status}`);
  c('capacity is headcount minus commitments', available(b) === 2, `available=${available(b)}`);
  c('the filled seat is still filled and still linked',
    get("SELECT COUNT(*) c FROM requisition_seat WHERE request_id=? AND status='filled' AND filled_by_application_id IS NOT NULL", [b]).c === 1);
  c('total seats unchanged — no duplicates',
    all('SELECT id FROM requisition_seat WHERE request_id=?', [b]).length === 3);

  /* --------------------------- C. create-only ---------------------------- */
  console.log('\n— C. create-only: no reusable seats available —');
  const cc = await mkReq(2);
  await close(cc);
  // Remove the cancelled seats so nothing is reusable.
  const { run } = await import('./src/lib/db.js');
  run("DELETE FROM requisition_seat WHERE request_id=? AND status='cancelled'", [cc]);
  c('no reusable seats remain', all('SELECT id FROM requisition_seat WHERE request_id=?', [cc]).length === 0);
  const rc = await reopen(cc);
  c('reopen succeeds', rc.status === 200, `got ${rc.status}`);
  c('all capacity was created', rc.json.seats.created === 2 && rc.json.seats.restored === 0,
    JSON.stringify(rc.json.seats));
  c('capacity equals headcount', available(cc) === 2, `available=${available(cc)}`);

  console.log('\n— C2. more cancelled seats than needed —');
  const c2 = await mkReq(2);
  await close(c2);
  run("INSERT INTO requisition_seat (request_id, seat_no, status) VALUES (?, 98, 'cancelled'), (?, 99, 'cancelled')", [c2, c2]);
  const rc2 = await reopen(c2);
  c('only the required number is restored', available(c2) === 2, `available=${available(c2)}`);
  c('surplus cancelled seats stay cancelled',
    get("SELECT COUNT(*) c FROM requisition_seat WHERE request_id=? AND status='cancelled'", [c2]).c === 2);

  /* -------------------- D. zero capacity → conflict ---------------------- */
  console.log('\n— D. fully filled: reopen is refused, nothing changes —');
  const d = await mkReq(1);
  await joinOne(d, 'Filled D1');
  await close(d);
  const beforeD = snap(d);
  const rd = await reopen(d);
  c('reopen is refused with a conflict', rd.status === 409, `got ${rd.status}`);
  c('the error explains headcount must rise', /headcount/i.test(rd.json?.error || ''), rd.json?.error);
  c('NOTHING changed', same(snap(d), beforeD));

  /* ------------------------- invalid transitions ------------------------- */
  console.log('\n— invalid source states —');
  const e = await mkReq(2);
  const beforeOpen = snap(e);
  const re = await reopen(e);
  c('an open requisition cannot be reopened', re.status === 409, `got ${re.status}`);
  c('and nothing changed', same(snap(e), beforeOpen));
  await close(e);
  await reopen(e);
  const afterFirst = snap(e);
  const second = await reopen(e);
  c('a second reopen is consistently refused', second.status === 409, `got ${second.status}`);
  c('and writes nothing', same(snap(e), afterFirst));
  c('no duplicate activity from the refused attempt', snap(e).activity === afterFirst.activity);

  /* --------------------- per-boundary failure injection ------------------ */
  console.log('\n— failure after each of the five write boundaries —');
  for (const path of ['restore', 'mixed', 'create']) {
    for (let bnd = 1; bnd <= 5; bnd += 1) {
      const id = await mkReq(3);
      if (path === 'mixed') await joinOne(id, `Inj ${path} ${bnd}`);
      await close(id);
      if (path === 'create') run("DELETE FROM requisition_seat WHERE request_id=? AND status='cancelled'", [id]);
      const before = snap(id);

      process.env.FAIL_INJECT = `reopen:${bnd}`;
      const res = await reopen(id);
      delete process.env.FAIL_INJECT;

      const after = snap(id);
      c(`${path} boundary ${bnd}: rejected and state identical`,
        res.status >= 400 && same(after, before),
        `status=${res.status}${same(after, before) ? '' : ' STATE DIFFERS'}`);

      const retry = await reopen(id);
      const capacity = available(id);
      const expected = 3 - (path === 'mixed' ? 1 : 0);
      c(`${path} boundary ${bnd}: retry reopens exactly once`,
        retry.status === 200 && capacity === expected
        && snap(id).activity === before.activity + 1
        && snap(id).audit === before.audit + 1,
        `status=${retry.status} capacity=${capacity}/${expected}`);
    }
  }

  /* --------------------------- reopen cycles ----------------------------- */
  console.log('\n— repeated close/reopen cycles —');
  const cy = await mkReq(4);
  await joinOne(cy, 'Cycle Filled');
  const seatIdsStart = all('SELECT id FROM requisition_seat WHERE request_id=? ORDER BY seat_no', [cy]).map((s) => s.id);
  let cyclesOk = true;
  for (let i = 0; i < 3; i += 1) {
    await close(cy);
    const rr = await reopen(cy);
    if (rr.status !== 200 || available(cy) !== 3) cyclesOk = false;
  }
  c('three close/reopen cycles all succeed with correct capacity', cyclesOk, `available=${available(cy)}`);
  c('no seat accumulation across cycles',
    all('SELECT id FROM requisition_seat WHERE request_id=?', [cy]).length === 4,
    `seats=${all('SELECT id FROM requisition_seat WHERE request_id=?', [cy]).length}`);
  c('seat identities are stable across cycles',
    all('SELECT id FROM requisition_seat WHERE request_id=? ORDER BY seat_no', [cy]).map((s) => s.id).join(',')
    === seatIdsStart.join(','));
  c('the filled seat stayed filled through every cycle',
    get("SELECT COUNT(*) c FROM requisition_seat WHERE request_id=? AND status='filled'", [cy]).c === 1);

  console.log(`\n${fail === 0 ? '✓' : '✗'} BL-04: ${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
})();
