// C1.4 — global rate limiter. Runs with a deliberately low cap and a NON-test
// NODE_ENV so the limiter is active (it is bypassed under NODE_ENV=test).
const RID = process.pid + '_' + Date.now();
const DBF = `/tmp/arabtec_rl_${RID}.db`;
process.env.DATABASE_URL = 'file:' + DBF;
process.env.PORT = String(4680 + (process.pid % 100));
process.env.NODE_ENV = 'development';        // ensure limiter is NOT bypassed
process.env.RATE_LIMIT_MAX = '5';            // tiny cap for the test
process.env.RATE_LIMIT_WINDOW_MS = '60000';
process.env.SEED_ADMIN_PASSWORD = 'BootStrap#Aa1';
process.env.SEED_DEMO_DATA = 'false';
import fs from 'node:fs';
for (const f of [DBF, DBF + '-journal']) { try { fs.rmSync(f); } catch {} }
await import('./prisma/seed.js');
await import('./src/server.js');
await new Promise((r) => setTimeout(r, 900));

const B = 'http://localhost:' + process.env.PORT;
let pass = 0, fail = 0;
const c = (n, ok, x = '') => { console.log((ok ? '  ✅ ' : '  ❌ ') + n + ' ' + x); ok ? pass++ : fail++; };

console.log('\n— C1.4 global rate limiter (cap=5/min) —');
// Health is exempt: many hits must never be throttled.
let healthThrottled = false;
for (let i = 0; i < 8; i++) { const r = await fetch(B + '/api/health'); if (r.status === 429) healthThrottled = true; }
c('health endpoint never throttled', !healthThrottled);

// A normal /api path: after the cap, further requests get 429.
const statuses = [];
for (let i = 0; i < 8; i++) { const r = await fetch(B + '/api/auth/me'); statuses.push(r.status); }
c('some requests allowed before cap', statuses.slice(0, 5).some((s) => s !== 429), statuses.join(','));
c('requests past the cap return 429', statuses.includes(429), statuses.join(','));

console.log(`\n=== RATE LIMIT: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
