// Authorization probe: logs in as every seeded role and records HTTP status per endpoint.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'arabtec-probe-'));
process.env.DATABASE_URL = 'file:' + path.join(TMP, 'probe.db');
process.env.UPLOAD_DIR = path.join(TMP, 'uploads');
process.env.PORT = '4651';
process.env.SEED_DEMO_DATA = 'true';
process.env.SMTP_TRANSPORT = 'json';
process.env.SEED_ADMIN_PASSWORD ||= 'Probe#2026xyz';
await import('./prisma/seed.js');
await import('./src/server.js');
const { waitForReady } = await import('./test-support/wait-ready.mjs');
const db = await import('./src/lib/db.js');
const B = 'http://localhost:' + process.env.PORT;
await waitForReady(B);

async function call(method, p, token, body) {
  const r = await fetch(B + p, { method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}
const uid = (e) => db.get('SELECT id FROM users WHERE email=?', [e]).id;
db.run('UPDATE users SET must_change_password=0');

// Least-privileged first; recruiter and admin last.
const USERS = [
  ['viewer', 'viewer@arabtec.com'], ['interviewer', 'interviewer@arabtec.com'], ['project_manager', 'pm@arabtec.com'],
  ['hiring_manager', 'hiring.manager@arabtec.com'], ['hr_director', 'hr.director@arabtec.com'], ['hr_manager', 'hr.manager@arabtec.com'],
  ['recruitment_manager', 'rec.manager@arabtec.com'], ['recruiter', 'recruiter@arabtec.com'], ['system_admin', 'admin@arabtec.com'],
];
const missing = ['ceo (no seed user)'];
const tok = {};
for (const [role, email] of USERS) {
  const pw = role === 'system_admin' ? process.env.SEED_ADMIN_PASSWORD : 'Arabtec@123';
  const l = await call('POST', '/api/auth/login', null, { email, password: pw });
  if (!l.json?.token) { missing.push(`${role} (login ${l.status})`); continue; }
  tok[role] = l.json.token;
}
const rec = uid('recruiter@arabtec.com'), hm = uid('hiring.manager@arabtec.com');
const ins = (t, ticket, hmId) => Number(db.run("INSERT INTO recruitment_request(ticket_no,title,status,headcount,requester_id,owner_id,created_by,hiring_manager_id) VALUES (?,?,'sourcing',1,?,?,?,?)", [ticket, t, rec, rec, rec, hmId]).lastInsertRowid);
const R1 = ins('Probe request 1', 'PRB-1', hm), R2 = ins('Probe request 2', 'PRB-2', null);
const mkC = async (name) => { const r = await call('POST', '/api/candidates', tok.recruiter, { fullName: name, email: name.toLowerCase().replace(/\W/g, '') + '@example.invalid' }); const c = r.json?.candidate; if (!c) throw new Error('candidate create ' + r.status + r.text.slice(0, 200)); return c.id; };
const C1 = await mkC('Probe One'), C2 = await mkC('Probe Two'), C3 = await mkC('Probe Three');
const link = async (c, r) => { const x = await call('POST', '/api/applications', tok.recruiter, { candidateId: c, requestId: r }); if (!x.json?.application) throw new Error('link ' + x.status + x.text.slice(0, 200)); return x.json.application.id; };
const A1 = await link(C1, R1), A2 = await link(C2, R2);
const mv = await call('POST', `/api/applications/${A1}/move`, tok.recruiter, { status: 'shortlisted' });
if (mv.status !== 200) throw new Error('move ' + mv.status + mv.text.slice(0, 200));
const fd = new FormData();
fd.append('file', new Blob([fs.readFileSync(new URL('../test-cv.pdf', import.meta.url))], { type: 'application/pdf' }), 'test-cv.pdf');
const up = await fetch(`${B}/api/candidates/${C1}/resume?parse=0`, { method: 'POST', headers: { Authorization: 'Bearer ' + tok.recruiter }, body: fd });
if (up.status >= 300) throw new Error('resume upload ' + up.status + (await up.text()).slice(0, 200));

const reads = [
  '/api/requests', `/api/requests/${R1}`, `/api/requests/${R2}`, `/api/applications/request/${R1}`, `/api/applications/request/${R2}`,
  '/api/applications?pageSize=5', '/api/candidates?pageSize=5', `/api/candidates/${C1}`, `/api/candidates/${C2}`, `/api/candidates/${C3}`,
  `/api/candidates/${C1}/resume`, `/api/candidates/${C3}/resume`, `/api/thread/request/${R1}`, `/api/thread/request/${R2}`,
  '/api/org/locations', '/api/users', '/api/settings/system', '/api/settings/notifications', '/api/audit?pageSize=5', '/api/dashboard',
  '/api/offers', '/api/interviews', '/api/notifications', '/api/requests/meta/form',
].map((p) => ['GET', p]);
const muts = [
  ['PUT', '/api/org/locations/areas', { areas: ['Cairo Area', 'North Coast Area'] }],
  ['POST', `/api/applications/${A2}/move`, { status: 'shortlisted' }],
  ['POST', `/api/applications/${A1}/move`, { status: 'interviewing' }],
  ['POST', `/api/thread/request/${R2}`, { body: 'probe' }],
  ['PUT', `/api/requests/${R2}`, { title: 'probe' }],
  ['POST', '/api/users', { email: 'probe@x.invalid', fullName: 'Probe' }],
  ['DELETE', `/api/candidates/${C3}`],
];
// label: show placeholders instead of ids so rows are readable
const label = (p) => p.replace(`/requests/${R1}`, '/requests/R1').replace(`/requests/${R2}`, '/requests/R2').replace(`/request/${R1}`, '/request/R1').replace(`/request/${R2}`, '/request/R2')
  .replace(new RegExp(`/candidates/(${C1}|${C2}|${C3})`), (m, i) => '/candidates/' + (i == C1 ? 'C1' : i == C2 ? 'C2' : 'C3'))
  .replace(`/applications/${A1}/`, '/applications/<C1 app>/').replace(`/applications/${A2}/`, '/applications/<C2 app>/');
const rows = []; const cols = ['anon', ...USERS.map((u) => u[0]).filter((r) => tok[r])];
const rec_ = (role, email, m, p, status) => rows.push({ role, email, m, p: label(p), status });
const emailOf = Object.fromEntries(USERS);
const actors = [['anon', ''], ...USERS.filter((u) => tok[u[0]])];
for (const [role, email] of actors) for (const [m, p] of reads) rec_(role, email, m, p, (await call(m, p, tok[role])).status);
for (const [role, email] of actors) for (const [m, p, b] of muts) rec_(role, email, m, p, (await call(m, p, tok[role], b)).status);

const out = path.resolve(import.meta.dirname, '../docs/audits/2026-10-25-onprem-audit/raw');
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(out + '/role-probe.csv', 'role,email,method,path,status\n' + rows.map((r) => [r.role, r.email, r.m, r.p, r.status].join(',')).join('\n') + '\n');
const keys = [...new Map(rows.map((r) => [r.m + ' ' + r.p, 1])).keys()];
const cell = (k, role) => rows.find((r) => r.role === role && r.m + ' ' + r.p === k)?.status ?? '';
const md = ['| endpoint | ' + cols.join(' | ') + ' |', '|---|' + cols.map(() => '---').join('|') + '|', ...keys.map((k) => `| ${k} | ${cols.map((c) => cell(k, c)).join(' | ')} |`)].join('\n') + '\n';
fs.writeFileSync(out + '/role-probe-matrix.md', md);
console.log('roles:', cols.join(', '), '| not probed:', missing.join('; '));
console.log(md);
process.exit(0);
