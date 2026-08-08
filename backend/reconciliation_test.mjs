// Seat reconciliation helper — unit-level, no routes involved.
//
//   node --experimental-sqlite reconciliation_test.mjs
//
// Rules are exercised directly against seat rows so they are pinned independently
// of PUT /:id. Route integration is tested separately.
//
// Boots through server.js like every other green suite: importing prisma/seed.js
// alone does NOT produce a usable database, because ensureSchema() and
// bootSeedIfEmpty() run from the server bootstrap. An earlier version seeded
// directly and failed on a foreign key, then on an empty users table.

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'file:/tmp/arabtec_recon.db';
process.env.PORT = '4134';
import fs from 'node:fs';
for (const f of ['/tmp/arabtec_recon.db', '/tmp/arabtec_recon.db-journal']) { try { fs.rmSync(f); } catch {} }
await import('./prisma/seed.js');
await import('./src/server.js');

// Readiness, not liveness: /api/health answers as soon as the port is open, but
// the API gate 503s until schema and seed finish.
const READY_DEADLINE = Date.now() + 30000;
for (;;) {
  try {
    const r = await fetch('http://127.0.0.1:4134/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'readiness@probe.invalid', password: 'x' }),
    });
    if (r.status !== 503) break;
  } catch { /* not up yet */ }
  if (Date.now() > READY_DEADLINE) throw new Error('server never became ready');
  await new Promise((r) => setTimeout(r, 150));
}

const { get, all, run, tx } = await import('./src/lib/db.js');
const {
  reconcileSeatsForHeadcount, reconciliationIssues, ISSUE, ReconcileConflict, MAX_HEADCOUNT,
} = await import('./src/lib/seat-reconciliation.js');

let pass = 0; let fail = 0;
const c = (n, ok, x = '') => { console.log((ok ? '  ✅ ' : '  ❌ ') + n + (x ? ` ${x}` : '')); ok ? pass++ : fail++; };

// Real seeded ids: recruitment_request has NOT NULL foreign keys, so synthetic
// rows must reference actual users/projects/departments.
const seedRow = (sql, label) => {
  const row = get(sql);
  if (!row) throw new Error(`fixture bootstrap failed: no ${label} row — the seed did not run`);
  return row.id;
};
const REF = {
  user: seedRow('SELECT id FROM users ORDER BY id LIMIT 1', 'users'),
  project: seedRow('SELECT id FROM project ORDER BY id LIMIT 1', 'project'),
  department: seedRow('SELECT id FROM department ORDER BY id LIMIT 1', 'department'),
  bu: get('SELECT id FROM business_unit ORDER BY id LIMIT 1')?.id ?? null,
};

let seq = 0;
/** Build a requisition with seats in exact states. No routes, no HTTP. */
const mk = ({ headcount, status, seats }) => {
  seq += 1;
  run(`INSERT INTO recruitment_request
        (ticket_no, title, headcount, status, created_by, project_id, department_id, business_unit_id)
       VALUES (?,?,?,?,?,?,?,?)`,
  [`REQ-T-${seq}`, `Probe ${seq}`, headcount, status, REF.user, REF.project, REF.department, REF.bu]);
  const id = get('SELECT id FROM recruitment_request WHERE ticket_no=?', [`REQ-T-${seq}`]).id;
  seats.forEach((s, i) => {
    run('INSERT INTO requisition_seat (request_id, seat_no, status, filled_by_application_id) VALUES (?,?,?,?)',
      [id, i + 1, s.status, s.link ?? null]);
  });
  return id;
};
const active = (id) => get("SELECT COUNT(*) c FROM requisition_seat WHERE request_id=? AND status IN ('open','reopened','reserved')", [id]).c;
const rows = (id) => all('SELECT seat_no, status, filled_by_application_id link FROM requisition_seat WHERE request_id=? ORDER BY seat_no', [id]);
const codes = (id) => reconciliationIssues(id).map((i) => i.code);

/* --------------------- fixture guard (negative control) ------------------- */
// Removing the seed import is NOT a valid negative control: server.js runs
// bootSeedIfEmpty() and seeds anyway. What must be proven is that the fixture
// refuses to run on an empty table instead of throwing a cryptic TypeError.
console.log('\n— fixture guard —');
{
  run('CREATE TABLE IF NOT EXISTS _empty_probe (id INTEGER PRIMARY KEY)');
  let msg = '';
  try { seedRow('SELECT id FROM _empty_probe LIMIT 1', 'empty_probe'); }
  catch (err) { msg = err.message; }
  c('an absent seed row fails cleanly and names the table',
    /fixture bootstrap failed: no empty_probe row/.test(msg), msg);
  run('DROP TABLE _empty_probe');
}

/* ------------------------------- increase -------------------------------- */
console.log('\n— increase on a recruiting requisition —');
const a = mk({ headcount: 2, status: 'sourcing', seats: [{ status: 'open' }, { status: 'open' }] });
let r = reconcileSeatsForHeadcount({ requestId: a, newHeadcount: 3, status: 'sourcing' });
c('increase by one creates exactly one seat', r.created === 1 && r.restored === 0, JSON.stringify(r));
c('active capacity matches the new headcount', active(a) === 3, `active=${active(a)}`);

