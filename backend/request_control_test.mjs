// Hiring-request control (owner review, 4 Oct 2026):
//   • recruiters see every request (request.view_team) and are not limited to
//     their own when working the pipeline;
//   • only the Recruitment Manager and the System Administrator control a
//     request: assign / re-assign / remove the recruiter, hold, resume, cancel,
//     close, reopen;
//   • the Recruitment Manager gets one row per recruiter (recruiter-status);
//   • the one-time migration reshapes an existing grant matrix once, and a
//     later decision in Roles & Permissions is never reverted.
import { suiteDatabaseUrl } from './test-support/suite-db.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'arabtec-reqctl-'));
process.env.DATABASE_URL = suiteDatabaseUrl('file:' + path.join(TMP, 'reqctl.db'));
process.env.UPLOAD_DIR = path.join(TMP, 'uploads');
process.env.PORT = process.env.REQCTL_TEST_PORT || '4399';
process.env.SEED_DEMO_DATA ||= 'true';
process.env.SMTP_TRANSPORT = 'json';
const { adminToken, ADMIN_BOOTSTRAP_PASSWORD } = await import('./test-support/admin-session.mjs');
process.env.SEED_ADMIN_PASSWORD ||= ADMIN_BOOTSTRAP_PASSWORD;
await import('./prisma/seed.js');
await import('./src/server.js');
const { waitForReady } = await import('./test-support/wait-ready.mjs');
const B = 'http://localhost:' + process.env.PORT;
await waitForReady(B);
const db = await import('./src/lib/db.js');
const { ensureSchema } = await import('./src/lib/schema.js');

