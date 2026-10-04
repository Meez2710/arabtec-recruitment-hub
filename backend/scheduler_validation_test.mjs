// Scheduler input contract on the real HTTP routes (disposable SQLite DB).
//   POST /api/interviews and PUT /api/interviews/:id must refuse an unusable
//   date or a non-positive / oversized duration, store one canonical instant,
//   and never half-apply a refused update.
//   Intentional panel overlap stays a warning (GET /clashes), not a block.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'arabtec-sched-'));
process.env.DATABASE_URL = 'file:' + path.join(TMP, 'sched.db');
process.env.UPLOAD_DIR = path.join(TMP, 'uploads');
process.env.PORT = process.env.SCHED_TEST_PORT || '4396';
process.env.SEED_DEMO_DATA ||= 'true';
process.env.SMTP_TRANSPORT = 'json';
const { adminToken, ADMIN_BOOTSTRAP_PASSWORD } = await import('./test-support/admin-session.mjs');
process.env.SEED_ADMIN_PASSWORD ||= ADMIN_BOOTSTRAP_PASSWORD;
await import('./prisma/seed.js');
await import('./src/server.js');
const { waitForReady } = await import('./test-support/wait-ready.mjs');
const B = 'http://localhost:' + process.env.PORT;
await waitForReady(B);