const b = mk({ headcount: 5, status: 'sourcing', seats: [{ status: 'open' }] });
r = reconcileSeatsForHeadcount({ requestId: b, newHeadcount: 5, status: 'sourcing' });
c('increase by multiple creates the exact shortfall', r.created === 4, JSON.stringify(r));

console.log('\n— restore before create —');
const d = mk({ headcount: 3, status: 'sourcing', seats: [
  { status: 'open' }, { status: 'cancelled' }, { status: 'cancelled' },
] });
r = reconcileSeatsForHeadcount({ requestId: d, newHeadcount: 3, status: 'sourcing' });
c('restore-only: reuses cancelled seats, creates nothing', r.restored === 2 && r.created === 0, JSON.stringify(r));
c('no new rows were added', rows(d).length === 3);
c('restored seats keep their identities', rows(d).map((s) => s.seat_no).join(',') === '1,2,3');

const e = mk({ headcount: 4, status: 'sourcing', seats: [{ status: 'open' }, { status: 'cancelled' }] });
r = reconcileSeatsForHeadcount({ requestId: e, newHeadcount: 4, status: 'sourcing' });
c('mixed: restores one then creates the rest', r.restored === 1 && r.created === 2, JSON.stringify(r));
c('new seat numbers append after the historical maximum',
  rows(e).map((s) => s.seat_no).join(',') === '1,2,3,4');

console.log('\n— a linked cancelled seat is NEVER reused —');
const f = mk({ headcount: 2, status: 'sourcing', seats: [
  { status: 'open' }, { status: 'cancelled', link: 42 },
] });
r = reconcileSeatsForHeadcount({ requestId: f, newHeadcount: 2, status: 'sourcing' });
c('the linked seat stays cancelled and linked',
  rows(f).find((s) => s.seat_no === 2).status === 'cancelled'
  && rows(f).find((s) => s.seat_no === 2).link === 42);
c('a new seat was created instead', r.created === 1, JSON.stringify(r));

/* ------------------------------- decrease -------------------------------- */
console.log('\n— decrease —');
const g = mk({ headcount: 5, status: 'sourcing', seats: [
  { status: 'open' }, { status: 'open' }, { status: 'open' }, { status: 'open' }, { status: 'open' },
] });
r = reconcileSeatsForHeadcount({ requestId: g, newHeadcount: 3, status: 'sourcing' });
c('retires exactly the excess', r.retired === 2, JSON.stringify(r));
c('active capacity is now the new headcount', active(g) === 3);
c('retirement takes the HIGHEST seat numbers first',
  rows(g).filter((s) => s.status === 'cancelled').map((s) => s.seat_no).join(',') === '4,5');
c('no seat row was deleted', rows(g).length === 5);

const h = mk({ headcount: 4, status: 'sourcing', seats: [
  { status: 'filled', link: 7 }, { status: 'filled', link: 8 }, { status: 'open' }, { status: 'open' },
] });
r = reconcileSeatsForHeadcount({ requestId: h, newHeadcount: 2, status: 'sourcing' });
c('decrease exactly to the filled count is allowed', r.retired === 2, JSON.stringify(r));
c('filled seats are untouched',
  rows(h).filter((s) => s.status === 'filled').length === 2);
c('their links survive', rows(h).filter((s) => s.link !== null).length === 2);

let conflicted = false;
try { reconcileSeatsForHeadcount({ requestId: h, newHeadcount: 1, status: 'sourcing' }); }
catch (err) { conflicted = err instanceof ReconcileConflict && /already filled/.test(err.message); }
c('decrease below filled commitments is a conflict', conflicted);
c('and nothing changed', rows(h).filter((s) => s.status === 'filled').length === 2 && active(h) === 0);

/* ------------------------------- no-op ----------------------------------- */
console.log('\n— no-op and validation —');
const i2 = mk({ headcount: 3, status: 'sourcing', seats: [{ status: 'open' }, { status: 'open' }, { status: 'open' }] });
const beforeNoop = JSON.stringify(rows(i2));
r = reconcileSeatsForHeadcount({ requestId: i2, newHeadcount: 3, status: 'sourcing' });
c('repeating the same headcount writes nothing',
  r.created === 0 && r.restored === 0 && r.retired === 0 && JSON.stringify(rows(i2)) === beforeNoop);

for (const bad of [0, -1, 1.5, MAX_HEADCOUNT + 1, 'x']) {
  let threw = false;
  try { reconcileSeatsForHeadcount({ requestId: i2, newHeadcount: bad, status: 'sourcing' }); }
  catch (err) { threw = err instanceof ReconcileConflict; }
  c(`headcount ${bad} is rejected`, threw);
}

