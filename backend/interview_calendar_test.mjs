// Interview calendar — the visible-range filter on GET /interviews and the
// panel clash warning (GET /interviews/clashes + findPanelClashes).
process.env.DATABASE_URL = 'file:/tmp/arabtec_ivcal.db';
process.env.PORT = '4178';
import fs from 'node:fs';
import { adminToken, ADMIN_BOOTSTRAP_PASSWORD } from './test-support/admin-session.mjs';
import { findPanelClashes } from './src/lib/interview-clashes.js';
for (const f of ['/tmp/arabtec_ivcal.db', '/tmp/arabtec_ivcal.db-journal']) { try { fs.rmSync(f); } catch {} }
process.env.SEED_ADMIN_PASSWORD ||= ADMIN_BOOTSTRAP_PASSWORD;

let pass = 0, fail = 0;
const c = (n, ok, x = '') => { console.log((ok ? '  ✅ ' : '  ❌ ') + n + ' ' + x); ok ? pass++ : fail++; };

/* ---------------- findPanelClashes: the rule itself, no server ---------------- */
console.log('\n— findPanelClashes (pure) —');
const T = (h, m = 0) => new Date(Date.UTC(2031, 0, 6, h, m)).toISOString();
const MONA = { id: 7, name: 'Mona Sami' }; const HASSAN = { id: 9, name: 'Hassan Ali' };
const existing = [
  { id: 1, status: 'scheduled', scheduledAt: T(10), durationMin: 60, panel: [MONA] },
  { id: 2, status: 'rescheduled', scheduledAt: T(13), durationMin: 60, panel: [MONA, HASSAN] },
  { id: 3, status: 'cancelled', scheduledAt: T(15), durationMin: 60, panel: [MONA] },
  { id: 4, status: 'completed', scheduledAt: T(16), durationMin: 60, panel: [MONA] },
];
const at = (h, m, dur, panel, extra = {}) => findPanelClashes({ start: T(h, m), durationMin: dur, panel, ...extra }, existing);

const inside = at(10, 30, 30, [7]);
c('an overlap inside an interview is a clash', inside.length === 1 && inside[0].interviewId === 1 && inside[0].interviewerId === 7, JSON.stringify(inside));
c('the clash carries the interviewer name and ISO start/end', inside[0]?.name === 'Mona Sami' && inside[0]?.start === T(10) && inside[0]?.end === T(11));
c('a proposal wrapping an interview is a clash', at(9, 30, 120, [7]).length === 1);
c('back-to-back after is NOT a clash (11:00 after 10:00–11:00)', at(11, 0, 60, [7]).length === 0);
c('back-to-back before is NOT a clash (09:00–10:00 before 10:00)', at(9, 0, 60, [7]).length === 0);
c('a rescheduled interview still occupies its slot', at(13, 15, 30, [9]).length === 1);
c('cancelled and completed interviews free the slot', at(15, 0, 120, [7]).length === 0);
c('only proposed panel members are reported', at(13, 0, 60, [9]).every((x) => x.interviewerId === 9));
c('two panel members on one interview → two entries', at(13, 0, 60, [7, 9]).length === 2);
c('someone not on the proposed panel never clashes', at(10, 0, 60, [42]).length === 0);
c('editing an interview does not clash with itself', at(10, 0, 60, [7], { excludeId: 1 }).length === 0);
c('an unusable start yields no clashes, not a throw', findPanelClashes({ start: 'nope', durationMin: 60, panel: [7] }, existing).length === 0);

/* ---------------- the HTTP surface ---------------- */
await import('./prisma/seed.js');
await import('./src/server.js');
await new Promise((r) => setTimeout(r, 700));
const B = 'http://localhost:4178';
async function api(p, { method = 'GET', token, body } = {}) {
  const r = await fetch(B + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, json: j };
}
const login = async (e, p = 'Arabtec@123') => (await api('/api/auth/login', { method: 'POST', body: { email: e, password: p } })).json.token;