let pass = 0, fail = 0;
const c = (n, ok, x = '') => { console.log((ok ? '  ✅ ' : '  ❌ ') + n + (ok ? '' : ' ' + x)); ok ? pass++ : fail++; };
async function api(p, { method = 'GET', token, body } = {}) {
  const r = await fetch(B + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch {}
  return { status: r.status, json: j, text };
}
const login = async (e) => (await api('/api/auth/login', { method: 'POST', body: { email: e, password: 'Arabtec@123' } })).json.token;
// A fixed future working day, UTC, so the assertions never depend on today.
const T = (h, m = 0) => new Date(Date.UTC(2031, 0, 6, h, m)).toISOString();

try {
  await adminToken(B);
  const recruiter = await login('recruiter@arabtec.com');
  const meta = (await api('/api/interviews/meta/form', { token: recruiter })).json;
  const mona = meta.interviewers.find((u) => u.name === 'Mona Sami');
  const hassan = meta.interviewers.find((u) => u.name === 'Hassan Ali');
  const candidateId = (await api('/api/candidates', { method: 'POST', token: recruiter, body: { fullName: 'SCHED Candidate', phone: '+201000000601' } })).json.candidate.id;
  const body = (extra) => ({ candidateId, interviewType: 'technical', mode: 'video', scheduledAt: T(10), durationMin: 60, panel: [{ interviewerId: mona.id }], ...extra });
  const post = (extra) => api('/api/interviews', { method: 'POST', token: recruiter, body: body(extra) });
  const count = async () => (await api('/api/interviews', { token: recruiter })).json.interviews.filter((iv) => iv.candidateId === candidateId || iv.candidate?.id === candidateId).length;

  console.log('\n— POST refuses unusable input —');
  const n0 = await count();
  for (const [label, extra] of [
    ['unparseable date string', { scheduledAt: 'not-a-date' }],
    ['impossible calendar date', { scheduledAt: '2031-02-30T10:00:00Z' }],
    ['negative duration', { durationMin: -30 }],
    ['zero duration', { durationMin: 0 }],
    ['non-numeric duration', { durationMin: 'abc' }],
    ['fractional duration', { durationMin: 45.5 }],
    ['date without a timezone (server would guess)', { scheduledAt: '2031-01-06T10:00' }],
    ['duration beyond the calendar maximum (8h)', { durationMin: 600 }],
  ]) {
    const r = await post(extra);
    c(`POST ${label} → 400`, r.status === 400, `${r.status} ${r.text.slice(0, 120)}`);
  }
  c('…and none of the refused requests created an interview', (await count()) === n0, `${await count()} vs ${n0}`);

  console.log('\n— POST stores one canonical instant —');
  const off = await post({ scheduledAt: '2031-01-06T12:00:00+02:00', durationMin: 45 });
  c('offset input accepted (201)', off.status === 201, off.text.slice(0, 160));
  const ivId = off.json?.interview?.id;
  c('stored as ISO UTC', off.json?.interview?.scheduledAt === T(10), off.json?.interview?.scheduledAt);
  c('duration stored as given', off.json?.interview?.durationMin === 45);
  const inRange = (await api(`/api/interviews?from=${encodeURIComponent(T(10, 30))}&to=${encodeURIComponent(T(23))}`, { token: recruiter })).json.interviews.map((iv) => iv.id);
  c('calendar range starting after it (10:30Z) does not list a 10:00Z interview', !inRange.includes(ivId), JSON.stringify(inRange));
  const dflt = await post({ scheduledAt: T(14), durationMin: undefined });
  c('omitted duration defaults to 60', dflt.status === 201 && dflt.json.interview.durationMin === 60, dflt.text.slice(0, 120));

  console.log('\n— PUT refuses unusable input and never half-applies —');
  const get = async () => (await api(`/api/interviews/${ivId}`, { token: recruiter })).json.interview;
  const snap = await get();
  for (const [label, extra] of [
    ['unparseable date string', { scheduledAt: 'garbage' }],
    ['empty date string', { scheduledAt: '' }],
    ['negative duration', { durationMin: -10 }],
    ['zero duration', { durationMin: 0 }],
    ['duration beyond the calendar maximum', { durationMin: 9999 }],
    ['unknown interview mode', { mode: 'carrier-pigeon' }],
    ['unknown interview type', { interviewType: 'vibes' }],
    ['date without a timezone (server would guess)', { scheduledAt: '2031-01-06T10:00' }],
  ]) {
    const r = await api(`/api/interviews/${ivId}`, { method: 'PUT', token: recruiter, body: extra });
    c(`PUT ${label} → 400`, r.status === 400, `${r.status} ${r.text.slice(0, 120)}`);
  }
  const bad = await api(`/api/interviews/${ivId}`, { method: 'PUT', token: recruiter, body: { scheduledAt: T(16), panel: [] } });
  c('PUT new time + empty panel → 400', bad.status === 400, bad.text.slice(0, 120));
  const after = await get();
  c('…stored time, duration and status unchanged by every refused PUT', after.scheduledAt === snap.scheduledAt && after.durationMin === snap.durationMin && after.status === snap.status,
    JSON.stringify({ before: [snap.scheduledAt, snap.durationMin, snap.status], after: [after.scheduledAt, after.durationMin, after.status] }));
  const ok = await api(`/api/interviews/${ivId}`, { method: 'PUT', token: recruiter, body: { scheduledAt: '2031-01-06T17:30:00+02:00', durationMin: 90 } });
  c('valid reschedule accepted, stored as ISO UTC, status rescheduled', ok.status === 200 && ok.json.interview.scheduledAt === T(15, 30) && ok.json.interview.durationMin === 90 && ok.json.interview.status === 'rescheduled',
    ok.text.slice(0, 200));
  const same = await api(`/api/interviews/${ivId}`, { method: 'PUT', token: recruiter, body: { scheduledAt: '2031-01-06T17:30:00+02:00', locationOrLink: 'Teams' } });
  c('the same instant in another spelling is not a second reschedule', same.status === 200
    && (await api(`/api/audit?pageSize=50`, { token: await adminToken(B) })).json.logs.find((l) => l.action === 'interview.updated' && String(l.entityId) === String(ivId))?.newValue?.rescheduled === false);

  console.log('\n— intentional overlap is a warning, not a block —');
  const overlap = await post({ scheduledAt: T(15, 45), durationMin: 30, panel: [{ interviewerId: mona.id }, { interviewerId: hassan.id }] });
  c('an overlapping panel booking is still accepted (201)', overlap.status === 201, overlap.text.slice(0, 120));
  const cl = await api(`/api/interviews/clashes?start=${encodeURIComponent(T(15, 45))}&durationMin=30&panel=${mona.id}`, { token: recruiter });
  c('…and the clash check warns about Mona', cl.status === 200 && cl.json.clashes.some((x) => x.interviewerId === mona.id), cl.text.slice(0, 160));
} catch (e) { console.error(e); fail++; }
finally {
  console.log(`\n=== SCHEDULER VALIDATION: ${pass} passed, ${fail} failed ===\n`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.exit(fail ? 1 : 0);
}
