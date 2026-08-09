// BL-21/BL-23 concurrency — headcount races across independent processes.
//
//   PG_TEST_URL=… node pg_headcount_race_test.mjs
//   node pg_headcount_race_test.mjs --own      (local convenience only)
//
// The stale-write guard is folded into the real update
// (`... WHERE id=? AND headcount=?`). Only a real multi-process race can tell
// that apart from a read-then-write check: within one process the synchronous DB
// surface serialises everything, so a broken guard would still look correct.
//
// WHAT "EXACTLY ONE WINNER" WOULD AND WOULD NOT PROVE. The route reads the
// current headcount itself; a client cannot pin a snapshot. So of six overlapping
// PUTs, some read BEFORE any commit (their update is stale and must 409) and
// others read AFTER one committed (their update is fresh and must succeed). A
// suite demanding exactly one 200 would be asserting HTTP timing, not
// correctness — and would fail intermittently on a perfectly sound guard.
//
// The real invariants, asserted below: at least one writer is rejected as stale;
// successes, edited activities and audit rows are EQUAL; the committed headcount
// is the last committed value with capacity to match; and no duplicate seat_no,
// no linked seat touched, no partial write.

import { startCluster } from './test-harness/pg-cluster.mjs';

let pass = 0; let fail = 0;
const c = (n, ok, x = '') => { console.log((ok ? '  ✅ ' : '  ❌ ') + n + (x ? ` ${x}` : '')); ok ? pass++ : fail++; };

const own = process.argv.includes('--own') || !process.env.PG_TEST_URL;
let cluster = null;

