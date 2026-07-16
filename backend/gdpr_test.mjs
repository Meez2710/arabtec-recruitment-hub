// C1.6 — GDPR/PDPL data-protection mechanisms.
// Verifies: retention stamp on create, consent record, subject-access export,
// right-to-erasure (with confirm guard + PII anonymisation), retention report,
// and that the privacy actions are gated by the candidate.privacy permission.
const RID = process.pid + '_' + Date.now();
const DBF = `/tmp/arabtec_gdpr_${RID}.db`;
process.env.DATABASE_URL = 'file:' + DBF;
process.env.PORT = String(4890 + (process.pid % 80));
process.env.SEED_ADMIN_PASSWORD = 'BootStrap#Aa1';
process.env.SEED_DEMO_DATA = 'true';
process.env.SMTP_TRANSPORT = 'json';
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
  let j = null; let text = null;
  const ct = r.headers.get('content-type') || '';
  if (ct.includes('application/json')) { try { j = await r.json(); } catch {} }
  else { text = await r.text(); }
  return { status: r.status, j, text };
};
const login = (e, p = 'Arabtec@123') => J('/api/auth/login', { email: e, password: p }).then((r) => r.j.token);

const hrMgr = await login('hr.manager@arabtec.com');   // has candidate.privacy
const recruiter = await login('recruiter@arabtec.com'); // no candidate.privacy

console.log('\n— Create + retention stamp —');
const created = await J('/api/candidates', { fullName: 'Jane Privacy', email: 'jane.privacy@example.com', phone: '+201000000000' }, hrMgr);
const cid = created.j.candidate.id;
c('candidate created', created.status === 201 && !!cid);
c('retention_until stamped on create', !!created.j.candidate.retentionUntil, created.j.candidate.retentionUntil || '');
c('consent defaults to unknown', created.j.candidate.consentStatus === 'unknown');

console.log('\n— Consent —');
const consent = await J(`/api/candidates/${cid}/consent`, { status: 'given', source: 'application_form' }, hrMgr);
c('consent recorded as given', consent.j.candidate.consentStatus === 'given');
c('consent timestamp set', !!consent.j.candidate.consentAt);
const badConsent = await J(`/api/candidates/${cid}/consent`, { status: 'maybe' }, hrMgr);
c('invalid consent value rejected (400)', badConsent.status === 400);

console.log('\n— Subject Access export —');
const exp = await J(`/api/candidates/${cid}/export`, null, hrMgr);
let parsed = exp.j; if (!parsed && exp.text) { try { parsed = JSON.parse(exp.text); } catch {} }
c('export returns a JSON attachment', exp.status === 200 && !!parsed);
c('export includes candidate + related arrays', !!parsed && parsed.candidate?.id === cid && Array.isArray(parsed.applications) && Array.isArray(parsed.activity));
const recruiterExport = await J(`/api/candidates/${cid}/export`, null, recruiter);
c('recruiter without candidate.privacy blocked from export (403)', recruiterExport.status === 403);

console.log('\n— Right to erasure —');
const noConfirm = await J(`/api/candidates/${cid}/erase`, { reason: 'test' }, hrMgr);
c('erase without confirm is refused (400)', noConfirm.status === 400);
const recruiterErase = await J(`/api/candidates/${cid}/erase`, { confirm: 'ERASE' }, recruiter);
c('recruiter blocked from erase (403)', recruiterErase.status === 403);
const erased = await J(`/api/candidates/${cid}/erase`, { confirm: 'ERASE', reason: 'Candidate request' }, hrMgr);
c('erase with confirm succeeds', erased.status === 200);
c('PII anonymised (name = [Erased])', erased.j.candidate.fullName === '[Erased]');
c('email cleared after erase', !erased.j.candidate.email);
c('candidate_state = erased', erased.j.candidate.candidateState === 'erased');
const reErase = await J(`/api/candidates/${cid}/erase`, { confirm: 'ERASE' }, hrMgr);
c('double-erase blocked (409)', reErase.status === 409);

console.log('\n— Retention report —');
const rep = await J('/api/candidates/privacy/retention', null, hrMgr);
c('retention report returns config + list', rep.status === 200 && typeof rep.j.retentionMonths === 'number' && Array.isArray(rep.j.candidates));
const recruiterRep = await J('/api/candidates/privacy/retention', null, recruiter);
c('recruiter blocked from retention report (403)', recruiterRep.status === 403);

console.log(`\n=== GDPR/PDPL: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
