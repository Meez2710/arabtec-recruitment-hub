// Synthetic database only: verifies strict role denial even with every permission.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ats-admin-delete-'));
process.env.DATABASE_URL = `file:${dir}/test.db`;
process.env.PORT = '4296';
process.env.SEED_ADMIN_PASSWORD = 'TestSeed#123456';
await import('./prisma/seed.js');
const { all, get, run } = await import('./src/lib/db.js');
const { Sessions } = await import('./src/lib/models.js');
const { signToken } = await import('./src/lib/auth.js');
await import('./src/server.js');
const base = 'http://127.0.0.1:4296';
for (let i = 0; i < 100; i++) {
  try { if ((await fetch(base + '/api/ready')).ok) break; } catch {}
  await new Promise(r => setTimeout(r, 50));
}
let passed = 0, failed = 0;
function check(label, ok) { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); ok ? passed++ : failed++; }
async function call(token, url, method = 'DELETE', body) {
  const response = await fetch(base + '/api' + url, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, body: await response.json() };
}
const paths = ['/requests/999999', '/candidates/999999', '/thread/post/999999', '/org/designations/999999', '/org/chart/nodes/999999', '/admin-ui/custom-fields/candidate/missing', '/admin-ui/logo'];
const tokens = new Map();
for (const role of all('SELECT * FROM role')) {
  // Overgrant all permissions to prove the role boundary cannot be configured away.
  for (const perm of all('SELECT id FROM permission')) run('INSERT OR IGNORE INTO role_permission(role_id, permission_id) VALUES (?,?)', [role.id, perm.id]);
  run('INSERT INTO users(full_name,email,password_hash,status) VALUES (?,?,?,?)', ['Deletion QA', `deletion-${role.code}@example.invalid`, 'not-a-login-password', 'active']);
  const user = get('SELECT id FROM users WHERE email=?', [`deletion-${role.code}@example.invalid`]);
  run('INSERT INTO user_role(user_id, role_id) VALUES (?,?)', [user.id, role.id]);
  const token = signToken({ sub: user.id });
  Sessions.create({ id: randomUUID(), userId: user.id, token, expiresAt: new Date(Date.now() + 3600000).toISOString() });
  tokens.set(role.code, token);
  if (role.code === 'system_admin') continue;
  for (const url of paths) check(`${role.code} denied DELETE ${url}`, (await call(token, url)).status === 403);
  check(`${role.code} denied erasure`, (await call(token, '/candidates/999999/erase', 'POST', {confirm:'ERASE'})).status === 403);
  for (const resource of ['requests', 'candidates']) check(`${role.code} denied ${resource} impact`, (await call(token, `/${resource}/999999/delete-impact`, 'GET')).status === 403);
  check(`${role.code} denied replacing quotes`, (await call(token, '/settings/system', 'PUT', {settings:{knowledge_lines:''}})).status === 403);
  const buttons = await call(token, '/settings/buttons/resolved', 'GET');
  check(`${role.code} request deletion hidden`, buttons.body.buttons?.find(b => b.buttonKey === 'delete_request')?.visible === false);
  check(`${role.code} ordinary read preserved`, (await call(token, '/auth/me', 'GET')).status === 200);
}
const admin = tokens.get('system_admin');
for (const url of paths.filter(p => p !== '/admin-ui/logo')) { const result = await call(admin, url); check(`admin reaches handler ${url}`, [403,404].includes(result.status) && result.body.code !== 'SYSTEM_ADMIN_REQUIRED'); }
check('admin may remove test logo', (await call(admin, '/admin-ui/logo')).status === 200);
check('admin request deletion visible', (await call(admin, '/settings/buttons/resolved', 'GET')).body.buttons?.find(b => b.buttonKey === 'delete_request')?.visible === true);
// Prove successful mutation as well as denial, with synthetic data only.
run('INSERT INTO candidate(full_name, candidate_no) VALUES (?,?)', ['Disposable QA', 'DELETE-QA']);
const candidate = get('SELECT id FROM candidate WHERE candidate_no=?', ['DELETE-QA']);
check('admin deletes synthetic candidate', (await call(admin, `/candidates/${candidate.id}`, 'DELETE', {reason:'Synthetic authorization test'})).status === 200);
check('synthetic candidate removed', !get('SELECT id FROM candidate WHERE id=?', [candidate.id]));
console.log(`RESULT ${passed} passed; ${failed} failed`);
fs.rmSync(dir, { recursive:true, force:true });
process.exit(failed ? 1 : 0);
