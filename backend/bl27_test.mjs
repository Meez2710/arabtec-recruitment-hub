// BL-27 — one joined application per candidate, globally.
//
//   node --experimental-sqlite bl27_test.mjs
//
// WHAT THIS SUITE IS ACTUALLY DEFENDING
//   `joined` is the only application status that commits a seat and consumes a
//   person. Three route bodies could produce it and none of them looked past the
//   requisition in front of them, so the same candidate could be hired onto two
//   projects at once and both requisitions would count a filled seat. The fix is
//   a shared transactional boundary plus a partial unique index; this suite
//   proves both, and proves the states that must NOT block.
//
// WHAT MUST NOT RELEASE ELIGIBILITY. A closed requisition, a cancelled seat and
// a past joining date are all tested as NON-releasing. Employment ends when it
// is recorded as ended, and that workflow does not exist yet — so the only
// correct behaviour today is to keep blocking.

process.env.NODE_ENV = 'test';
process.env.SEED_DEMO_DATA = 'true';
process.env.DATABASE_URL = 'file:/tmp/arabtec_bl27.db';
process.env.PORT = '4141';
import fs from 'node:fs';
for (const f of ['/tmp/arabtec_bl27.db', '/tmp/arabtec_bl27.db-journal']) { try { fs.rmSync(f); } catch {} }
await import('./prisma/seed.js');
await import('./src/server.js');

const B = 'http://localhost:4141';
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

const { get, all, run } = await import('./src/lib/db.js');
const { duplicateJoinedCandidates, JOINED_UNIQUE_INDEX } = await import('./src/lib/join-reconciliation.js');
const { ensureSchema, joinedUniqueness } = await import('./src/lib/schema.js');
const { JOIN_CONFLICT } = await import('./src/lib/join.js');

const appRow = (id) => get('SELECT * FROM application WHERE id=?', [id]);
const reqRow = (id) => get('SELECT status, headcount, headcount_filled FROM recruitment_request WHERE id=?', [id]);
const seatsOf = (id) => all('SELECT seat_no, status, filled_by_application_id link FROM requisition_seat WHERE request_id=? ORDER BY seat_no', [id]);
const filledBy = (appId) => all('SELECT id FROM requisition_seat WHERE filled_by_application_id=?', [appId]).length;
const historyTo = (appId, status) => get('SELECT COUNT(*) c FROM application_stage_history WHERE application_id=? AND to_status=?', [appId, status]).c;
const candActivity = (appId) => get('SELECT COUNT(*) c FROM candidate_activity WHERE application_id=?', [appId]).c;
const seatActivity = (reqId) => get("SELECT COUNT(*) c FROM request_activity WHERE request_id=? AND type='seat_filled'", [reqId]).c;
const joinAudit = (appId) => get("SELECT COUNT(*) c FROM audit_log WHERE action='application.status_changed' AND CAST(entity_id AS INTEGER)=?", [appId]).c;
const postsOf = (reqId) => get('SELECT COUNT(*) c FROM ticket_post WHERE request_id=?', [reqId]).c;
const indexPresent = () => !!get("SELECT name FROM sqlite_master WHERE type='index' AND name=?", [JOINED_UNIQUE_INDEX]);

