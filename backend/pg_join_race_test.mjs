// BL-27 concurrency — one joined application per candidate, across processes.
//
//   PG_TEST_URL=… node pg_join_race_test.mjs
//   node pg_join_race_test.mjs --own      (local convenience only)
//
// WHY THIS CANNOT BE A SAME-PROCESS TEST
//   The database surface is synchronous, so one Node process serialises every
//   request it handles: the in-transaction eligibility recheck would appear to
//   work perfectly even if the partial unique index did not exist at all. Only
//   independent OS processes sharing one PostgreSQL can put two joins for the
//   same candidate inside overlapping transactions, which is the only condition
//   under which the index is the thing doing the work.
//
// WHAT "EXACTLY ONE WINNER" MEANS HERE — and why it is a legitimate demand,
// unlike the headcount race. Headcount updates are last-writer-wins by design,
// so several could legitimately succeed. Joining is not: the rule is a hard
// uniqueness invariant, so of N overlapping joins for ONE candidate exactly one
// must commit and every other must be a deterministic 409 with the same code.
// A second success would be the bug this batch exists to prevent.

import { startCluster } from './test-harness/pg-cluster.mjs';

let pass = 0; let fail = 0;
const c = (n, ok, x = '') => { console.log((ok ? '  ✅ ' : '  ❌ ') + n + (x ? ` ${x}` : '')); ok ? pass++ : fail++; };

const own = process.argv.includes('--own') || !process.env.PG_TEST_URL;
let cluster = null;