(async () => {
  await adminToken(B);
  const recruiter = await login('recruiter@arabtec.com');
  const interviewer = await login('interviewer@arabtec.com');
  const meta = await api('/api/interviews/meta/form', { token: recruiter });
  const mona = meta.json.interviewers.find((u) => u.name === 'Mona Sami');
  const hassan = meta.json.interviewers.find((u) => u.name === 'Hassan Ali');
  const cand = await api('/api/candidates', { method: 'POST', token: recruiter, body: { fullName: 'Calendar Candidate', email: 'cal@x.com' } });
  const candidateId = cand.json.candidate.id;

  // Tomorrow, on whole UTC hours, so the assertions do not depend on the clock.
  const day = new Date(); day.setUTCDate(day.getUTCDate() + 1); day.setUTCHours(0, 0, 0, 0);
  const H = (h, m = 0, dayOffset = 0) => new Date(day.getTime() + dayOffset * 86400000 + (h * 60 + m) * 60000).toISOString();
  const book = async (start, panel, durationMin = 60) => (await api('/api/interviews', { method: 'POST', token: recruiter,
    body: { candidateId, scheduledAt: start, durationMin, interviewType: 'technical', mode: 'video', panel: panel.map((id, i) => ({ interviewerId: id, isLead: i === 0 })) } })).json.interview;
  const a = await book(H(10), [mona.id]);
  const b = await book(H(11), [mona.id]);
  const later = await book(H(10, 0, 2), [mona.id]);
  c('three interviews scheduled', !!(a && b && later));

  console.log('\n— GET /interviews?from&to —');
  const inRange = await api(`/api/interviews?from=${encodeURIComponent(H(0))}&to=${encodeURIComponent(H(0, 0, 1))}`, { token: recruiter });
  const ids = (inRange.json?.interviews || []).map((x) => x.id);
  c('the range returns the day\'s interviews', inRange.status === 200 && ids.includes(a.id) && ids.includes(b.id), `got ${inRange.status} ${ids}`);
  c('the range leaves out interviews after `to`', !ids.includes(later.id));
  const noRange = await api('/api/interviews', { token: recruiter });
  c('without from/to the list is unchanged (all interviews)', [a.id, b.id, later.id].every((id) => noRange.json.interviews.some((x) => x.id === id)));
  const bad = await api('/api/interviews?from=not-a-date', { token: recruiter });
  c('a malformed `from` is a 400, not an empty week', bad.status === 400, `got ${bad.status}`);

  console.log('\n— GET /interviews/clashes —');
  const q = (start, dur, panel, extra = '') => api(`/api/interviews/clashes?start=${encodeURIComponent(start)}&durationMin=${dur}&panel=${panel.join(',')}${extra}`, { token: recruiter });
  const one = await q(H(10, 30), 30, [mona.id]);
  c('/clashes is routed (not shadowed by /:id)', one.status === 200, `got ${one.status} ${JSON.stringify(one.json)}`);
  c('an overlapping panel member is reported', one.json?.clashes?.length === 1 && one.json.clashes[0].interviewerId === mona.id, JSON.stringify(one.json));
  c('the answer names who and when, and nothing about the candidate',
    one.json?.clashes?.every((x) => Object.keys(x).sort().join() === 'end,interviewerId,name,start'), JSON.stringify(one.json?.clashes));
  const edge = await q(H(12), 60, [mona.id]);
  c('back-to-back after the last interview is free', edge.json?.clashes?.length === 0, JSON.stringify(edge.json));
  const other = await q(H(10), 60, [hassan.id]);
  c('someone free at that time has no clash', other.json?.clashes?.length === 0);
  const self = await q(H(10), 60, [mona.id], `&excludeId=${a.id}`);
  c('excludeId keeps an edit from clashing with itself', self.json?.clashes?.length === 0, JSON.stringify(self.json));
  await api(`/api/interviews/${a.id}/status`, { method: 'POST', token: recruiter, body: { status: 'cancelled', reason: 'Calendar test' } });
  const freed = await q(H(10, 30), 30, [mona.id]);
  c('cancelling an interview frees the slot', freed.json?.clashes?.length === 0, JSON.stringify(freed.json));
  const badStart = await q('nope', 30, [mona.id]);
  c('a malformed start is a 400', badStart.status === 400, `got ${badStart.status}`);
  const denied = await api(`/api/interviews/clashes?start=${encodeURIComponent(H(10))}&panel=${mona.id}`, { token: interviewer });
  c('an interviewer (no schedule/edit permission) is refused', denied.status === 403, `got ${denied.status}`);

  console.log(`\n=== INTERVIEW CALENDAR: ${pass} passed, ${fail} failed ===\n`);
  process.exit(fail ? 1 : 0);
})();
