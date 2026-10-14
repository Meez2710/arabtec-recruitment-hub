// Audit A3 (2026-10-12) — the candidate's answer to an interview invitation,
// ported from GitHub PR #46 onto the on-prem engine.
//   • HR records: no answer yet / confirmed / wants another time / declined
//   • only people who arrange interviews; only for interviews still to happen
//   • moving the time resets the answer; other edits keep it
//   • every change is in the activity and the audit log; "declined" cancels nothing
// Synthetic data, SMTP_TRANSPORT=json.
import { suiteDatabaseUrl } from './test-support/suite-db.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'arabtec-ivresp-'));
process.env.DATABASE_URL = suiteDatabaseUrl('file:' + path.join(TMP, 'ivresp.db'));
process.env.UPLOAD_DIR = path.join(TMP, 'uploads');
process.env.PORT = process.env.IV_RESPONSE_TEST_PORT || '4387';
process.env.SEED_DEMO_DATA ||= 'true';
process.env.SMTP_TRANSPORT = 'json';
const { ADMIN_BOOTSTRAP_PASSWORD } = await import('./test-support/admin-session.mjs');
process.env.SEED_ADMIN_PASSWORD ||= ADMIN_BOOTSTRAP_PASSWORD;
await import('./prisma/seed.js');
await import('./src/server.js');
const { waitForReady } = await import('./test-support/wait-ready.mjs');
const B = 'http://localhost:' + process.env.PORT;
await waitForReady(B);
const db = await import('./src/lib/db.js');

let pass = 0, fail = 0;
const c = (n, ok, x = '') => { console.log((ok ? '  ✅ ' : '  ❌ ') + n + (ok ? '' : ' ' + x)); ok ? pass++ : fail++; };
async function api(p, { method = 'GET', token, body } = {}) {
  const r = await fetch(B + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch {}
  return { status: r.status, json: j, text };
}
const must = async (p, o) => { const r = await api(p, o); if (r.status >= 400) throw new Error(`${o?.method || 'GET'} ${p} → ${r.status} ${r.text.slice(0, 200)}`); return r.json; };
const login = async (e) => (await api('/api/auth/login', { method: 'POST', body: { email: e, password: 'Arabtec@123' } })).json.token;
const at = (dayOffset, hh, mm = 0) => { const d = new Date(); d.setUTCDate(d.getUTCDate() + dayOffset); d.setUTCHours(hh, mm, 0, 0); return d.toISOString(); };

try {
  const recruiter = await login('recruiter@arabtec.com');
  const interviewer = await login('interviewer@arabtec.com');
  const people = (await must('/api/interviews/meta/form', { token: recruiter })).interviewers;
  const mona = people.find((u) => u.name === 'Mona Sami');
  let n = 0;
  async function booked(hh) {
    n += 1;
    const cid = (await must('/api/candidates', { method: 'POST', token: recruiter, body: { fullName: 'Synthetic Answer ' + n, email: `answer-${n}@example.invalid`, phone: '+2010012345' + String(60 + n) } })).candidate.id;
    return (await must('/api/interviews', { method: 'POST', token: recruiter, body: { candidateId: cid, scheduledAt: at(4, hh), durationMin: 60, interviewType: 'technical', mode: 'onsite', locationOrLink: 'Head Office', panel: [{ interviewerId: mona.id, isLead: true }] } })).interview;
  }
  const answer = (id, response, token = recruiter) => api(`/api/interviews/${id}/response`, { method: 'POST', token, body: { response } });

  console.log('\n— recording the answer —');
  const iv = await booked(7);
  c('a new interview starts at "No answer yet"', iv.candidateResponse === 'pending', iv.candidateResponse);
  for (const v of ['confirmed', 'change_requested', 'declined', 'pending']) {
    const r = await answer(iv.id, v);
    c(`"${v}" is saved and returned`, r.status === 200 && r.json?.interview?.candidateResponse === v, `${r.status} ${r.text.slice(0, 120)}`);
  }
  c('an unknown answer is refused (400)', (await answer(iv.id, 'maybe')).status === 400);
  c('a panelist cannot record it (403)', (await answer(iv.id, 'confirmed', interviewer)).status === 403);
  c('…and the list shows the answer too', (await must('/api/interviews', { token: recruiter })).interviews.find((x) => x.id === iv.id)?.candidateResponse === 'pending');

  console.log('\n— declined cancels nothing; history is kept —');
  await answer(iv.id, 'declined');
  const afterDecline = (await must(`/api/interviews/${iv.id}`, { token: recruiter })).interview;
  c('"declined" leaves the interview scheduled (the recruiter decides)', afterDecline.status === 'scheduled');
  const auditRows = db.all("SELECT * FROM audit_log WHERE action='interview.candidate_response' AND entity_id=?", [String(iv.id)]);
  c('each change is in the audit log with old and new answers', auditRows.length >= 5, String(auditRows.length));
  const acts = db.all("SELECT * FROM interview_activity WHERE interview_id=? AND type='candidate_response'", [iv.id]);
  c('…and in the interview activity', acts.length >= 5, String(acts.length));
  const before = auditRows.length;
  await answer(iv.id, 'declined');
  c('recording the same answer again adds nothing', db.all("SELECT id FROM audit_log WHERE action='interview.candidate_response' AND entity_id=?", [String(iv.id)]).length === before);

  console.log('\n— a time change resets it; other edits keep it —');
  const iv2 = await booked(10);
  await answer(iv2.id, 'confirmed');
  const moved = await api(`/api/interviews/${iv2.id}`, { method: 'PUT', token: recruiter, body: { scheduledAt: at(5, 10) } });
  c('moving the time resets the answer to "No answer yet"', moved.status === 200 && moved.json.interview.candidateResponse === 'pending', `${moved.status} ${moved.json?.interview?.candidateResponse}`);
  await answer(iv2.id, 'confirmed');
  const placeOnly = await api(`/api/interviews/${iv2.id}`, { method: 'PUT', token: recruiter, body: { locationOrLink: 'Site office' } });
  c('changing only the place keeps "confirmed"', placeOnly.status === 200 && placeOnly.json.interview.candidateResponse === 'confirmed', `${placeOnly.status} ${placeOnly.json?.interview?.candidateResponse}`);

  console.log('\n— only for interviews still to happen —');
  await must(`/api/interviews/${iv2.id}/status`, { method: 'POST', token: recruiter, body: { status: 'cancelled', reason: 'Synthetic' } });
  const late = await answer(iv2.id, 'confirmed');
  c('a cancelled interview refuses an answer (409)', late.status === 409 && late.json?.code === 'interview_not_upcoming', `${late.status}`);
} catch (e) { console.error(e); fail++; }
finally {
  console.log(`\n=== INTERVIEW RESPONSE: ${pass} passed, ${fail} failed ===\n`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
}
