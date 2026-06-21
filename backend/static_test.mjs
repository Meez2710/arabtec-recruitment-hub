process.env.DATABASE_URL = 'file:/tmp/arabtec_static.db';
process.env.PORT = '4101';
import fs from 'node:fs';
for (const f of ['/tmp/arabtec_static.db', '/tmp/arabtec_static.db-journal']) { try { fs.rmSync(f); } catch {} }
await import('./prisma/seed.js');
await import('./src/server.js');
await new Promise((r) => setTimeout(r, 700));
const B = 'http://localhost:4101';
let pass = 0, fail = 0;
const c = (n, ok, x = '') => { console.log((ok ? '  ✅ ' : '  ❌ ') + n + ' ' + x); ok ? pass++ : fail++; };
async function txt(p) { const r = await fetch(B + p); return { status: r.status, body: await r.text(), ct: r.headers.get('content-type') }; }

const idx = await txt('/');
c('serves index.html', idx.status === 200 && idx.body.includes('Arabtec Recruitment Hub'));
const css = await txt('/styles.css');
c('serves styles.css', css.status === 200 && css.body.includes('--primary'));
const jsx = await txt('/app.jsx');
c('serves app.jsx', jsx.status === 200 && jsx.body.includes('function App()'));
const spa = await txt('/users');
c('SPA fallback for client route /users', spa.status === 200 && spa.body.includes('<div id="root">'));
const apiMiss = await txt('/api/nonexistent');
c('unknown /api route is 404 (not SPA html)', apiMiss.status === 404);
const health = await txt('/api/health');
c('api health ok', health.status === 200 && health.body.includes('phase'));
console.log(`\n=== STATIC: ${pass} passed, ${fail} failed ===\n`);
process.exit(fail ? 1 : 0);