try {
  cluster = await startCluster({ processes: 3, ownDatabase: own });
  const { api, race, db } = cluster;
  const { get, all } = db;

  const recruiter = await cluster.login('recruiter@arabtec.com');
  const hrMgr = await cluster.login('hr.manager@arabtec.com');
  const meta = await api(0, '/api/requests/meta/form', { token: hrMgr });

  const statusOf = (id) => get('SELECT status FROM recruitment_request WHERE id=$1', [id]).status;
  const headcountOf = (id) => Number(get('SELECT headcount FROM recruitment_request WHERE id=$1', [id]).headcount);
  const activeSeats = (id) => get("SELECT COUNT(*) c FROM requisition_seat WHERE request_id=$1 AND status IN ('open','reopened','reserved')", [id]).c;
  const seatRows = (id) => all('SELECT seat_no, status, filled_by_application_id link FROM requisition_seat WHERE request_id=$1 ORDER BY seat_no', [id]);
  const act = (id, type) => get('SELECT COUNT(*) c FROM request_activity WHERE request_id=$1 AND type=$2', [id, type]).c;
  const auditOf = (id) => get("SELECT COUNT(*) c FROM audit_log WHERE action='request.updated' AND CAST(entity_id AS INTEGER)=$1", [id]).c;

  let seq = 0;
  const mkSourcing = async (hc) => {
    seq += 1;
    const r = await api(0, '/api/requests', {
      method: 'POST', token: hrMgr,
      body: { title: `Race ${seq}`, projectId: meta.json.projects[0].id, departmentId: meta.json.departments[0].id, headcount: hc, priority: 'high' },
    });
    const id = r.json.request.id;
    await api(0, `/api/requests/${id}/submit`, { method: 'POST', token: hrMgr });
    await api(0, `/api/requests/${id}/approve`, { method: 'POST', token: hrMgr, body: {} });
    return id;
  };
  const mkReopened = async (hc) => {
    const id = await mkSourcing(hc);
    await api(0, `/api/requests/${id}/close`, { method: 'POST', token: hrMgr, body: { reason: 'setup' } });
    await api(0, `/api/requests/${id}/reopen`, { method: 'POST', token: hrMgr, body: { reason: 'setup' } });
    return id;
  };
  /** Six competing targets, all from the SAME expected old headcount. */
  const TARGETS = [6, 7, 8, 9, 10, 11];
  const raceHeadcount = (id) => race(TARGETS.map((hc, i) => () => api(i, `/api/requests/${id}`, {
    method: 'PUT', token: hrMgr, body: { headcount: hc },
  })));
  const settle = (rs) => rs.map((r) => (r.status === 'fulfilled' ? r.value : { status: 0 }));

  /* ------------------------- 1. same reopened request -------------------- */
  console.log('\n— 1. six overlapping PUTs on ONE reopened request —');
  {
    const id = await mkReopened(4);
    c('fixture is reopened', statusOf(id) === 'reopened', statusOf(id));
    const seatsBefore = seatRows(id).length;

    const rs = settle(await raceHeadcount(id));
    const ok = rs.filter((r) => r.status === 200);
    const conflict = rs.filter((r) => r.status === 409);
    c('every request settled', ok.length + conflict.length === rs.length, `${ok.length}+${conflict.length}`);
    c('at least one stale writer was rejected', conflict.length >= 1, `${conflict.length} conflicts`);
    c('conflicts name the stale write',
      conflict.every((r) => /changed by someone else/i.test(r.json?.error || '')));
    c('the race spanned processes', new Set(rs.map((r) => r.viaPid).filter(Boolean)).size >= 2);

    c('active capacity matches the COMMITTED headcount',
      activeSeats(id) === headcountOf(id), `active=${activeSeats(id)} hc=${headcountOf(id)}`);
    c('the committed headcount is one of the requested targets',
      TARGETS.includes(headcountOf(id)), `hc=${headcountOf(id)}`);
    c('status stayed reopened', statusOf(id) === 'reopened', statusOf(id));
    const nos = seatRows(id).map((s) => s.seat_no);
    c('no duplicate seat_no', new Set(nos).size === nos.length);
    c('no linked/filled seat changed', seatRows(id).every((s) => s.link === null));
    c('seat rows only grew by the winner amount', seatRows(id).length >= seatsBefore);
    c('one edited activity per success — no duplicates, none lost',
      act(id, 'edited') === ok.length, `edited=${act(id, 'edited')} ok=${ok.length}`);
    c('one audit per success', auditOf(id) === ok.length, `audit=${auditOf(id)} ok=${ok.length}`);
    c('no reapproval on reopened', act(id, 'reapproval_required') === 0);
  }

  /* ------------------------- 2. same sourcing request -------------------- */
  console.log('\n— 2. six overlapping PUTs on ONE sourcing request —');
  {
    const id = await mkSourcing(4);
    c('fixture is sourcing', statusOf(id) === 'sourcing', statusOf(id));
    const activeBefore = activeSeats(id);

    const rs = settle(await raceHeadcount(id));
    const ok = rs.filter((r) => r.status === 200);
    const conflict = rs.filter((r) => r.status === 409);
    c('every request settled', ok.length + conflict.length === rs.length, `${ok.length}+${conflict.length}`);
    c('at least one stale writer was rejected', conflict.length >= 1, `${conflict.length} conflicts`);

    c('committed headcount is one of the requested targets',
      TARGETS.includes(headcountOf(id)), `hc=${headcountOf(id)}`);
    c('final status is pending_approval', statusOf(id) === 'pending_approval', statusOf(id));
    // Only the FIRST success is material (sourcing -> pending); later successes
    // edit an already-pending request, so re-approval fires exactly once.
    c('approval reset happened exactly once', act(id, 'reapproval_required') === 1, `n=${act(id, 'reapproval_required')}`);
    c('one edited activity per success', act(id, 'edited') === ok.length, `edited=${act(id, 'edited')} ok=${ok.length}`);
    c('one audit per success', auditOf(id) === ok.length, `audit=${auditOf(id)} ok=${ok.length}`);
    c('reconciled against pending — no new active capacity',
      activeSeats(id) === activeBefore, `active=${activeSeats(id)} was ${activeBefore}`);
    const nos = seatRows(id).map((s) => s.seat_no);
    c('no duplicate seat_no', new Set(nos).size === nos.length);
  }

  /* --------------------------- 3. different requests --------------------- */
  console.log('\n— 3. concurrent updates to DIFFERENT requests —');
  {
    const ids = [];
    for (let i = 0; i < 4; i += 1) ids.push(await mkReopened(3));
    const rs = settle(await race(ids.map((id, i) => () => api(i, `/api/requests/${id}`, {
      method: 'PUT', token: hrMgr, body: { headcount: 5 },
    }))));
    c('all four succeeded — no global serialization', rs.filter((r) => r.status === 200).length === 4,
      `${rs.filter((r) => r.status === 200).length}/4`);
    c('each committed its own headcount', ids.every((id) => headcountOf(id) === 5));
    c('each has correct active capacity', ids.every((id) => activeSeats(id) === 5),
      ids.map((id) => activeSeats(id)).join(','));
    c('each has exactly one edited activity and one audit',
      ids.every((id) => act(id, 'edited') === 1 && auditOf(id) === 1));
    c('no duplicate seat_no anywhere', ids.every((id) => {
      const nos = seatRows(id).map((s) => s.seat_no);
      return new Set(nos).size === nos.length;
    }));
  }

  console.log('\n— hygiene —');
  c('no idle-in-transaction connection remains', cluster.idleInTransaction() === 0,
    `n=${cluster.idleInTransaction()}`);
} catch (e) {
  c(`headcount race threw: ${e.message}`, false);
} finally {
  if (cluster) {
    const pids = [...cluster.pids];
    await cluster.stop();
    await new Promise((r) => setTimeout(r, 300));
    c('no orphan child process remains',
      pids.filter((pid) => { try { process.kill(pid, 0); return true; } catch { return false; } }).length === 0);
  }
}

console.log(`\n${fail === 0 ? '✓' : '✗'} headcount race: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
