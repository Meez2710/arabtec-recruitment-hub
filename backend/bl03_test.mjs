// BL-03 — an application may only be CREATED at an entry stage.
//
// Run: node --experimental-sqlite bl03_test.mjs
//
// The defect this pins: creation validated against APP_STATUSES (every status an
// application may ever HOLD), which contains `joined`, `offer_sent` and
// `rejected`. One request could therefore create an application already at a
// terminal stage, skipping the interview record, the offer flow and seat
// accounting. Invalid values were also silently coerced to `sourced`, so a
// caller asking for an impossible stage never found out.
//
// Enforcement must be SERVER-SIDE: every assertion below goes through the HTTP
// API, not through the UI and not through the model layer.

process.env.DATABASE_URL = 'file:/tmp/arabtec_bl03.db';
process.env.PORT = '4131';
import fs from 'node:fs';
for (const f of ['/tmp/arabtec_bl03.db', '/tmp/arabtec_bl03.db-journal']) { try { fs.rmSync(f); } catch {} }
await import('./prisma/seed.js');
await import('./src/server.js');
await new Promise((r) => setTimeout(r, 700));

const B = 'http://localhost:4131';
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

(async () => {
  const recruiter = await login('recruiter@arabtec.com');
  const hrMgr = await login('hr.manager@arabtec.com');
  const recMgr = await login('rec.manager@arabtec.com');
  const admin = await login('admin@arabtec.com', 'Admin@12345');

  // An approved, sourcing requisition to link candidates to.
  const meta = await api('/api/requests/meta/form', { token: hrMgr });
  const cr = await api('/api/requests', {
    method: 'POST', token: hrMgr,
    body: {
      title: 'Site Engineer', projectId: meta.json.projects[0].id,
      departmentId: meta.json.departments[0].id, headcount: 5, priority: 'high',
    },
  });
  const reqId = cr.json.request.id;
  await api(`/api/requests/${reqId}/submit`, { method: 'POST', token: hrMgr });
  await api(`/api/requests/${reqId}/approve`, { method: 'POST', token: hrMgr, body: {} });
  const recId = meta.json.recruiters[0].id;
  await api(`/api/requests/${reqId}/assign`, { method: 'POST', token: recMgr, body: { ownerId: recId } });

  let seq = 0;
  const makeCandidate = async () => {
    seq += 1;
    const r = await api('/api/candidates', {
      method: 'POST', token: recruiter,
      body: { fullName: `Entry Probe ${seq}`, email: `entry.probe.${seq}@example.com` },
    });
    return r.json.candidate.id;
  };
  const create = async (initialStatus) => {
    const candidateId = await makeCandidate();
    const body = { candidateId, requestId: reqId };
    if (initialStatus !== undefined) body.initialStatus = initialStatus;
    const res = await api('/api/applications', { method: 'POST', token: recruiter, body });
    return { ...res, candidateId };
  };

  /* ------------------------- backward compatibility ----------------------- */

  console.log('\n— default and approved entry stages —');

  const dflt = await create(undefined);
  c('creation with no initialStatus succeeds (201)', dflt.status === 201, `got ${dflt.status}`);
  c('default stage is sourced', dflt.json?.application?.status === 'sourced', dflt.json?.application?.status);

  for (const stage of ['sourced', 'matched', 'unmatched', 'shortlisted']) {
    const r = await create(stage);
    c(`entry stage "${stage}" succeeds (201)`, r.status === 201, `got ${r.status}`);
    c(`  stored status is ${stage}`, r.json?.application?.status === stage, r.json?.application?.status);
  }

  /* ----------------------------- the defect ------------------------------- */

  console.log('\n— advanced and terminal stages are refused —');

  for (const stage of [
    'joined',          // consumes a seat; must come from offer_sent
    'offer_sent',      // implies an offer that does not exist
    'rejected',        // terminal; nothing to reject yet
    'offer_declined',  // terminal
    'issuing_offer',   // implies an offer
    'interviewing',    // implies an interview record
    'waiting_feedback',
    'on_hold',         // resumes to a prior stage; there is none
  ]) {
    const r = await create(stage);
    c(`"${stage}" refused (400)`, r.status === 400, `got ${r.status}`);
    c('  error names the allowed stages', Array.isArray(r.json?.allowed) && r.json.allowed.includes('sourced'));
  }

  console.log('\n— unknown values are refused, not silently coerced —');
  for (const bogus of ['withdrawn', 'hired', 'not_a_stage', 'JOINED']) {
    const r = await create(bogus);
    c(`"${bogus}" refused (400)`, r.status === 400, `got ${r.status}`);
  }

  /* --------------------- nothing is written on refusal -------------------- */

  console.log('\n— a refused creation writes nothing —');

  const before = {
    apps: (await api(`/api/requests/${reqId}`, { token: hrMgr })).json?.request?.applications?.length ?? 0,
    audit: (await api('/api/audit?pageSize=200', { token: admin })).json?.total ?? -1,
  };
  const probeCandidate = await makeCandidate();
  const refused = await api('/api/applications', {
    method: 'POST', token: recruiter,
    body: { candidateId: probeCandidate, requestId: reqId, initialStatus: 'joined' },
  });
  c('refusal returns 400', refused.status === 400, `got ${refused.status}`);

  const after = {
    apps: (await api(`/api/requests/${reqId}`, { token: hrMgr })).json?.request?.applications?.length ?? 0,
    audit: (await api('/api/audit?pageSize=200', { token: admin })).json?.total ?? -1,
  };
  c('no application row created', after.apps === before.apps, `${before.apps} -> ${after.apps}`);
  // Only assert on the audit trail if this run can actually read it. A hidden
  // vacuous pass here would be worse than no assertion at all.
  if (before.audit >= 0) {
    c('no new audit entry', after.audit === before.audit, `${before.audit} -> ${after.audit}`);
  } else {
    console.log('  ⊘ audit trail not readable by this token — assertion skipped, not passed');
  }

  const cand = await api(`/api/candidates/${probeCandidate}`, { token: recruiter });
  const acts = cand.json?.candidate?.activity ?? [];
  c('no application_created candidate activity',
    !acts.some((a) => a.type === 'application_created'));
  c('candidate has no applications', (cand.json?.candidate?.applications ?? []).length === 0);

  const reqAfter = (await api(`/api/requests/${reqId}`, { token: hrMgr })).json?.request;
  c('no seat was consumed', (reqAfter?.headcountFilled ?? 0) === 0, `filled=${reqAfter?.headcountFilled}`);

  /* -------------------- moving still works afterwards --------------------- */

  console.log('\n— legitimate progression is unaffected —');
  const moved = await create('sourced');
  const mv = await api(`/api/applications/${moved.json.application.id}/move`, {
    method: 'POST', token: recruiter, body: { status: 'matched' },
  });
  c('sourced -> matched still allowed', mv.status === 200, `got ${mv.status}`);
  const bad = await api(`/api/applications/${moved.json.application.id}/move`, {
    method: 'POST', token: recruiter, body: { status: 'joined' },
  });
  c('matched -> joined still refused by the state machine', bad.status >= 400, `got ${bad.status}`);

  console.log(`\n${fail === 0 ? '✓' : '✗'} BL-03: ${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
})();
