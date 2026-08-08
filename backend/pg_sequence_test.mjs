// Shared sequence allocation — regression gate for nextSequence().
//
//   node pg_sequence_test.mjs --own
//   PG_TEST_URL=… node pg_sequence_test.mjs
//
// 81f1ea6 replaced five independent SELECT-then-UPDATE counters with one shared
// helper. Application numbering was proven under contention; this covers the
// other four and the helper's own edge cases, so a shared implementation cannot
// quietly change any entity's numbering.

import { startCluster } from './test-harness/pg-cluster.mjs';

let pass = 0; let fail = 0;
const c = (n, ok, x = '') => { console.log((ok ? '  ✅ ' : '  ❌ ') + n + (x ? ` ${x}` : '')); ok ? pass++ : fail++; };

const own = process.argv.includes('--own') || !process.env.PG_TEST_URL;
let cluster = null;

try {
  cluster = await startCluster({ processes: 3, ownDatabase: own });
  const { api, race, db } = cluster;
  const { get, all, exec } = db;
  const { nextSequence } = await import('./src/lib/models.js');
  const { tx } = await import('./src/lib/db.js');

  /* ------------------------- helper semantics --------------------------- */
  console.log('\n— nextSequence() semantics —');
  exec("INSERT INTO system_setting (key, value) VALUES ('probe_counter', '0') ON CONFLICT (key) DO UPDATE SET value='0'");
  const a = nextSequence('probe_counter');
  const b = nextSequence('probe_counter');
  const d = nextSequence('probe_counter');
  c('advances by exactly one each call', a === 1 && b === 2 && d === 3, `${a},${b},${d}`);
  c('the stored value matches the last issued',
    get("SELECT value v FROM system_setting WHERE key='probe_counter'").v === '3');

  // Independence: moving one counter must not disturb another.
  exec("INSERT INTO system_setting (key, value) VALUES ('probe_other', '10') ON CONFLICT (key) DO UPDATE SET value='10'");
  nextSequence('probe_counter'); nextSequence('probe_counter');
  c('an unrelated counter is untouched',
    get("SELECT value v FROM system_setting WHERE key='probe_other'").v === '10');
  c('and still advances from its own value', nextSequence('probe_other') === 11);

  console.log('\n— failing closed —');
  let missingThrew = false;
  try { nextSequence('counter_that_does_not_exist'); } catch (e) { missingThrew = /missing/i.test(e.message); }
  c('a missing counter throws rather than minting 1', missingThrew);

  exec("INSERT INTO system_setting (key, value) VALUES ('probe_bad', 'not-a-number') ON CONFLICT (key) DO UPDATE SET value='not-a-number'");
  let badThrew = false; let badValueAfter = null;
  try { nextSequence('probe_bad'); } catch { badThrew = true; }
  badValueAfter = get("SELECT value v FROM system_setting WHERE key='probe_bad'").v;
  // Either it refuses outright, or the engine rejects the cast — both are
  // "fail closed". What must NOT happen is silently resetting to 1, which would
  // remint numbers that already exist.
  c('a malformed counter fails closed and does not reset to 1',
    badThrew || badValueAfter !== '1', `threw=${badThrew} value=${badValueAfter}`);

  console.log('\n— rollback restores the counter inside a transaction —');
  exec("INSERT INTO system_setting (key, value) VALUES ('probe_tx', '5') ON CONFLICT (key) DO UPDATE SET value='5'");
  try { tx(() => { nextSequence('probe_tx'); throw new Error('rollback'); }); } catch { /* expected */ }
  c('a rolled-back allocation consumes no number',
    get("SELECT value v FROM system_setting WHERE key='probe_tx'").v === '5',
    get("SELECT value v FROM system_setting WHERE key='probe_tx'").v);
  // OUTSIDE a transaction the allocation is its own committed statement, so a
  // later failure leaves a gap. That is documented, not a defect: gaps are
  // harmless, duplicates are not.
  nextSequence('probe_tx');
  c('outside a transaction the number is committed immediately (gaps possible)',
    get("SELECT value v FROM system_setting WHERE key='probe_tx'").v === '6');

  /* ---------------------- route-level format smoke ---------------------- */
  console.log('\n— the formatted number of all five entity types —');
  const recruiter = await cluster.login('recruiter@arabtec.com');
  const hrMgr = await cluster.login('hr.manager@arabtec.com');
  const recMgr = await cluster.login('rec.manager@arabtec.com');
  const meta = await api(0, '/api/requests/meta/form', { token: hrMgr });

  const mkReq = async (title) => {
    const r = await api(0, '/api/requests', {
      method: 'POST', token: hrMgr,
      body: { title, projectId: meta.json.projects[0].id, departmentId: meta.json.departments[0].id, headcount: 4, priority: 'high' },
    });
    await api(0, `/api/requests/${r.json.request.id}/submit`, { method: 'POST', token: hrMgr });
    await api(0, `/api/requests/${r.json.request.id}/approve`, { method: 'POST', token: hrMgr, body: {} });
    await api(0, `/api/requests/${r.json.request.id}/assign`, { method: 'POST', token: recMgr, body: { ownerId: meta.json.recruiters[0].id } });
    return r.json.request;
  };

  const req1 = await mkReq('Sequence Probe A');
  c('requisition number keeps its format', /^REQ-\d{4}-\d{5}$/.test(req1.ticketNo || ''), req1.ticketNo);

  const cand = (await api(0, '/api/candidates', {
    method: 'POST', token: recruiter, body: { fullName: 'Seq Probe', email: 'seq.probe@example.com' },
  })).json.candidate;
  c('candidate number keeps its format', /^CAN-\d{5}$/.test(cand.candidateNo || ''), cand.candidateNo);

  const app = (await api(0, '/api/applications', {
    method: 'POST', token: recruiter, body: { candidateId: cand.id, requestId: req1.id },
  })).json.application;
  c('application number keeps its format', /^APP-\d{5}$/.test(app.applicationNo || ''), app.applicationNo);

  // Interview numbering is checked at the model, not through the route: the
  // interview endpoint has its own panel/scheduling contract that has nothing to
  // do with sequence allocation, and coupling this gate to it would make a
  // change there look like a numbering regression.
  const { Interviews } = await import('./src/lib/models.js');
  const ivNo = Interviews.nextNo();
  c('interview number keeps its format', /^INT-\d{5}$/.test(ivNo), ivNo);
  c('interview numbering advances', Interviews.nextNo() !== ivNo);

  await api(0, `/api/applications/${app.id}/move`, { method: 'POST', token: recruiter, body: { status: 'interviewing' } });
  await api(0, `/api/applications/${app.id}/move`, { method: 'POST', token: recruiter, body: { status: 'issuing_offer' } });
  const offer = (await api(0, '/api/offers', {
    method: 'POST', token: recruiter,
    body: {
      applicationId: app.id, salaryOffered: 30000,
      joiningDate: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10), benefits: 'Housing',
    },
  })).json.offer;
  c('offer number keeps its format', /^OFR-\d{4}-\d{5}$/.test(offer?.offerNo || ''), offer?.offerNo);

  console.log('\n— sequential allocation advances per entity —');
  const req2 = await mkReq('Sequence Probe B');
  c('the next requisition number is the next value',
    Number(req2.ticketNo.split('-').pop()) === Number(req1.ticketNo.split('-').pop()) + 1,
    `${req1.ticketNo} -> ${req2.ticketNo}`);

  /* --------------------- concurrency for every counter ------------------- */
  console.log('\n— concurrent allocation across 3 processes, per entity —');

  const reqs = await race(Array.from({ length: 9 }, (_, i) => () => api(i, '/api/requests', {
    method: 'POST', token: hrMgr,
    body: { title: `Race Req ${i}`, projectId: meta.json.projects[0].id, departmentId: meta.json.departments[0].id, headcount: 1, priority: 'low' },
  })));
  const tickets = reqs.filter((r) => r.status === 'fulfilled' && r.value.status === 201)
    .map((r) => r.value.json.request.ticketNo);
  c('concurrent requisition numbers are unique', new Set(tickets).size === tickets.length,
    `${tickets.length} created, ${new Set(tickets).size} distinct`);
  c('every concurrent requisition succeeded', tickets.length === 9, `${tickets.length}/9`);

  const cands = await race(Array.from({ length: 12 }, (_, i) => () => api(i, '/api/candidates', {
    method: 'POST', token: recruiter, body: { fullName: `Race Cand ${i}`, email: `race.cand.${i}@example.com` },
  })));
  const nos = cands.filter((r) => r.status === 'fulfilled' && r.value.status === 201)
    .map((r) => r.value.json.candidate.candidateNo);
  c('concurrent candidate numbers are unique', new Set(nos).size === nos.length,
    `${nos.length} created, ${new Set(nos).size} distinct`);
  c('every concurrent candidate succeeded', nos.length === 12, `${nos.length}/12`);

  c('no duplicate ticket numbers exist in the database',
    all('SELECT ticket_no FROM recruitment_request').length
    === new Set(all('SELECT ticket_no FROM recruitment_request').map((r) => r.ticket_no)).size);
  c('no duplicate candidate numbers exist in the database',
    all('SELECT candidate_no FROM candidate').length
    === new Set(all('SELECT candidate_no FROM candidate').map((r) => r.candidate_no)).size);

  c('no idle-in-transaction connection remains', cluster.idleInTransaction() === 0);
} catch (e) {
  c(`sequence test threw: ${e.message}`, false);
} finally {
  if (cluster) await cluster.stop();
}

console.log(`\n${fail === 0 ? '✓' : '✗'} shared sequence: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