try {
  cluster = await startCluster({ processes: 3, ownDatabase: own });
  const { api, race, db } = cluster;
  const { get, all } = db;
  const { JOIN_CONFLICT } = await import('./src/lib/join.js');
  const { JOINED_UNIQUE_INDEX } = await import('./src/lib/join-reconciliation.js');

  const recruiter = await cluster.login('recruiter@arabtec.com');
  const hrMgr = await cluster.login('hr.manager@arabtec.com');
  const recMgr = await cluster.login('rec.manager@arabtec.com');
  const meta = await api(0, '/api/requests/meta/form', { token: hrMgr });

  const appStatus = (id) => get('SELECT status FROM application WHERE id=$1', [id]).status;
  const reqRow = (id) => get('SELECT status, headcount, headcount_filled FROM recruitment_request WHERE id=$1', [id]);
  const seatRows = (id) => all('SELECT seat_no, status, filled_by_application_id link FROM requisition_seat WHERE request_id=$1 ORDER BY seat_no', [id]);
  const filledBy = (appId) => Number(get('SELECT COUNT(*) c FROM requisition_seat WHERE filled_by_application_id=$1', [appId]).c);
  const joinedSeatsFor = (candId) => Number(get(
    `SELECT COUNT(*) c FROM requisition_seat s JOIN application a ON a.id=s.filled_by_application_id
      WHERE a.candidate_id=$1`, [candId],
  ).c);
  const joinedApps = (candId) => Number(get(
    "SELECT COUNT(*) c FROM application WHERE candidate_id=$1 AND status='joined'", [candId],
  ).c);
  const historyTo = (appId) => Number(get(
    "SELECT COUNT(*) c FROM application_stage_history WHERE application_id=$1 AND to_status='joined'", [appId],
  ).c);
  const seatAct = (reqId) => Number(get("SELECT COUNT(*) c FROM request_activity WHERE request_id=$1 AND type='seat_filled'", [reqId]).c);
  // Only the JOIN transition. The four setup moves also write
  // `application.status_changed`, so the action alone would count them too;
  // the new value is what distinguishes the transition under test.
  const joinAudit = (appId) => Number(get(
    `SELECT COUNT(*) c FROM audit_log WHERE action='application.status_changed'
      AND CAST(entity_id AS INTEGER)=$1 AND new_value LIKE '%joined%'`, [appId],
  ).c);
  const joinCandAct = (appId) => Number(get(
    "SELECT COUNT(*) c FROM candidate_activity WHERE application_id=$1 AND (note LIKE '%joined%' OR type='candidate_joined')", [appId],
  ).c);

  let seq = 0;
  const mkReq = async (headcount = 2) => {
    seq += 1;
    const r = await api(0, '/api/requests', {
      method: 'POST', token: hrMgr,
      body: {
        title: `Join Race ${seq}`, projectId: meta.json.projects[0].id,
        departmentId: meta.json.departments[0].id, headcount, priority: 'high',
      },
    });
    const id = r.json.request.id;
    await api(0, `/api/requests/${id}/submit`, { method: 'POST', token: hrMgr });
    await api(0, `/api/requests/${id}/approve`, { method: 'POST', token: hrMgr, body: {} });
    await api(0, `/api/requests/${id}/assign`, { method: 'POST', token: recMgr, body: { ownerId: meta.json.recruiters[0].id } });
    return id;
  };
  const mkCand = async (label) => (await api(0, '/api/candidates', {
    method: 'POST', token: recruiter,
    body: { fullName: label, email: `${label.replace(/\W+/g, '.').toLowerCase()}@example.com` },
  })).json.candidate.id;
  /** An application parked at offer_sent — one move away from joining. */
  const armed = async (candId, reqId) => {
    const appId = (await api(0, '/api/applications', {
      method: 'POST', token: recruiter, body: { candidateId: candId, requestId: reqId },
    })).json.application.id;
    for (const st of ['matched', 'interviewing', 'issuing_offer', 'offer_sent']) {
      await api(0, `/api/applications/${appId}/move`, { method: 'POST', token: recruiter, body: { status: st, reason: 'setup' } });
    }
    return appId;
  };
  const settle = (rs) => rs.map((r) => (r.status === 'fulfilled' ? r.value : { status: 0, json: null }));
  const joinVia = (i, appId) => api(i, `/api/applications/${appId}/move`, {
    method: 'POST', token: recruiter, body: { status: 'joined', reason: 'race' },
  });

  /* ------------------------- 0. the index is really there ---------------- */
  console.log('\n— 0. the invariant exists in PostgreSQL —');
  {
    const idx = get('SELECT indexdef FROM pg_indexes WHERE indexname=$1', [JOINED_UNIQUE_INDEX]);
    c('the partial unique index was created', !!idx, idx ? '' : 'MISSING');
    c('it is UNIQUE and partial on joined', !!idx
      && /UNIQUE/i.test(idx.indexdef) && /WHERE/i.test(idx.indexdef) && /joined/i.test(idx.indexdef),
      idx?.indexdef);
  }

  /* ---------- 1. ONE candidate, TWO requisitions, overlapping joins ------- */
  console.log('\n— 1. one candidate joining two requisitions at once —');
  {
    const candId = await mkCand('Race One Candidate');
    const reqA = await mkReq(2);
    const reqB = await mkReq(2);
    const appA = await armed(candId, reqA);
    const appB = await armed(candId, reqB);
    const before = { a: reqRow(reqA), b: reqRow(reqB), seatsA: seatRows(reqA), seatsB: seatRows(reqB) };

    const rs = settle(await race([() => joinVia(0, appA), () => joinVia(1, appB)]));
    const ok = rs.filter((r) => r.status === 200);
    const conflict = rs.filter((r) => r.status === 409);

    c('every request settled', ok.length + conflict.length === rs.length,
      rs.map((r) => r.status).join(','));
    c('exactly one join succeeded', ok.length === 1, `${ok.length} succeeded`);
    c('the other is a deterministic 409', conflict.length === 1, `${conflict.length} conflicts`);
    c('the loser carries the stable code',
      conflict.every((r) => r.json?.code === JOIN_CONFLICT.ALREADY_JOINED_ELSEWHERE),
      conflict.map((r) => r.json?.code).join(','));
    c('no SQL detail leaked to the client',
      conflict.every((r) => !/unique|index|constraint|duplicate key|sql|pg_/i.test(r.json?.error || '')),
      conflict.map((r) => r.json?.error).join(' | '));
    c('the race spanned processes', new Set(rs.map((r) => r.viaPid).filter(Boolean)).size >= 2);

    c('the candidate holds exactly ONE joined application', joinedApps(candId) === 1, `n=${joinedApps(candId)}`);
    c('exactly one seat is filled by that candidate', joinedSeatsFor(candId) === 1, `n=${joinedSeatsFor(candId)}`);

    const wonA = appStatus(appA) === 'joined';
    const winner = wonA ? { app: appA, req: reqA } : { app: appB, req: reqB };
    const loser = wonA ? { app: appB, req: reqB, was: before.b, seats: before.seatsB }
      : { app: appA, req: reqA, was: before.a, seats: before.seatsA };

    c('the winner is fully written',
      historyTo(winner.app) === 1 && filledBy(winner.app) === 1
      && seatAct(winner.req) === 1 && joinAudit(winner.app) === 1,
      `history=${historyTo(winner.app)} seat=${filledBy(winner.app)} act=${seatAct(winner.req)} audit=${joinAudit(winner.app)}`);
    c('the winner requisition counted exactly one fill', Number(reqRow(winner.req).headcount_filled) === 1,
      JSON.stringify(reqRow(winner.req)));

    c('the loser application did not move', appStatus(loser.app) === 'offer_sent', appStatus(loser.app));
    c('the loser took no seat', filledBy(loser.app) === 0);
    c('the loser requisition is byte-identical',
      JSON.stringify(reqRow(loser.req)) === JSON.stringify(loser.was)
      && JSON.stringify(seatRows(loser.req)) === JSON.stringify(loser.seats),
      JSON.stringify(reqRow(loser.req)));
    c('no partial history/activity/audit on the loser',
      historyTo(loser.app) === 0 && seatAct(loser.req) === 0
      && joinAudit(loser.app) === 0 && joinCandAct(loser.app) === 0,
      `history=${historyTo(loser.app)} act=${seatAct(loser.req)} audit=${joinAudit(loser.app)} cand=${joinCandAct(loser.app)}`);
    c('exactly ONE join history/activity/audit set exists for the candidate',
      historyTo(winner.app) + historyTo(loser.app) === 1
      && joinCandAct(winner.app) + joinCandAct(loser.app) === 1
      && joinAudit(winner.app) + joinAudit(loser.app) === 1
      && seatAct(winner.req) + seatAct(loser.req) === 1,
      `history=${historyTo(winner.app) + historyTo(loser.app)} cand=${joinCandAct(winner.app) + joinCandAct(loser.app)} audit=${joinAudit(winner.app) + joinAudit(loser.app)}`);

    console.log('  · a retry after the race is still refused');
    const retry = await joinVia(2, loser.app);
    c('the loser stays refused on retry', retry.status === 409, `got ${retry.status}`);
    c('with the same stable code', retry.json?.code === JOIN_CONFLICT.ALREADY_JOINED_ELSEWHERE);
    c('and still holds exactly one joined application', joinedApps(candId) === 1);
  }

  /* -------------- 2. one candidate, THREE overlapping joins -------------- */
  console.log('\n— 2. one candidate, three overlapping joins —');
  {
    const candId = await mkCand('Race Three Ways');
    const reqs = [];
    const apps = [];
    for (let i = 0; i < 3; i += 1) {
      const r = await mkReq(2);
      reqs.push(r);
      apps.push(await armed(candId, r));
    }
    const rs = settle(await race(apps.map((a, i) => () => joinVia(i, a))));
    const ok = rs.filter((r) => r.status === 200);
    c('exactly one of three succeeded', ok.length === 1, `${ok.length} succeeded (${rs.map((r) => r.status).join(',')})`);
    c('the other two are 409 with the stable code',
      rs.filter((r) => r.status === 409 && r.json?.code === JOIN_CONFLICT.ALREADY_JOINED_ELSEWHERE).length === 2);
    c('one joined application', joinedApps(candId) === 1, `n=${joinedApps(candId)}`);
    c('one filled seat', joinedSeatsFor(candId) === 1, `n=${joinedSeatsFor(candId)}`);
    c('exactly one requisition moved its counter',
      reqs.filter((r) => Number(reqRow(r).headcount_filled) === 1).length === 1,
      reqs.map((r) => reqRow(r).headcount_filled).join(','));
    c('exactly one stage-history row across all three applications',
      apps.reduce((s, a) => s + historyTo(a), 0) === 1);
    c('exactly one seat_filled activity across all three requisitions',
      reqs.reduce((s, r) => s + seatAct(r), 0) === 1);
  }

  /* ------------- 3. DIFFERENT candidates — no global serialization ------- */
  console.log('\n— 3. different candidates joining concurrently —');
  {
    const pairs = [];
    for (let i = 0; i < 4; i += 1) {
      const reqId = await mkReq(2);
      const candId = await mkCand(`Independent Race ${i}`);
      pairs.push({ reqId, candId, appId: await armed(candId, reqId) });
    }
    const rs = settle(await race(pairs.map((p, i) => () => joinVia(i, p.appId))));
    c('all four independent joins succeeded', rs.filter((r) => r.status === 200).length === 4,
      `${rs.filter((r) => r.status === 200).length}/4 (${rs.map((r) => r.status).join(',')})`);
    c('each candidate holds exactly one joined application',
      pairs.every((p) => joinedApps(p.candId) === 1));
    c('each filled exactly one seat', pairs.every((p) => filledBy(p.appId) === 1));
    c('each requisition counted exactly one fill',
      pairs.every((p) => Number(reqRow(p.reqId).headcount_filled) === 1),
      pairs.map((p) => reqRow(p.reqId).headcount_filled).join(','));
    c('each has exactly one history row, activity and audit',
      pairs.every((p) => historyTo(p.appId) === 1 && seatAct(p.reqId) === 1 && joinAudit(p.appId) === 1));
    c('no seat carries two commitments',
      pairs.every((p) => {
        const filled = seatRows(p.reqId).filter((s) => s.status === 'filled');
        return filled.length === 1 && new Set(filled.map((s) => s.link)).size === 1;
      }));
  }

  /* --------- 4. different candidates racing for ONE remaining seat ------- */
  console.log('\n— 4. two candidates racing for the last seat —');
  {
    const reqId = await mkReq(1);
    const a = await armed(await mkCand('Last Seat A'), reqId);
    const b = await armed(await mkCand('Last Seat B'), reqId);
    const rs = settle(await race([() => joinVia(0, a), () => joinVia(1, b)]));
    const ok = rs.filter((r) => r.status === 200);
    c('exactly one candidate took the last seat', ok.length === 1,
      `${ok.length} succeeded (${rs.map((r) => r.status).join(',')})`);
    c('the other was refused, not overfilled',
      rs.filter((r) => r.status === 409).length === 1, rs.map((r) => r.status).join(','));
    c('exactly one seat is filled', seatRows(reqId).filter((s) => s.status === 'filled').length === 1);
    c('the seat carries exactly one commitment',
      new Set(seatRows(reqId).filter((s) => s.status === 'filled').map((s) => s.link)).size === 1);
    c('headcount_filled is 1, not 2', Number(reqRow(reqId).headcount_filled) === 1,
      JSON.stringify(reqRow(reqId)));
    c('only one application is joined', [a, b].filter((id) => appStatus(id) === 'joined').length === 1);
    c('one seat_filled activity, not two', seatAct(reqId) === 1, `n=${seatAct(reqId)}`);
  }

  /* ---------------------------- 5. global sanity ------------------------- */
  console.log('\n— 5. whole-database consistency —');
  {
    const dupes = all(
      "SELECT candidate_id FROM application WHERE status='joined' GROUP BY candidate_id HAVING COUNT(*) > 1",
    );
    c('no candidate anywhere holds two joined applications', dupes.length === 0, JSON.stringify(dupes));
    c('every filled seat points at a joined application',
      all("SELECT filled_by_application_id id FROM requisition_seat WHERE status='filled'")
        .every((s) => appStatus(s.id) === 'joined'));
    c('headcount_filled matches filled seats everywhere',
      all('SELECT id, headcount_filled hf FROM recruitment_request').every((r) =>
        Number(r.hf) === Number(get("SELECT COUNT(*) c FROM requisition_seat WHERE request_id=$1 AND status='filled'", [r.id]).c)));
  }

  console.log('\n— hygiene —');
  c('no idle-in-transaction connection remains', cluster.idleInTransaction() === 0,
    `n=${cluster.idleInTransaction()}`);
} catch (e) {
  c(`join race threw: ${e.message}`, false);
} finally {
  if (cluster) {
    const pids = [...cluster.pids];
    await cluster.stop();
    await new Promise((r) => setTimeout(r, 300));
    c('no orphan child process remains',
      pids.filter((pid) => { try { process.kill(pid, 0); return true; } catch { return false; } }).length === 0);
  }
}

console.log(`\n${fail === 0 ? '✓' : '✗'} join race: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