let pass = 0, fail = 0;
const c = (n, ok, x = '') => { console.log((ok ? '  ✅ ' : '  ❌ ') + n + (ok ? '' : ' ' + x)); ok ? pass++ : fail++; };
async function api(p, { method = 'GET', token, body } = {}) {
  const r = await fetch(B + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch {}
  return { status: r.status, json: j, text };
}
const login = async (e) => (await api('/api/auth/login', { method: 'POST', body: { email: e, password: 'Arabtec@123' } })).json.token;

try {
  const admin = await adminToken(B);
  const hrMgr = await login('hr.manager@arabtec.com');
  const hrDir = await login('hr.director@arabtec.com');
  const recMgr = await login('rec.manager@arabtec.com');
  const recruiter = await login('recruiter@arabtec.com'); // Karim Adel
  const meta = (await api('/api/requests/meta/form', { token: hrMgr })).json;
  const karim = meta.recruiters.find((r) => r.name === 'Karim Adel');
  const other = meta.recruiters.find((r) => r.name !== 'Karim Adel' && r.name !== 'System Administrator') || meta.recruiters[0];
  async function approved(title) {
    const id = (await api('/api/requests', { method: 'POST', token: hrMgr, body: { title, justification: 'new_hire', projectId: meta.projects[0].id, departmentId: meta.departments[0].id, location: 'Cairo', headcount: 2, priority: 'high' } })).json.request.id;
    await api(`/api/requests/${id}/submit`, { method: 'POST', token: hrMgr });
    await api(`/api/requests/${id}/approve`, { method: 'POST', token: hrDir, body: {} });
    return id;
  }
  const rOther = await approved('REQCTL Other recruiter');
  const rMine = await approved('REQCTL Karim');

  console.log('\n— only the Recruitment Manager and the System Administrator control a request —');
  c('HR manager cannot assign (403)', (await api(`/api/requests/${rOther}/assign`, { method: 'POST', token: hrMgr, body: { ownerId: other.id } })).status === 403);
  c('HR director cannot assign (403)', (await api(`/api/requests/${rOther}/assign`, { method: 'POST', token: hrDir, body: { ownerId: other.id } })).status === 403);
  c('recruiter cannot assign (403)', (await api(`/api/requests/${rOther}/assign`, { method: 'POST', token: recruiter, body: { ownerId: karim.id } })).status === 403);
  c('Recruitment Manager assigns (200)', (await api(`/api/requests/${rOther}/assign`, { method: 'POST', token: recMgr, body: { ownerId: other.id } })).json?.request?.ownerId === other.id);
  c('Recruitment Manager re-assigns (200)', (await api(`/api/requests/${rMine}/assign`, { method: 'POST', token: recMgr, body: { ownerId: other.id } })).status === 200
    && (await api(`/api/requests/${rMine}/assign`, { method: 'POST', token: recMgr, body: { ownerId: karim.id } })).json?.request?.ownerId === karim.id);
  for (const [who, t] of [['HR manager', hrMgr], ['HR director', hrDir]]) {
    c(`${who} cannot hold, close or cancel (403)`, (await api(`/api/requests/${rOther}/hold`, { method: 'POST', token: t, body: { reason: 'x' } })).status === 403
      && (await api(`/api/requests/${rOther}/close`, { method: 'POST', token: t, body: { reason: 'x' } })).status === 403
      && (await api(`/api/requests/${rOther}/cancel`, { method: 'POST', token: t, body: { reason: 'x' } })).status === 403);
  }
  c('System Administrator can hold and resume', (await api(`/api/requests/${rOther}/hold`, { method: 'POST', token: admin, body: { reason: 'admin check' } })).status === 200
    && (await api(`/api/requests/${rOther}/resume`, { method: 'POST', token: admin })).status === 200);

  console.log('\n— remove the recruiter —');
  c('HR manager cannot remove the recruiter (403)', (await api(`/api/requests/${rOther}/unassign`, { method: 'POST', token: hrMgr })).status === 403);
  const un = await api(`/api/requests/${rOther}/unassign`, { method: 'POST', token: recMgr });
  c('Recruitment Manager removes the recruiter (200, no owner)', un.status === 200 && un.json?.request?.ownerId == null, un.text.slice(0, 160));
  c('removing again says nobody is assigned (409)', (await api(`/api/requests/${rOther}/unassign`, { method: 'POST', token: recMgr })).status === 409);
  const audit = (await api('/api/audit?pageSize=100', { token: admin })).json.logs.find((l) => l.action === 'request.recruiter_unassigned' && String(l.entityId) === String(rOther));
  c('removal is audited with the previous recruiter', audit && Number(audit.oldValue?.ownerId) === Number(other.id));
  await api(`/api/requests/${rOther}/assign`, { method: 'POST', token: recMgr, body: { ownerId: other.id } });

  console.log('\n— recruiters see every request and are not limited to their own —');
  const list = (await api('/api/requests?pageSize=100', { token: recruiter })).json.requests.map((r) => r.id);
  c('recruiter lists a request assigned to someone else', list.includes(rOther) && list.includes(rMine), JSON.stringify(list));
  c('recruiter opens it', (await api(`/api/requests/${rOther}`, { token: recruiter })).status === 200);
  const cand = (await api('/api/candidates', { method: 'POST', token: hrMgr, body: { fullName: 'REQCTL Candidate', phone: '+201000000901' } })).json.candidate.id;
  const link = await api('/api/applications', { method: 'POST', token: recruiter, body: { candidateId: cand, requestId: rOther, initialStatus: 'matched' } });
  c('…and can work on it (no "assigned only" rule)', link.status === 201, link.text.slice(0, 160));

  console.log('\n— recruiter status for the Recruitment Manager —');
  const rs = await api('/api/requests/recruiter-status', { token: recMgr });
  const rowOther = (rs.json?.recruiters || []).find((r) => r.id === other.id);
  const rowKarim = (rs.json?.recruiters || []).find((r) => r.id === karim.id);
  c('one row per recruiter with open work', rs.status === 200 && rowOther && rowKarim, rs.text.slice(0, 200));
  c('…open requests and pipeline counted', rowOther.openRequests >= 1 && rowOther.inPipeline >= 1 && rowKarim.openRequests >= 1);
  c('…and the requests without candidates', rowKarim.withoutCandidates >= 1);
  c('unassigned requests are counted', typeof rs.json.unassigned === 'number');
  c('a recruiter cannot read the status (403)', (await api('/api/requests/recruiter-status', { token: recruiter })).status === 403);

  console.log('\n— the one-time migration on an existing grant matrix —');
  const roleId = (code) => db.get('SELECT id FROM role WHERE code=?', [code]).id;
  const permId = (code) => db.get('SELECT id FROM permission WHERE code=?', [code]).id;
  const has = (role, perm) => !!db.get('SELECT 1 AS x FROM role_permission WHERE role_id=? AND permission_id=?', [roleId(role), permId(perm)]);
  c('a fresh install is already marked applied', !!db.get("SELECT id FROM system_setting WHERE key='policy_request_control_v1'"));
  // Simulate a database from before the decision: the old grants and no marker.
  db.run("DELETE FROM system_setting WHERE key='policy_request_control_v1'");
  for (const [role, perm] of [['hr_manager', 'request.hold'], ['hr_director', 'request.close'], ['hr_manager', 'request.assign_recruiter']]) {
    db.run('INSERT INTO role_permission (role_id,permission_id) VALUES (?,?) ON CONFLICT DO NOTHING RETURNING role_id', [roleId(role), permId(perm)]);
  }
  db.run('DELETE FROM role_permission WHERE role_id=? AND permission_id=?', [roleId('recruitment_manager'), permId('request.cancel')]);
  ensureSchema();
  c('old HR grants are removed', !has('hr_manager', 'request.hold') && !has('hr_director', 'request.close') && !has('hr_manager', 'request.assign_recruiter'));
  c('the Recruitment Manager gains cancel', has('recruitment_manager', 'request.cancel'));
  const marker = db.get("SELECT value FROM system_setting WHERE key='policy_request_control_v1'");
  c('the change is recorded with what was removed', marker && JSON.parse(marker.value).removed.length === 3, marker?.value);
  // An administrator later grants hold back to HR — the next start must keep it.
  db.run('INSERT INTO role_permission (role_id,permission_id) VALUES (?,?) ON CONFLICT DO NOTHING RETURNING role_id', [roleId('hr_manager'), permId('request.hold')]);
  ensureSchema();
  c('a later Roles & Permissions decision is not reverted', has('hr_manager', 'request.hold'));
} catch (e) { console.error(e); fail++; }
finally {
  console.log(`\n=== REQUEST CONTROL: ${pass} passed, ${fail} failed ===\n`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.exit(fail ? 1 : 0);
}
