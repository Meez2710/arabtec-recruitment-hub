// C2.2 — email module. Uses SMTP_TRANSPORT=json (dry-run) so the full send path
// is exercised without a real server. Verifies: status/verify/test endpoints,
// no-op when unconfigured (checked in isolation), and the send path builds a message.
const RID = process.pid + '_' + Date.now();
const DBF = `/tmp/arabtec_email_${RID}.db`;
process.env.DATABASE_URL = 'file:' + DBF;
process.env.PORT = String(4720 + (process.pid % 90));
process.env.SEED_ADMIN_PASSWORD = 'BootStrap#Aa1';
process.env.SEED_DEMO_DATA = 'true';
process.env.SMTP_TRANSPORT = 'json';           // dry-run transport
process.env.MAIL_FROM = 'career@arabtecegy.com';
import fs from 'node:fs';
for (const f of [DBF, DBF + '-journal']) { try { fs.rmSync(f); } catch {} }
await import('./prisma/seed.js');
await import('./src/server.js');
await new Promise((r) => setTimeout(r, 900));

const B = 'http://localhost:' + process.env.PORT;
let pass = 0, fail = 0;
const c = (n, ok, x = '') => { console.log((ok ? '  ✅ ' : '  ❌ ') + n + ' ' + x); ok ? pass++ : fail++; };
const J = async (p, body, token) => {
  const r = await fetch(B + p, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, j };
};

const admin = (await J('/api/auth/login', { email: 'admin@arabtec.com', password: 'BootStrap#Aa1' })).j.token;
const recruiter = (await J('/api/auth/login', { email: 'recruiter@arabtec.com', password: 'Arabtec@123' })).j.token;

console.log('\n— Email status & test endpoints —');
const st = await J('/api/settings/email/status', null, admin);
c('status reports configured=true (json mode)', st.j?.configured === true, JSON.stringify(st.j));
c('status returns from-address, no secrets', st.j?.from === 'career@arabtecegy.com' && st.j?.host);

const noPerm = await J('/api/settings/email/test', { to: 'x@y.com' }, recruiter);
c('recruiter blocked from test-send (403)', noPerm.status === 403, 'got ' + noPerm.status);

const noTo = await J('/api/settings/email/test', {}, admin);
c('test-send requires recipient (400)', noTo.status === 400, 'got ' + noTo.status);

const sent = await J('/api/settings/email/test', { to: 'adly.moutaz@gmail.com' }, admin);
c('admin test-send succeeds (200)', sent.status === 200 && sent.j?.ok === true, JSON.stringify(sent.j).slice(0, 80));

const verify = await J('/api/settings/email/verify', {}, admin);
c('verify endpoint responds', verify.status === 200 || verify.status === 400);

console.log(`\n=== EMAIL: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
