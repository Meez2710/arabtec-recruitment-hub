// Scheduling Setup (production fix, 12 Oct 2026).
//
// Production 2beef22 had no Scheduling Setup at all: the working week, Head
// Office address and invitation templates existed only on an unreleased
// branch, behind a button called "Invitation templates". This proves, over
// real HTTP, the parts that make it usable by administrators:
//   1. who may open it (HR Director holds notification.manage — the edit right —
//      and was refused the panel) and who may change it;
//   2. Saturday–Thursday is the default, Friday off;
//   3. a saved week reaches the calendar (the interview list carries it) and
//      the out-of-hours warning;
//   4. it survives a restart: a NEW process on the same database reads it.
// Synthetic data only.
import { suiteDatabaseUrl } from './test-support/suite-db.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'arabtec-schedsetup-'));
const DB_URL = suiteDatabaseUrl('file:' + path.join(TMP, 'schedsetup.db'));
process.env.DATABASE_URL = DB_URL;
process.env.UPLOAD_DIR = path.join(TMP, 'uploads');
process.env.PORT = process.env.SCHED_SETUP_TEST_PORT || '4390';
process.env.SEED_DEMO_DATA ||= 'true';
process.env.SMTP_TRANSPORT = 'json';
process.env.MICROSOFT_TOKEN_ENCRYPTION_KEY ||= 'c'.repeat(64);
const { ADMIN_BOOTSTRAP_PASSWORD } = await import('./test-support/admin-session.mjs');
process.env.SEED_ADMIN_PASSWORD ||= ADMIN_BOOTSTRAP_PASSWORD;
await import('./prisma/seed.js');
await import('./src/server.js');
const { waitForReady } = await import('./test-support/wait-ready.mjs');
const B = 'http://localhost:' + process.env.PORT;
await waitForReady(B);

let pass = 0, fail = 0;
const c = (n, ok, x = '') => { console.log((ok ? '  ✅ ' : '  ❌ ') + n + (ok ? '' : ' ' + x)); ok ? pass++ : fail++; };
const login = async (e) => (await (await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: e, password: 'Arabtec@123' }) })).json()).token;
const api = async (p, token, method = 'GET', body) => {
  const r = await fetch(B + '/api' + p, { method, headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};

try {
  const hrDir = await login('hr.director@arabtec.com');
  const hrMgr = await login('hr.manager@arabtec.com');
  const recruiter = await login('recruiter@arabtec.com');
  const interviewer = await login('interviewer@arabtec.com');

  console.log('\n— 1. Who can open and change Scheduling Setup —');
  const asDir = await api('/interviews/message-templates', hrDir);
  c('HR Director (notification.manage) can open it (200)', asDir.status === 200, `${asDir.status} ${JSON.stringify(asDir.json).slice(0, 100)}`);
  c('…and is told they can edit it', asDir.json.canEdit === true);
  const asRec = await api('/interviews/message-templates', recruiter);
  c('a recruiter can still open it (200)', asRec.status === 200);
  c('an interviewer cannot open it (403)', (await api('/interviews/message-templates', interviewer)).status === 403);
  c('an interviewer cannot change it (403)', (await api('/interviews/message-templates', interviewer, 'PUT', { workingWeek: { days: [1], start: '09:00', end: '10:00' } })).status === 403);

  console.log('\n— 2. The approved default: Saturday–Thursday, Friday off —');
  const ww0 = asRec.json.workingWeek || {};
  c('working days are Sat, Sun, Mon, Tue, Wed, Thu', JSON.stringify(ww0.days) === JSON.stringify([0, 1, 2, 3, 4, 6]), JSON.stringify(ww0));
  c('Friday (5) is not a working day', Array.isArray(ww0.days) && !ww0.days.includes(5));
  c('hours default to 09:00–17:00', ww0.start === '09:00' && ww0.end === '17:00', JSON.stringify(ww0));
  const list0 = await api('/interviews', recruiter);
  c('the interview list carries the working week for the calendar', JSON.stringify(list0.json.workingWeek) === JSON.stringify(ww0), JSON.stringify(list0.json.workingWeek));
  const friday = '2026-10-16T08:00:00.000Z'; // Friday 11:00 Cairo
  const warnFri = await api(`/interviews/clashes?start=${encodeURIComponent(friday)}&durationMin=60`, recruiter);
  c('a Friday booking is warned about (never blocked)', warnFri.status === 200 && !!warnFri.json.hoursWarning, `${warnFri.status} ${JSON.stringify(warnFri.json).slice(0, 160)}`);

  console.log('\n— 3. A saved week changes real scheduling behaviour —');
  const bad = await api('/interviews/message-templates', hrDir, 'PUT', { workingWeek: { days: [], start: '09:00', end: '17:00' } });
  c('a week with no working day is refused (400)', bad.status === 400, `${bad.status}`);
  const next = { days: [0, 1, 2, 3, 4, 5, 6], start: '08:00', end: '18:00' };
  const saved = await api('/interviews/message-templates', hrDir, 'PUT', { workingWeek: next });
  c('HR Director saves a new week (200)', saved.status === 200, `${saved.status} ${JSON.stringify(saved.json).slice(0, 120)}`);
  const list1 = await api('/interviews', recruiter);
  c('the calendar now receives the saved week', JSON.stringify(list1.json.workingWeek) === JSON.stringify(next), JSON.stringify(list1.json.workingWeek));
  const warnFri2 = await api(`/interviews/clashes?start=${encodeURIComponent(friday)}&durationMin=60`, recruiter);
  c('a Friday booking is no longer warned about once Friday is a working day', warnFri2.status === 200 && !warnFri2.json.hoursWarning, JSON.stringify(warnFri2.json).slice(0, 160));

  console.log('\n— 4. It survives a restart —');
  const here = path.dirname(fileURLToPath(import.meta.url));
  const out = execFileSync(process.execPath, ['--experimental-sqlite', '--input-type=module', '-e',
    "const m = await import('./src/lib/interview-rules.js'); process.stdout.write(JSON.stringify(m.workingWeek()));"],
  { cwd: here, env: { ...process.env, DATABASE_URL: DB_URL, PORT: '0' }, encoding: 'utf8' });
  c('a fresh process on the same database reads the saved week', out.trim().endsWith(JSON.stringify(next)), out.slice(-200));

  // Put the approved default back, as an administrator would.
  const back = await api('/interviews/message-templates', hrMgr, 'PUT', { workingWeek: { days: [6, 0, 1, 2, 3, 4], start: '09:00', end: '17:00' } });
  c('restoring Saturday–Thursday works and is stored in order', back.status === 200 && JSON.stringify((await api('/interviews', recruiter)).json.workingWeek.days) === JSON.stringify([0, 1, 2, 3, 4, 6]));
} catch (e) { console.error(e); fail++; }
finally {
  console.log(`\n=== SCHEDULING SETUP: ${pass} passed, ${fail} failed ===\n`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
}