/* ------------------------- closed requisition ---------------------------- */
console.log('\n— closed requisition gains INVENTORY, not capacity —');
const j = mk({ headcount: 2, status: 'closed', seats: [
  { status: 'filled', link: 9 }, { status: 'cancelled' },
] });
r = reconcileSeatsForHeadcount({ requestId: j, newHeadcount: 4, status: 'closed' });
c('future seats are created', r.created === 2 && r.deferred === true, JSON.stringify(r));
c('but NO active capacity is exposed', active(j) === 0, `active=${active(j)}`);
c('they are reusable by a later reopen',
  rows(j).filter((s) => s.status === 'cancelled' && s.link === null).length === 3);
c('the filled seat is untouched', rows(j).find((s) => s.seat_no === 1).status === 'filled');

/* --------------------------- BL-23 issue codes ---------------------------- */
console.log('\n— reconciliation issue codes —');
const k = mk({ headcount: 2, status: 'sourcing', seats: [{ status: 'open' }] });
c('ACTIVE_CAPACITY_SHORTAGE', codes(k).includes(ISSUE.ACTIVE_CAPACITY_SHORTAGE));
const l = mk({ headcount: 1, status: 'sourcing', seats: [{ status: 'open' }, { status: 'open' }] });
c('ACTIVE_CAPACITY_EXCESS', codes(l).includes(ISSUE.ACTIVE_CAPACITY_EXCESS));
const m = mk({ headcount: 1, status: 'sourcing', seats: [{ status: 'filled', link: 1 }, { status: 'filled', link: 2 }] });
c('FILLED_EXCEEDS_HEADCOUNT', codes(m).includes(ISSUE.FILLED_EXCEEDS_HEADCOUNT));
const o = mk({ headcount: 1, status: 'sourcing', seats: [{ status: 'filled' }] });
c('FILLED_SEAT_WITHOUT_LINK', codes(o).includes(ISSUE.FILLED_SEAT_WITHOUT_LINK));
const p = mk({ headcount: 1, status: 'sourcing', seats: [{ status: 'open', link: 5 }] });
c('LINKED_SEAT_IN_AVAILABLE_STATUS', codes(p).includes(ISSUE.LINKED_SEAT_IN_AVAILABLE_STATUS));
const q = mk({ headcount: 1, status: 'closed', seats: [{ status: 'open' }] });
c('CLOSED_REQUEST_HAS_ACTIVE_CAPACITY', codes(q).includes(ISSUE.CLOSED_REQUEST_HAS_ACTIVE_CAPACITY));
const s2 = mk({ headcount: 3, status: 'closed', seats: [{ status: 'cancelled' }] });
c('MISSING_FUTURE_CAPACITY', codes(s2).includes(ISSUE.MISSING_FUTURE_CAPACITY));
const t = mk({ headcount: 1, status: 'sourcing', seats: [{ status: 'weird_state' }] });
c('IMPOSSIBLE_SEAT_STATE', codes(t).includes(ISSUE.IMPOSSIBLE_SEAT_STATE));
const u = mk({ headcount: 2, status: 'sourcing', seats: [{ status: 'open' }, { status: 'open' }] });
run('UPDATE requisition_seat SET seat_no=1 WHERE request_id=? AND seat_no=2', [u]);
c('DUPLICATE_SEAT_NUMBER', codes(u).includes(ISSUE.DUPLICATE_SEAT_NUMBER));

console.log('\n— the deferred BL-01/BL-13 lifecycle finding —');
const v = mk({ headcount: 2, status: 'pending', seats: [{ status: 'open' }, { status: 'open' }] });
const lifecycle = reconciliationIssues(v).find((x) => x.code === ISSUE.LIFECYCLE_PREMATURE_CAPACITY);
c('a pending requisition with open seats is REPORTED', !!lifecycle);
c('cross-referenced to BL-01 and BL-13',
  lifecycle?.relatedFindings?.includes('BL-01') && lifecycle?.relatedFindings?.includes('BL-13'));
c('reported as a warning, not auto-repaired', lifecycle?.severity === 'warning' && active(v) === 2);

console.log('\n— output carries no PII —');
const blob = JSON.stringify(reconciliationIssues(m));
c('issues contain ids and counts only', !/[A-Za-z]+@|full_name|candidate_no/.test(blob), blob.slice(0, 80));

console.log('\n— rollback inside a transaction —');
const w = mk({ headcount: 2, status: 'sourcing', seats: [{ status: 'open' }, { status: 'open' }] });
const beforeTx = JSON.stringify(rows(w));
try {
  tx(() => {
    reconcileSeatsForHeadcount({ requestId: w, newHeadcount: 5, status: 'sourcing' });
    throw new Error('injected');
  });
} catch { /* expected */ }
c('a rolled-back reconciliation leaves seats untouched', JSON.stringify(rows(w)) === beforeTx);

try { fs.rmSync('/tmp/arabtec_recon.db'); fs.rmSync('/tmp/arabtec_recon.db-journal'); } catch { /* already gone */ }
console.log(`\n${fail === 0 ? '✓' : '✗'} reconciliation: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
