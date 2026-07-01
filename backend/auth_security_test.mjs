// Phase 1 security suite — C1.1 forced credential rotation.
// Verifies: no hardcoded default; bootstrap admin is flagged must_change_password;
// login surfaces the flag; self-service change-password enforces current-password
// + minimum length, clears the flag, and invalidates the old password.
// Unique DB + port per run so stale state / orphan servers can never interfere.
const RID = process.pid + '_' + Date.now();
const DBF = `/tmp/arabtec_authsec_${RID}.db`;
process.env.DATABASE_URL = 'file:' + DBF;
process.env.PORT = String(4400 + (process.pid % 150));
process.env.SEED_ADMIN_PASSWORD = 'BootStrap#Aa1';
process.env.SEED_DEMO_DATA = 'true';   // demo users needed for the lockout section
process.env.LOGIN_LOCK_THRESHOLD = '5';
process.env.LOGIN_LOCK_MINUTES = '15';
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

console.log('\n— C1.1 forced credential rotation —');
const login = await J('/api/auth/login', { email: 'admin@arabtec.com', password: 'BootStrap#Aa1' });
c('admin logs in with bootstrap password (200)', login.status === 200, 'got ' + login.status);
c('login flags mustChangePassword=true', login.j?.mustChangePassword === true);
const tok = login.j?.token;

const wrong = await J('/api/auth/change-password', { currentPassword: 'nope', newPassword: 'NewPass#Aa1' }, tok);
c('wrong current password rejected (401)', wrong.status === 401, 'got ' + wrong.status);

const short = await J('/api/auth/change-password', { currentPassword: 'BootStrap#Aa1', newPassword: 'x' }, tok);
c('too-short new password rejected (400)', short.status === 400, 'got ' + short.status);

const chg = await J('/api/auth/change-password', { currentPassword: 'BootStrap#Aa1', newPassword: 'NewPass#Aa1' }, tok);
c('valid change succeeds (200)', chg.status === 200, 'got ' + chg.status);
c('response clears mustChangePassword', chg.j?.mustChangePassword === false);

const relogin = await J('/api/auth/login', { email: 'admin@arabtec.com', password: 'NewPass#Aa1' });
c('re-login with new password works (200)', relogin.status === 200, 'got ' + relogin.status);
c('mustChangePassword now false', relogin.j?.mustChangePassword === false);

const oldpw = await J('/api/auth/login', { email: 'admin@arabtec.com', password: 'BootStrap#Aa1' });
c('old password rejected after rotation (401)', oldpw.status === 401, 'got ' + oldpw.status);

console.log('\n— C1.3 password policy (change-password) —');
// admin is now on NewPass#Aa1; try weak new passwords via change-password.
const tok2 = relogin.j?.token;
const weak1 = await J('/api/auth/change-password', { currentPassword: 'NewPass#Aa1', newPassword: 'alllowercase' }, tok2);
c('rejects <3 char classes (400)', weak1.status === 400, 'got ' + weak1.status);
const weak2 = await J('/api/auth/change-password', { currentPassword: 'NewPass#Aa1', newPassword: 'password1' }, tok2);
c('rejects common password (400)', weak2.status === 400, 'got ' + weak2.status);
const strong = await J('/api/auth/change-password', { currentPassword: 'NewPass#Aa1', newPassword: 'Zx9$mQr2Lk' }, tok2);
c('accepts a strong password (200)', strong.status === 200, 'got ' + strong.status);

console.log('\n— C1.3 account lockout (5 failed attempts) —');
const victim = 'recruiter@arabtec.com';
let lastStatus = 0;
for (let i = 0; i < 5; i++) {
  const r = await J('/api/auth/login', { email: victim, password: 'definitely-wrong' });
  lastStatus = r.status;
}
c('5th failed attempt returns 423 locked', lastStatus === 423, 'got ' + lastStatus);
const lockedGood = await J('/api/auth/login', { email: victim, password: 'Arabtec@123' });
c('correct password blocked while locked (423)', lockedGood.status === 423, 'got ' + lockedGood.status);

console.log(`\n=== AUTH SECURITY: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
