// BL-04 concurrency — reopen races across independent backend processes.
//
//   node pg_reopen_race_test.mjs --own
//   PG_TEST_URL=… node pg_reopen_race_test.mjs
//
// The reopen transition is guarded by a CONDITIONAL update (`... WHERE id=? AND
// status=?`), not a read-then-write check. Only a real multi-process race can
// tell the two apart: within one process the synchronous DB surface serialises
// everything, so a read-then-write check would look correct.

import { startCluster } from './test-harness/pg-cluster.mjs';

let pass = 0; let fail = 0;
const c = (n, ok, x = '') => { console.log((ok ? '  ✅ ' : '  ❌ ') + n + (x ? ` ${x}` : '')); ok ? pass++ : fail++; };

const own = process.argv.includes('--own') || !process.env.PG_TEST_URL;
let cluster = null;

try {
  cluster = await startCluster({ processes: 3, ownDatabase: own });
  const { api, race, db } = cluster;
  const { get, all } = db;

  const hrMgr = await cluster.login('hr.manager@arabtec.com');
  const recMgr = await cluster.login('rec.manager@arabtec.com');
  const meta = await api(0, '/api/requests/meta/form', { token: hrMgr });

  let n = 0;
  const mkClosed = async (headcount) => {
    n += 1;
    const r = await api(0, '/api/requests', {
      method: 'POST', token: hrMgr,
      body: {
        title: `Reopen Race ${n}`, projectId: meta.json.projects[0].id,
        departmentId: meta.json.departments[0].id, headcount, priority: 'high',
      },
    });
    const id = r.json.request.id;
    await api(0, `/api/requests/${id}/submit`, { method: 'POST', token: hrMgr });
    await api(0, `/api/requests/${id}/approve`, { method: 'POST', token: hrMgr, body: {} });
    await api(0, `/api/requests/${id}/assign`, { method: 'POST', token: recMgr, body: { ownerId: meta.json.recruiters[0].id } });
    await api(0, `/api/requests/${id}/close`, { method: 'POST', token: hrMgr, body: { reason: 'race setup' } });
    return id;
  };
  const available = (id) => get(
    "SELECT COUNT(*) c FROM requisition_seat WHERE request_id=$1 AND status IN ('open','reopened','reserved')", [id],
  ).c;
  const seatCount = (id) => get('SELECT COUNT(*) c FROM requisition_seat WHERE request_id=$1', [id]).c;
  const activityCount = (id) => get("SELECT COUNT(*) c FROM request_activity WHERE request_id=$1 AND type='reopened'", [id]).c;

  /* --------------------- A. same requisition, 6 racers -------------------- */
  console.log('\n— A. six overlapping reopens of the SAME requisition —');
  const idA = await mkClosed(4);
  const seatsBefore = seatCount(idA);
  const auditBefore = get("SELECT COUNT(*) c FROM audit_log WHERE action='request.reopened'").c;

  const resultsA = await race(Array.from({ length: 6 }, (_, i) => () => api(i, `/api/requests/${idA}/reopen`, {
    method: 'POST', token: hrMgr, body: { reason: `racer ${i}` },
  })));
  const settledA = resultsA.map((r) => (r.status === 'fulfilled' ? r.value : { status: 0 }));
  const okA = settledA.filter((r) => r.status === 200);
  const conflictA = settledA.filter((r) => r.status === 409);

  c('exactly one reopen succeeded', okA.length === 1, `${okA.length} succeeded`);
  c('every other attempt returned the standard conflict', conflictA.length === 5,
    `${conflictA.length} conflicts of ${settledA.length - okA.length} failures`);
  c('the race really spanned processes', new Set(settledA.map((r) => r.viaPid).filter(Boolean)).size >= 2);
  c('exactly one reopened activity entry', activityCount(idA) === 1, `n=${activityCount(idA)}`);
  c('exactly one reopened audit entry',
    get("SELECT COUNT(*) c FROM audit_log WHERE action='request.reopened'").c === auditBefore + 1);
  c('no duplicate seats were created', seatCount(idA) === seatsBefore,
    `${seatsBefore} -> ${seatCount(idA)}`);
  c('final capacity equals approved headcount', available(idA) === 4, `available=${available(idA)}`);
  c('final status is reopened',
    get('SELECT status FROM recruitment_request WHERE id=$1', [idA]).status === 'reopened');
  const dupSeatNos = all('SELECT seat_no, COUNT(*) c FROM requisition_seat WHERE request_id=$1 GROUP BY seat_no HAVING COUNT(*) > 1', [idA]);
  c('no duplicate seat identities', dupSeatNos.length === 0);

  /* ------------------ B. different requisitions in parallel --------------- */
  console.log('\n— B. simultaneous reopens of DIFFERENT requisitions —');
  const ids = [];
  for (let i = 0; i < 4; i += 1) ids.push(await mkClosed(2));
  const before = Object.fromEntries(ids.map((id) => [id, seatCount(id)]));

  const resultsB = await race(ids.map((id, i) => () => api(i, `/api/requests/${id}/reopen`, {
    method: 'POST', token: hrMgr, body: { reason: 'parallel reopen' },
  })));
  const okB = resultsB.filter((r) => r.status === 'fulfilled' && r.value.status === 200);
  c('all four unrelated reopens succeeded — no unnecessary serialization',
    okB.length === 4, `${okB.length}/4`);
  c('each has exactly its own capacity restored',
    ids.every((id) => available(id) === 2), ids.map((id) => available(id)).join(','));
  c('no cross-requisition seat changes',
    ids.every((id) => seatCount(id) === before[id]));
  c('each got exactly one activity entry', ids.every((id) => activityCount(id) === 1));

  /* -------------------------- hygiene ------------------------------------ */
  console.log('\n— hygiene —');
  c('no idle-in-transaction connection remains', cluster.idleInTransaction() === 0,
    `n=${cluster.idleInTransaction()}`);
} catch (e) {
  c(`reopen race threw: ${e.message}`, false);
} finally {
  if (cluster) {
    const pids = [...cluster.pids];
    await cluster.stop();
    await new Promise((r) => setTimeout(r, 300));
    const alive = pids.filter((pid) => { try { process.kill(pid, 0); return true; } catch { return false; } });
    c('no orphan child process remains', alive.length === 0);
  }
}

console.log(`\n${fail === 0 ? '✓' : '✗'} BL-04 concurrency: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
