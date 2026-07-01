// Screening gate — Database fitness screen (new → screening → fit | unfit).
// Verifies migration, endpoint validation, status transitions, counts, and audit.
const RID = process.pid + '_' + Date.now();
const DBF = `/tmp/arabtec_screen_${RID}.db`;
process.env.DATABASE_URL = 'file:' + DBF;
process.env.PORT = String(4550 + (process.pid % 120));
process.env.SEED_ADMIN_PASSWORD = 'BootStrap#Aa1';
process.env.SEED_DEMO_DATA = 'true';
import fs from 'node:fs';
for (const f of [DBF, DBF + '-journal']) { try { fs.rmSync(f); } catch {} }
await import('./prisma/seed.js');
await import('./src/server.js');
await new Promise((r) => setTimeout(r, 900));

const B = 'http://localhost:' + process.env.PORT;
let pass = 0, fail = 0;
const c = (n, ok, x = '') => { console.log((ok ? '  ✅ ' : '  ❌ ') + n + ' ' + x); ok ? pass++ : fail++; };
const J = async (p, body, token, method) => {
  const r = await fetch(B + p, { method: method || (body ? 'POST' : 'GET'), headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, j };
};

const recruiter = (await J('/api/auth/login', { email: 'recruiter@arabtec.com', password: 'Arabtec@123' })).j.token;

console.log('\n— Screening gate —');
const created = await J('/api/candidates', { fullName: 'Screen Test', email: 'screen@x.com', source: 'LinkedIn' }, recruiter);
c('candidate created (201)', created.status === 201, 'got ' + created.status);
const id = created.j?.candidate?.id;
c('new candidate defaults to screening_status=new', created.j?.candidate?.screeningStatus === 'new', created.j?.candidate?.screeningStatus);

const bad = await J(`/api/candidates/${id}/screening`, { status: 'banana' }, recruiter);
c('invalid screening status rejected (400)', bad.status === 400, 'got ' + bad.status);

const toScreening = await J(`/api/candidates/${id}/screening`, { status: 'screening' }, recruiter);
c('move to screening (200)', toScreening.status === 200 && toScreening.j?.candidate?.screeningStatus === 'screening');

const unfitNoReason = await J(`/api/candidates/${id}/screening`, { status: 'unfit' }, recruiter);
c('unfit without reason rejected (400)', unfitNoReason.status === 400, 'got ' + unfitNoReason.status);

const toFit = await J(`/api/candidates/${id}/screening`, { status: 'fit' }, recruiter);
c('mark fit (200)', toFit.status === 200 && toFit.j?.candidate?.screeningStatus === 'fit');

// counts + filter on list
const list = await J('/api/candidates', null, recruiter);
c('list returns screeningCounts', list.j?.screeningCounts && typeof list.j.screeningCounts.fit === 'number', JSON.stringify(list.j?.screeningCounts));
c('at least one fit candidate counted', (list.j?.screeningCounts?.fit || 0) >= 1);
const fitOnly = await J('/api/candidates?screeningStatus=fit', null, recruiter);
c('filter screeningStatus=fit returns only fit', (fitOnly.j?.candidates || []).every((x) => x.screeningStatus === 'fit'));

// screening change recorded in candidate activity
const detail = await J(`/api/candidates/${id}`, null, recruiter);
const acts = (detail.j?.candidate?.activity || []).map((a) => a.type);
c('screening change logged in activity', acts.includes('screening_changed'), acts.join(','));

console.log(`\n=== SCREENING: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