(async () => {
  const recruiter = await login('recruiter@arabtec.com');
  const hrMgr = await login('hr.manager@arabtec.com');
  const recMgr = await login('rec.manager@arabtec.com');
  const meta = await api('/api/requests/meta/form', { token: hrMgr });

  let seq = 0;
  const mkReq = async (headcount = 3) => {
    seq += 1;
    const r = await api('/api/requests', {
      method: 'POST', token: hrMgr,
      body: {
        title: `BL27 Req ${seq}`, projectId: meta.json.projects[0].id,
        departmentId: meta.json.departments[0].id, headcount, priority: 'high',
      },
    });
    const id = r.json.request.id;
    await api(`/api/requests/${id}/submit`, { method: 'POST', token: hrMgr });
    await api(`/api/requests/${id}/approve`, { method: 'POST', token: hrMgr, body: {} });
    await api(`/api/requests/${id}/assign`, { method: 'POST', token: recMgr, body: { ownerId: meta.json.recruiters[0].id } });
    return id;
  };
  const mkCand = async (label) => (await api('/api/candidates', {
    method: 'POST', token: recruiter,
    body: { fullName: label, email: `${label.replace(/\W+/g, '.').toLowerCase()}@example.com` },
  })).json.candidate.id;

  const link = async (candId, reqId) => (await api('/api/applications', {
    method: 'POST', token: recruiter, body: { candidateId: candId, requestId: reqId },
  })).json.application.id;

  const move = (appId, status, reason = 'test') => api(`/api/applications/${appId}/move`, {
    method: 'POST', token: recruiter, body: { status, reason },
  });
  const toOfferSent = async (appId) => {
    for (const st of ['matched', 'interviewing', 'issuing_offer', 'offer_sent']) await move(appId, st);
  };
  /** Full happy path: new candidate on a fresh requisition, joined. */
  const joinFresh = async (label, headcount = 1) => {
    const reqId = await mkReq(headcount);
    const candId = await mkCand(label);
    const appId = await link(candId, reqId);
    await toOfferSent(appId);
    const r = await move(appId, 'joined');
    return { reqId, candId, appId, r };
  };

  /* ============================ 0. the invariant ========================== */
  console.log('\n— 0. the database invariant —');
  c('the partial unique index exists after bootstrap', indexPresent());
  c('bootstrap reports enforcement is live', joinedUniqueness().enforced === true,
    JSON.stringify(joinedUniqueness()));
  c('re-running ensureSchema is idempotent', (() => { ensureSchema(); return indexPresent() && joinedUniqueness().enforced; })());

  /* ======================= 1. eligible histories can join ================= */
  console.log('\n— 1. a candidate with no joined application can join —');
  {
    const { reqId, appId, r } = await joinFresh('Clean Path');
    c('join succeeds', r.status === 200, `got ${r.status} ${JSON.stringify(r.json)}`);
    c('application is joined', appRow(appId).status === 'joined');
    c('exactly one seat is filled by it', filledBy(appId) === 1);
    c('requisition counted the fill', reqRow(reqId).headcount_filled === 1, JSON.stringify(reqRow(reqId)));
    c('requisition became filled at headcount 1', reqRow(reqId).status === 'filled', reqRow(reqId).status);
    c('one stage-history row to joined', historyTo(appId, 'joined') === 1);
    c('one seat_filled activity', seatActivity(reqId) === 1);
    c('the join was audited', joinAudit(appId) >= 1);
  }

  console.log('\n— 1b. non-joined histories do NOT block a later join —');
  for (const [label, path] of [
    ['rejected', ['rejected']],
    ['withdrawn', ['withdrawn']],
    ['sourced', []],
    ['matched', ['matched']],
    ['shortlisted', ['shortlisted']],
  ]) {
    const candId = await mkCand(`History ${label}`);
    const oldReq = await mkReq(2);
    const oldApp = await link(candId, oldReq);
    for (const st of path) await move(oldApp, st, 'history');
    // Phase 2 Talent Pool one-active-link rule: a prior link only stays "history"
    // once its request is terminal. Close the old requisition so the next link is
    // allowed — the application row itself is left exactly as the path left it.
    run("UPDATE recruitment_request SET status='closed' WHERE id=?", [oldReq]);
    const newReq = await mkReq(1);
    const newApp = await link(candId, newReq);
    await toOfferSent(newApp);
    const r = await move(newApp, 'joined');
    c(`${label} history still allows joining`, r.status === 200, `got ${r.status} ${r.json?.error || ''}`);
    c(`${label}: the new application is joined`, appRow(newApp).status === 'joined');
    c(`${label}: the old application was untouched`,
      appRow(oldApp).status !== 'joined' && filledBy(oldApp) === 0, appRow(oldApp).status);
  }

  console.log('\n— 1c. different candidates join different requisitions —');
  {
    const a = await joinFresh('Independent A');
    const b = await joinFresh('Independent B');
    c('both joins succeeded', a.r.status === 200 && b.r.status === 200);
    c('each filled its own seat', filledBy(a.appId) === 1 && filledBy(b.appId) === 1);
    c('two distinct candidates', a.candId !== b.candId);
  }

  console.log('\n— 1d. two candidates join the SAME requisition —');
  {
    const reqId = await mkReq(2);
    const ids = [];
    for (const label of ['Same Req One', 'Same Req Two']) {
      const appId = await link(await mkCand(label), reqId);
      await toOfferSent(appId);
      const r = await move(appId, 'joined');
      c(`${label} joined`, r.status === 200, `got ${r.status} ${r.json?.error || ''}`);
      ids.push(appId);
    }
    c('two distinct seats are filled',
      new Set(seatsOf(reqId).filter((s) => s.status === 'filled').map((s) => s.link)).size === 2);
    c('headcount_filled is 2', reqRow(reqId).headcount_filled === 2, JSON.stringify(reqRow(reqId)));
    c('requisition is filled', reqRow(reqId).status === 'filled');
    c('no seat carries two commitments', seatsOf(reqId).filter((s) => s.status === 'filled').length === 2);
  }

  /* ========================= 2. the global block ========================== */
  console.log('\n— 2. a candidate already joined elsewhere is refused —');
  let blocked = null;
  {
    const first = await joinFresh('Global Block');
    const otherReq = await mkReq(2);
    const secondApp = await link(first.candId, otherReq);
    await toOfferSent(secondApp);
    const before = { req: reqRow(otherReq), seats: seatsOf(otherReq), posts: postsOf(otherReq) };
    const r = await move(secondApp, 'joined');
    blocked = { first, otherReq, secondApp };
    c('the second join is refused with 409', r.status === 409, `got ${r.status}`);
    c('the conflict carries the stable code', r.json?.code === JOIN_CONFLICT.ALREADY_JOINED_ELSEWHERE, r.json?.code);
    c('the message names the rule, not the database',
      /already has a joined application/i.test(r.json?.error || '')
      && !/unique|index|constraint|sql/i.test(r.json?.error || ''), r.json?.error);
    c('it points at the blocking application', r.json?.blockingApplicationId === first.appId,
      String(r.json?.blockingApplicationId));
    c('the refused application did not move', appRow(secondApp).status === 'offer_sent', appRow(secondApp).status);
    c('no seat was taken on the second requisition',
      JSON.stringify(seatsOf(otherReq)) === JSON.stringify(before.seats));
    c('the second requisition did not drift', JSON.stringify(reqRow(otherReq)) === JSON.stringify(before.req));
    c('no stage-history residue', historyTo(secondApp, 'joined') === 0);
    c('no seat_filled activity on the second requisition', seatActivity(otherReq) === 0);
    c('no thread post from the refusal', postsOf(otherReq) === before.posts);
    c('the first join is intact', filledBy(first.appId) === 1 && appRow(first.appId).status === 'joined');
  }

  console.log('\n— 2b. a CLOSED requisition does not release the candidate —');
  {
    await api(`/api/requests/${blocked.first.reqId}/close`, { method: 'POST', token: hrMgr, body: { reason: 'project ended' } });
    c('the blocking requisition is closed', reqRow(blocked.first.reqId).status === 'closed', reqRow(blocked.first.reqId).status);
    const r = await move(blocked.secondApp, 'joined');
    c('the candidate is still blocked', r.status === 409, `got ${r.status}`);
    c('same stable code', r.json?.code === JOIN_CONFLICT.ALREADY_JOINED_ELSEWHERE);
    c('the joined application survived the close', appRow(blocked.first.appId).status === 'joined');
  }

  console.log('\n— 2c. a cancelled seat does not release the candidate —');
  {
    run("UPDATE requisition_seat SET status='cancelled' WHERE filled_by_application_id=?", [blocked.first.appId]);
    c('the seat is cancelled', get('SELECT status FROM requisition_seat WHERE filled_by_application_id=?', [blocked.first.appId]).status === 'cancelled');
    const r = await move(blocked.secondApp, 'joined');
    c('the candidate is still blocked', r.status === 409, `got ${r.status}`);
    c('same stable code', r.json?.code === JOIN_CONFLICT.ALREADY_JOINED_ELSEWHERE);
    run("UPDATE requisition_seat SET status='filled' WHERE filled_by_application_id=?", [blocked.first.appId]);
  }

  console.log('\n— 2d. no rehire, no override —');
  {
    const attempts = [
      ['overrideExisting', { status: 'joined', reason: 'x', overrideExisting: true }],
      ['overrideTerminal', { status: 'joined', reason: 'x', overrideTerminal: true, overrideReason: 'rehire' }],
      ['rehire flag', { status: 'joined', reason: 'x', rehire: true }],
      ['force flag', { status: 'joined', reason: 'x', force: true, allowDuplicateJoin: true }],
    ];
    for (const [label, body] of attempts) {
      const r = await api(`/api/applications/${blocked.secondApp}/move`, { method: 'POST', token: recruiter, body });
      c(`${label} does not unlock a second join`, r.status === 409, `got ${r.status}`);
    }
    // `allow_duplicate_application` governs linking the same candidate twice to
    // ONE requisition. It must not leak into the global joining rule.
    run("UPDATE system_setting SET value='true' WHERE key='allow_duplicate_application'");
    const r = await api(`/api/applications/${blocked.secondApp}/move`, {
      method: 'POST', token: recruiter, body: { status: 'joined', reason: 'x', overrideExisting: true },
    });
    c('allow_duplicate_application does not unlock joining', r.status === 409, `got ${r.status}`);
    run("UPDATE system_setting SET value='false' WHERE key='allow_duplicate_application'");
  }

  console.log('\n— 2e. repeating a join on an ALREADY joined application —');
  {
    const r = await move(blocked.first.appId, 'joined');
    c('follows the existing terminal contract (409)', r.status === 409, `got ${r.status}`);
    c('the message names the terminal state', /terminal/i.test(r.json?.error || ''), r.json?.error);
    c('nothing was written twice',
      filledBy(blocked.first.appId) === 1 && historyTo(blocked.first.appId, 'joined') === 1);
  }

  /* ====================== 3. the offer path is not special ================ */
  console.log('\n— 3. the offer result path enforces the same rule —');
  {
    const first = await joinFresh('Offer Path Blocked');
    const reqId = await mkReq(2);
    const appId = await link(first.candId, reqId);
    await toOfferSent(appId);
    const offer = (await api('/api/offers', {
      method: 'POST', token: hrMgr, body: { applicationId: appId, positionTitle: 'Engineer', joiningDate: '2030-01-01' },
    })).json.offer;
    await api(`/api/offers/${offer.id}/submit`, { method: 'POST', token: hrMgr });
    await api(`/api/offers/${offer.id}/approve`, { method: 'POST', token: hrMgr, body: {} });
    await api(`/api/offers/${offer.id}/send`, { method: 'POST', token: hrMgr });
    await api(`/api/offers/${offer.id}/result`, { method: 'POST', token: hrMgr, body: { result: 'accepted' } });
    const before = { req: reqRow(reqId), seats: seatsOf(reqId) };
    const r = await api(`/api/offers/${offer.id}/result`, { method: 'POST', token: hrMgr, body: { result: 'joined' } });
    c('the offer join is refused with 409', r.status === 409, `got ${r.status}`);
    c('same stable code as the move path', r.json?.code === JOIN_CONFLICT.ALREADY_JOINED_ELSEWHERE, r.json?.code);
    c('the offer stayed accepted', get('SELECT status FROM offer WHERE id=?', [offer.id]).status === 'accepted');
    c('the application stayed at offer_sent', appRow(appId).status === 'offer_sent');
    c('no seat taken, no counter moved',
      JSON.stringify(seatsOf(reqId)) === JSON.stringify(before.seats)
      && JSON.stringify(reqRow(reqId)) === JSON.stringify(before.req));
  }

  console.log('\n— 3b. an eligible candidate CAN join through the offer path —');
  {
    const reqId = await mkReq(1);
    const appId = await link(await mkCand('Offer Path Clean'), reqId);
    await toOfferSent(appId);
    const offer = (await api('/api/offers', {
      method: 'POST', token: hrMgr, body: { applicationId: appId, positionTitle: 'Engineer', joiningDate: '2030-01-01' },
    })).json.offer;
    await api(`/api/offers/${offer.id}/submit`, { method: 'POST', token: hrMgr });
    await api(`/api/offers/${offer.id}/approve`, { method: 'POST', token: hrMgr, body: {} });
    await api(`/api/offers/${offer.id}/send`, { method: 'POST', token: hrMgr });
    await api(`/api/offers/${offer.id}/result`, { method: 'POST', token: hrMgr, body: { result: 'accepted' } });
    const r = await api(`/api/offers/${offer.id}/result`, { method: 'POST', token: hrMgr, body: { result: 'joined' } });
    c('the offer join succeeds', r.status === 200, `got ${r.status} ${r.json?.error || ''}`);
    c('application joined, seat filled, offer settled',
      appRow(appId).status === 'joined' && filledBy(appId) === 1
      && get('SELECT status FROM offer WHERE id=?', [offer.id]).status === 'joined');
    c('the requisition counted it', reqRow(reqId).headcount_filled === 1);
    c('one stage-history row and one seat_filled activity',
      historyTo(appId, 'joined') === 1 && seatActivity(reqId) === 1);
  }

  /* ========================= 4. the bulk path ============================= */
  console.log('\n— 4. the bulk route enforces the same rule per item —');
  {
    const reqId = await mkReq(3);
    const blockedCand = (await joinFresh('Bulk Blocked')).candId;
    const blockedApp = await link(blockedCand, reqId);
    const okApp = await link(await mkCand('Bulk Allowed'), reqId);
    for (const a of [blockedApp, okApp]) await toOfferSent(a);
    const r = await api('/api/applications/bulk', {
      method: 'POST', token: hrMgr,
      body: { ids: [blockedApp, okApp], action: 'move', status: 'joined', reason: 'bulk' },
    });
    c('the batch completes', r.status === 200, `got ${r.status}`);
    c('exactly one application was affected', r.json?.affected === 1, JSON.stringify(r.json));
    c('the blocked one is skipped with a stable reason',
      r.json?.skipped?.some((s) => s.id === blockedApp && s.reason === 'candidate_already_joined'),
      JSON.stringify(r.json?.skipped));
    c('the blocked application did not move', appRow(blockedApp).status === 'offer_sent');
    c('the eligible one joined', appRow(okApp).status === 'joined' && filledBy(okApp) === 1);
    c('only one seat was consumed', reqRow(reqId).headcount_filled === 1, JSON.stringify(reqRow(reqId)));
  }

  /* ================== 5. the database rejects direct writes ============== */
  console.log('\n— 5. the constraint rejects a direct duplicate write —');
  {
    const first = await joinFresh('Direct Write');
    const otherReq = await mkReq(1);
    const secondApp = await link(first.candId, otherReq);
    let threw = null;
    try { run("UPDATE application SET status='joined' WHERE id=?", [secondApp]); }
    catch (e) { threw = e; }
    c('a raw UPDATE to joined is rejected by the database', !!threw, threw ? '' : 'NO ERROR RAISED');
    c('the second application is still not joined', appRow(secondApp).status !== 'joined', appRow(secondApp).status);
    let threwInsert = null;
    try {
      run(`INSERT INTO application (application_no,candidate_id,request_id,status,created_by,created_at,updated_at)
           VALUES (?,?,?,'joined',1,'2030-01-01','2030-01-01')`, [`BL27-DUP-${first.candId}`, first.candId, otherReq]);
    } catch (e) { threwInsert = e; }
    c('a raw INSERT of a second joined row is rejected', !!threwInsert, threwInsert ? '' : 'NO ERROR RAISED');
    c('a second joined row for a DIFFERENT candidate is still allowed', (() => {
      const other = get("SELECT id FROM application WHERE status='joined' AND candidate_id<>?", [first.candId]);
      return !!other;
    })());
  }

  /* ================= 6. read-only duplicate reconciliation =============== */
  console.log('\n— 6. duplicate reconciliation on malformed historical fixtures —');
  {
    c('a clean database reports no duplicates', duplicateJoinedCandidates().length === 0);

    // Manufacture history that the index would never have allowed: drop it,
    // corrupt two candidates, and check the report — then restore.
    const victim = await joinFresh('Recon Victim');
    const extraReq = await mkReq(1);
    const extraApp = await link(victim.candId, extraReq);
    const victim2 = await joinFresh('Recon Victim Two');
    const extraReq2 = await mkReq(1);
    const extraApp2 = await link(victim2.candId, extraReq2);

    run(`DROP INDEX IF EXISTS ${JOINED_UNIQUE_INDEX}`);
    run("UPDATE application SET status='joined' WHERE id=?", [extraApp]);
    run("UPDATE application SET status='joined' WHERE id=?", [extraApp2]);

    const dupes = duplicateJoinedCandidates();
    c('both corrupted candidates are reported', dupes.length === 2, `n=${dupes.length}`);
    const mine = dupes.find((d) => d.candidateId === victim.candId);
    c('the report names the candidate', !!mine);
    c('it lists both joined application IDs',
      mine.applicationIds.length === 2 && mine.applicationIds.includes(victim.appId) && mine.applicationIds.includes(extraApp),
      JSON.stringify(mine?.applicationIds));
    c('it lists the request IDs',
      mine.requestIds.length === 2 && mine.requestIds.includes(victim.reqId) && mine.requestIds.includes(extraReq),
      JSON.stringify(mine?.requestIds));
    c('it carries the count', mine.count === 2);
    c('it exposes IDs and counts ONLY — no PII',
      Object.keys(mine).sort().join(',') === 'applicationIds,candidateId,count,requestIds',
      Object.keys(mine).join(','));

    // Enforcement must STOP for this environment and report, not repair.
    const state = (ensureSchema(), joinedUniqueness());
    c('bootstrap refuses to enforce', state.enforced === false, JSON.stringify(state.reason));
    c('and names historical duplicates as the reason', state.reason === 'historical_duplicates', state.reason);
    c('and reports the exact conflict', state.duplicates.length === 2);
    c('the index was NOT created', !indexPresent());
    c('nothing was repaired — both rows are still joined',
      appRow(victim.appId).status === 'joined' && appRow(extraApp).status === 'joined');
    c('no winner was chosen', duplicateJoinedCandidates().length === 2);

    // Operator resolves the conflict deliberately; enforcement resumes.
    run("UPDATE application SET status='offer_sent' WHERE id IN (?,?)", [extraApp, extraApp2]);
    ensureSchema();
    c('once resolved, the index is installed again', indexPresent() && joinedUniqueness().enforced === true,
      JSON.stringify(joinedUniqueness()));
  }

  /* ===================== 7. failure injection per boundary ================ */
  console.log('\n— 7. failure after each of the eight join write boundaries —');
  {
    const snap = (reqId, appId) => ({
      app: appRow(appId).status,
      req: reqRow(reqId),
      seats: seatsOf(reqId),
      history: historyTo(appId, 'joined'),
      candAct: candActivity(appId),
      seatAct: seatActivity(reqId),
      audit: joinAudit(appId),
      posts: postsOf(reqId),
    });
    for (let bnd = 1; bnd <= 8; bnd += 1) {
      const reqId = await mkReq(2);
      const appId = await link(await mkCand(`Inject ${bnd}`), reqId);
      await toOfferSent(appId);
      const before = snap(reqId, appId);

      process.env.FAIL_INJECT_JOIN = String(bnd);
      const res = await move(appId, 'joined');
      delete process.env.FAIL_INJECT_JOIN;
      const after = snap(reqId, appId);

      c(`boundary ${bnd}: the request failed`, res.status >= 400, `status=${res.status}`);
      c(`boundary ${bnd}: no partial joined status`, after.app === 'offer_sent', after.app);
      c(`boundary ${bnd}: no partial seat linkage`, filledBy(appId) === 0
        && JSON.stringify(after.seats) === JSON.stringify(before.seats));
      c(`boundary ${bnd}: no request-state drift`, JSON.stringify(after.req) === JSON.stringify(before.req),
        JSON.stringify(after.req));
      c(`boundary ${bnd}: no history/activity/audit/post residue`,
        after.history === before.history && after.candAct === before.candAct
        && after.seatAct === before.seatAct && after.audit === before.audit && after.posts === before.posts,
        JSON.stringify(after));

      const retry = await move(appId, 'joined');
      const done = snap(reqId, appId);
      c(`boundary ${bnd}: retry succeeds exactly once`,
        retry.status === 200 && done.app === 'joined' && filledBy(appId) === 1
        && done.history === before.history + 1 && done.seatAct === before.seatAct + 1
        && done.audit === before.audit + 1 && done.posts === before.posts + 1,
        `status=${retry.status} ${JSON.stringify(done)}`);
      c(`boundary ${bnd}: no duplicate events`,
        historyTo(appId, 'joined') === 1 && filledBy(appId) === 1
        && reqRow(reqId).headcount_filled === 1);
    }
  }

  console.log('\n— 7b. failure injection on the OFFER path —');
  {
    for (const bnd of [1, 2, 7, 8]) {
      const reqId = await mkReq(1);
      const appId = await link(await mkCand(`Offer Inject ${bnd}`), reqId);
      await toOfferSent(appId);
      const offer = (await api('/api/offers', {
        method: 'POST', token: hrMgr, body: { applicationId: appId, positionTitle: 'Engineer', joiningDate: '2030-01-01' },
      })).json.offer;
      await api(`/api/offers/${offer.id}/submit`, { method: 'POST', token: hrMgr });
      await api(`/api/offers/${offer.id}/approve`, { method: 'POST', token: hrMgr, body: {} });
      await api(`/api/offers/${offer.id}/send`, { method: 'POST', token: hrMgr });
      await api(`/api/offers/${offer.id}/result`, { method: 'POST', token: hrMgr, body: { result: 'accepted' } });
      const before = { req: reqRow(reqId), seats: seatsOf(reqId), offer: get('SELECT status, joined_at FROM offer WHERE id=?', [offer.id]) };

      process.env.FAIL_INJECT_JOIN = String(bnd);
      const res = await api(`/api/offers/${offer.id}/result`, { method: 'POST', token: hrMgr, body: { result: 'joined' } });
      delete process.env.FAIL_INJECT_JOIN;

      c(`offer boundary ${bnd}: failed and rolled back completely`,
        res.status >= 400 && appRow(appId).status === 'offer_sent' && filledBy(appId) === 0
        && JSON.stringify(reqRow(reqId)) === JSON.stringify(before.req)
        && JSON.stringify(seatsOf(reqId)) === JSON.stringify(before.seats)
        && JSON.stringify(get('SELECT status, joined_at FROM offer WHERE id=?', [offer.id])) === JSON.stringify(before.offer),
        `status=${res.status} app=${appRow(appId).status} offer=${get('SELECT status FROM offer WHERE id=?', [offer.id]).status}`);

      const retry = await api(`/api/offers/${offer.id}/result`, { method: 'POST', token: hrMgr, body: { result: 'joined' } });
      c(`offer boundary ${bnd}: retry joins exactly once`,
        retry.status === 200 && appRow(appId).status === 'joined' && filledBy(appId) === 1
        && get('SELECT status FROM offer WHERE id=?', [offer.id]).status === 'joined'
        && historyTo(appId, 'joined') === 1,
        `status=${retry.status}`);
    }
  }

  /* ========================= 8. global consistency ======================= */
  console.log('\n— 8. whole-database consistency —');
  {
    c('no candidate holds two joined applications', duplicateJoinedCandidates().length === 0,
      JSON.stringify(duplicateJoinedCandidates()));
    c('every joined application holds exactly one seat',
      all("SELECT id FROM application WHERE status='joined'").every((a) => filledBy(a.id) === 1));
    c('no seat is linked to a non-joined application',
      all('SELECT filled_by_application_id id FROM requisition_seat WHERE filled_by_application_id IS NOT NULL')
        .every((s) => appRow(s.id)?.status === 'joined'));
    c('headcount_filled matches filled seats everywhere',
      all('SELECT id, headcount_filled hf FROM recruitment_request').every((r) =>
        Number(r.hf) === get("SELECT COUNT(*) c FROM requisition_seat WHERE request_id=? AND status='filled'", [r.id]).c));
    c('enforcement is still live at the end', indexPresent() && joinedUniqueness().enforced === true);
  }

  console.log(`\n${fail === 0 ? '✓' : '✗'} BL-27: ${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
})();
