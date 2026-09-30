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
// The screens are compiled on the server (lib/frontend-build.js): plain
// JavaScript, gzip-compressed, revalidated by ETag, and the page no longer
// asks the browser to download or run the Babel compiler.
const built=await fetch(B+'/build/app.js',{headers:{'Accept-Encoding':'gzip'}});
const builtJs=await built.text();
c('serves the compiled app as JavaScript', built.status===200 && /javascript/.test(built.headers.get('content-type')||'') && builtJs.includes('function App()'));
c('the compiled app contains no JSX (it was compiled on the server)', !/<div className=/.test(builtJs) && builtJs.includes('React.createElement'));
c('compiled app is gzip-compressed on direct HTTP', built.headers.get('content-encoding')==='gzip');
const etag=built.headers.get('etag');
const again=await fetch(B+'/build/app.js',{headers:{'If-None-Match':etag||''}});
c('an unchanged compiled file revalidates with 304', !!etag && again.status===304);
for (const f of ['intake-review','cv-intake','email-settings','org-structure']) {
  const r=await fetch(B+'/build/'+f+'.js'); c('serves compiled '+f, r.status===200 && (await r.text()).length>1000);
}
c('an unknown compiled name is 404', (await fetch(B+'/build/nope.js')).status===404);
c('the page no longer loads the Babel compiler or text/babel scripts', !idx.body.includes('babel.min.js') && !idx.body.includes('text/babel') && idx.body.includes('src="/build/app.js'));
const csp=(await fetch(B+'/')).headers.get('content-security-policy')||'';
c('the security policy no longer allows unsafe-eval', !!csp && !csp.includes('unsafe-eval'), csp.slice(0,80));
const spa = await txt('/users');
c('SPA fallback for client route /users', spa.status === 200 && spa.body.includes('<div id="root">'));
const apiMiss = await txt('/api/nonexistent');
c('unknown /api route is 404 (not SPA html)', apiMiss.status === 404);
const health = await txt('/api/health');
// Health payload is { ok, service, db } — assert on the real shape (the old
// 'phase' field was removed when the liveness check was simplified).
c('api health ok', health.status === 200 && health.body.includes('"ok":true') && health.body.includes('arabtec'));
console.log(`\n=== STATIC: ${pass} passed, ${fail} failed ===\n`);
process.exit(fail ? 1 : 0);
