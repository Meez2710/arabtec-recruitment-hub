// Fixture determinism probe — proves mkReq before anything relies on it.
//
//   node --experimental-sqlite fixture_probe_test.mjs

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'file:/tmp/arabtec_fixture.db';
process.env.PORT = '4136';
import fs from 'node:fs';
for (const f of ['/tmp/arabtec_fixture.db', '/tmp/arabtec_fixture.db-journal']) { try { fs.rmSync(f); } catch {} }
await import('./prisma/seed.js');
await import('./src/server.js');

const B = 'http://localhost:4136';
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
const { get } = await import('./src/lib/db.js');
const reload = (id) => get('SELECT id, status, owner_id FROM recruitment_request WHERE id=?', [id]);

const hrMgr = await login('hr.manager@arabtec.com');
const recMgr = await login('rec.manager@arabtec.com');
const meta = await api('/api/requests/meta/form', { token: hrMgr });

console.log(`\n  recruiters offered by meta: ${(meta.json.recruiters || []).length}`);

/** Fail loudly with route, code and safe message — never swallow setup errors. */
const step = (label, res, okStatus = 200) => {
  if (res.status !== okStatus) {
    throw new Error(`${label} expected ${okStatus}, got ${res.status}: ${String(res.json?.error || '').slice(0, 120)}`);
  }
  return res;
};

let seq = 0;
/** Drives create → submit → approve → assign, asserting PERSISTED status each step. */
const mkSourcingReq = async (headcount = 3) => {
  delete process.env.FAIL_INJECT;                       // no hook may leak in
  if (process.env.FAIL_INJECT) throw new Error('fault injection still armed');
  seq += 1;
  const created = step('POST /requests', await api('/api/requests', {
    method: 'POST', token: hrMgr,
    body: {                                             // fresh payload every call
      title: `Fixture ${seq}-${Date.now()}`,
      projectId: meta.json.projects[0].id,
      departmentId: meta.json.departments[0].id,
      headcount, priority: 'high',
    },
  }), 201);
  const id = created.json.request.id;

  step(`POST /${id}/submit`, await api(`/api/requests/${id}/submit`, { method: 'POST', token: hrMgr }));
  if (reload(id).status !== 'pending_approval') throw new Error(`after submit: ${reload(id).status}`);

  // THE FIXTURE BUG THIS PROBE FOUND: completing the approval chain
  // auto-advances straight to SOURCING. It does NOT rest at APPROVED, so
  // assign's `if (status === APPROVED)` never fires and any fixture asserting
  // APPROVED after approve is wrong. Recorded as the contract, not worked around.
  step(`POST /${id}/approve`, await api(`/api/requests/${id}/approve`, { method: 'POST', token: hrMgr, body: {} }));
  const afterApprove = reload(id).status;
  if (afterApprove !== 'sourcing') throw new Error(`after approve: ${afterApprove}`);

  const owner = meta.json.recruiters[0].id;
  step(`POST /${id}/assign`, await api(`/api/requests/${id}/assign`, {
    method: 'POST', token: recMgr, body: { ownerId: owner },
  }));
  const after = reload(id);
  if (after.status !== 'sourcing') throw new Error(`after assign: status=${after.status} owner=${after.owner_id}`);
  if (!after.owner_id) throw new Error('assign did not set an owner');
  return after;                                          // freshly reloaded, never the create response
};

console.log('\n— 12 consecutive fixtures —');
const ids = [];
for (let i = 0; i < 12; i += 1) {
  try { const r = await mkSourcingReq(3); ids.push(r.id); c(`fixture ${i + 1} reached sourcing`, true); }
  catch (e) { c(`fixture ${i + 1} reached sourcing`, false, e.message); }
}

console.log('\n— after a deliberately failed transaction —');
try {
  const r = await mkSourcingReq(3);
  process.env.FAIL_INJECT = 'headcount:1';
  await api(`/api/requests/${r.id}`, { method: 'PUT', token: hrMgr, body: { headcount: 9 } });
} finally { delete process.env.FAIL_INJECT; }
try { const r = await mkSourcingReq(3); c('fixture after a failed transaction reaches sourcing', reload(r.id).status === 'sourcing'); }
catch (e) { c('fixture after a failed transaction reaches sourcing', false, e.message); }

console.log('\n— after each boundary is armed and reset —');
for (let b = 1; b <= 5; b += 1) {
  try { process.env.FAIL_INJECT = `headcount:${b}`; } finally { delete process.env.FAIL_INJECT; }
  try { const r = await mkSourcingReq(2); c(`fixture after arming boundary ${b}`, reload(r.id).status === 'sourcing'); }
  catch (e) { c(`fixture after arming boundary ${b}`, false, e.message); }
}

console.log('\n— isolation —');
c('every fixture has a distinct id', new Set(ids).size === ids.length);
c('all earlier fixtures are still sourcing',
  ids.every((id) => reload(id).status === 'sourcing'),
  ids.map((id) => reload(id).status).filter((s) => s !== 'sourcing').join(',') || 'all sourcing');

console.log(`\n${fail === 0 ? '✓' : '✗'} fixture probe: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
