// AR-01 — candidate visibility follows assignment scope.
// A user without broad visibility (Technical Interviewer, Hiring Manager,
// Project Manager) may see only candidates on hiring requests they requested,
// own or created, or in interviews they organise or sit on — and, for those,
// only the request/application metadata that is itself in scope. HR,
// recruitment and full-view roles keep the whole Talent Pool. Real HTTP routes,
// disposable SQLite database.
import { suiteDatabaseUrl } from './test-support/suite-db.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'arabtec-candscope-'));
process.env.DATABASE_URL = suiteDatabaseUrl('file:' + path.join(TMP, 'scope.db'));
process.env.UPLOAD_DIR = path.join(TMP, 'uploads');
process.env.PORT = process.env.CANDSCOPE_TEST_PORT || '4394';
process.env.SEED_DEMO_DATA ||= 'true';
process.env.SMTP_TRANSPORT = 'json';
const { ADMIN_BOOTSTRAP_PASSWORD } = await import('./test-support/admin-session.mjs');
process.env.SEED_ADMIN_PASSWORD ||= ADMIN_BOOTSTRAP_PASSWORD;
await import('./prisma/seed.js');
await import('./src/server.js');
const { waitForReady } = await import('./test-support/wait-ready.mjs');
const db = await import('./src/lib/db.js');
const { userContext } = await import('./src/lib/models.js');
const { createAnyhelpTools } = await import('./src/lib/ai/anyhelp.js');
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

try {
  const hrMgr = await login('hr.manager@arabtec.com');
  const hrDir = await login('hr.director@arabtec.com');
  const recMgr = await login('rec.manager@arabtec.com');
  const recruiter = await login('recruiter@arabtec.com');
  const interviewer = await login('interviewer@arabtec.com'); // Mona Sami
  const hm = await login('hiring.manager@arabtec.com');       // Nadia Fouad
  const pm = await login('pm@arabtec.com');                   // Tarek Salah
  const viewer = await login('viewer@arabtec.com');
  const meta = (await api('/api/requests/meta/form', { token: hrMgr })).json;
  const recId = meta.recruiters.find((r) => r.name === 'Karim Adel').id;
  async function request(token, title) {
    const cr = await api('/api/requests', { method: 'POST', token, body: { title, justification: 'new_hire', projectId: meta.projects[0].id, departmentId: meta.departments[0].id, location: 'Cairo', headcount: 3, priority: 'high' } });
    const id = cr.json.request.id;
    await api(`/api/requests/${id}/submit`, { method: 'POST', token });
    await api(`/api/requests/${id}/approve`, { method: 'POST', token: hrDir, body: {} });
    await api(`/api/requests/${id}/assign`, { method: 'POST', token: recMgr, body: { ownerId: recId } });
    return id;
  }
  const rHr = await request(hrMgr, 'SCOPE Assigned Request');
  const rHm = await request(hm, 'SCOPE Hiring Manager Request');
  const rSecret = await request(hrMgr, 'SCOPE Unrelated Confidential Request');
  const cand = async (name, phone) => (await api('/api/candidates', { method: 'POST', token: hrMgr, body: { fullName: name, phone, expectedSalary: 70777 } })).json.candidate.id;
  const assigned = await cand('SCOPE Assigned Candidate', '+201000000401');
  const hmCand = await cand('SCOPE Hiring Manager Candidate', '+201000000402');
  const unrelated = await cand('SCOPE Unrelated Candidate', '+201000000403');
  const app = async (cid, rid) => { const r = await api('/api/applications', { method: 'POST', token: recruiter, body: { candidateId: cid, requestId: rid, initialStatus: 'matched' } }); if (!r.json?.application) throw new Error('fixture application: ' + r.text); return r.json.application.id; };
  // Same candidate's earlier, concluded application on an unrelated request.
  const appAssignedSecret = await app(assigned, rSecret);
  await api(`/api/applications/${appAssignedSecret}/move`, { method: 'POST', token: recruiter, body: { status: 'rejected', reason: 'Not a fit for that role' } });
  const appAssigned = await app(assigned, rHr);
  if (!appAssigned || !appAssignedSecret) throw new Error('fixture: applications not created');
  const appHm = await app(hmCand, rHm);
  const appUnrelated = await app(unrelated, rSecret);
  await api(`/api/applications/${appAssigned}/move`, { method: 'POST', token: recruiter, body: { status: 'interviewing' } });
  const iv = (await api('/api/interviews/meta/form', { token: recruiter })).json;
  const mona = iv.interviewers.find((u) => u.name === 'Mona Sami');
  await api('/api/interviews', { method: 'POST', token: recruiter, body: { applicationId: appAssigned, interviewType: 'technical', scheduledAt: new Date(Date.now() + 86400000).toISOString(), panel: [{ interviewerId: mona.id }] } });

  // A real stored résumé on the unrelated candidate (proves denial, not a missing file).
  const fd = new FormData(); fd.append('file', new Blob(['SENTINEL-RESUME-BYTES'], { type: 'application/pdf' }), 'unrelated.pdf');
  const up = await fetch(`${B}/api/candidates/${unrelated}/resume`, { method: 'POST', headers: { Authorization: 'Bearer ' + hrMgr }, body: fd });
  if (up.status !== 201) throw new Error('fixture resume upload ' + up.status);
  // Sentinel note + activity tied to the assigned candidate's UNRELATED application.
  const note = await api(`/api/candidates/${assigned}/notes`, { method: 'POST', token: hrMgr, body: { body: 'SENTINEL-UNRELATED-NOTE', applicationId: appAssignedSecret } });
  if (note.status !== 201) throw new Error('fixture note ' + note.text);
  db.run('INSERT INTO candidate_activity (candidate_id, application_id, actor_name, type, note, occurred_at) VALUES (?,?,?,?,?,?)', [assigned, appAssignedSecret, 'Fixture', 'stage_changed', 'SENTINEL-UNRELATED-ACTIVITY', new Date().toISOString()]);
  db.run('INSERT INTO candidate_activity (candidate_id, application_id, actor_name, type, note, occurred_at) VALUES (?,?,?,?,?,?)', [assigned, appAssigned, 'Fixture', 'stage_changed', 'SENTINEL-OWN-ACTIVITY', new Date().toISOString()]);
  // A standalone offer for the Hiring Manager's candidate, on a request that is not theirs.
  const offer = await api('/api/offers', { method: 'POST', token: hrMgr, body: { candidateId: hmCand, requestId: rSecret, positionTitle: 'SENTINEL Standalone Offer', salaryOffered: 99999, currency: 'EGP' } });
  if (![200, 201].includes(offer.status)) throw new Error('fixture offer ' + offer.text);

  const ids = (r) => (r.json?.candidates || []).map((x) => x.id);

  console.log('\n— Technical Interviewer —');
  const tl = await api('/api/candidates?pageSize=200', { token: interviewer });
  c('list contains only the assigned candidate', tl.status === 200 && ids(tl).includes(assigned) && !ids(tl).includes(unrelated) && !ids(tl).includes(hmCand), JSON.stringify(ids(tl)));
  c('list total reflects scope, not the whole pool', tl.json?.pagination?.total === ids(tl).length, JSON.stringify(tl.json?.pagination));
  const td = await api(`/api/candidates/${unrelated}`, { token: interviewer });
  c('unrelated candidate detail denied', td.status === 403 || td.status === 404, `${td.status}`);
  c('unrelated name and request title absent from denial', !td.text.includes('SCOPE Unrelated') && !td.text.includes('Confidential'));
  const ta = await api(`/api/candidates/${assigned}`, { token: interviewer });
  c('assigned candidate detail allowed', ta.status === 200);
  c('…without salary', ta.json?.candidate && ta.json.candidate.expectedSalary == null && !ta.text.includes('70777'));
  c('…and without the unrelated request it is also linked to', !ta.text.includes('SCOPE Unrelated Confidential Request') && !(ta.json?.candidate?.links || []).some((l) => l.requestId === rSecret) && !(ta.json?.candidate?.applications || []).some((a) => a.id === appAssignedSecret));
  c('…but the assigned request remains linked', (ta.json?.candidate?.links || []).some((l) => l.requestId === rHr));
  c('unrelated résumé download denied', [403, 404].includes((await api(`/api/candidates/${unrelated}/resume`, { token: interviewer })).status));
  c('unrelated proposals denied', [403, 404].includes((await api(`/api/candidates/${unrelated}/proposals`, { token: interviewer })).status));
  const dup = await api('/api/candidates/check-duplicate', { method: 'POST', token: interviewer, body: { phone: '+201000000403' } });
  c('duplicate check cannot be used to look up unrelated people', !dup.text.includes('SCOPE Unrelated'), `${dup.status} ${dup.text.slice(0, 120)}`);
  c('CV intake queue denied', (await api('/api/candidates/intakes', { token: interviewer })).status === 403);
  c('literal routes still work for broad roles (/intakes)', (await api('/api/candidates/intakes', { token: hrMgr })).status === 200);
  const rd = await fetch(`${B}/api/candidates/${unrelated}/resume`, { headers: { Authorization: 'Bearer ' + interviewer } });
  const rdBody = await rd.text();
  c('stored unrelated résumé denied (file exists)', rd.status === 403 && !rdBody.includes('SENTINEL-RESUME-BYTES'), `${rd.status}`);
  const hrResume = await fetch(`${B}/api/candidates/${unrelated}/resume`, { headers: { Authorization: 'Bearer ' + hrMgr } });
  c('…while HR downloads the same stored file', hrResume.status === 200 && (await hrResume.text()).includes('SENTINEL-RESUME-BYTES'));
  for (const spelling of [`${unrelated}e0`, `0x${unrelated.toString(16)}`, `+${unrelated}`, `%20${unrelated}`, `${unrelated}%20`, `${unrelated}.0`, `0${unrelated}`, `%2B${unrelated}`]) {
    const results = [];
    for (const suffix of ['', '/resume', '/proposals']) {
      const r = await fetch(`${B}/api/candidates/${spelling}${suffix}`, { headers: { Authorization: 'Bearer ' + interviewer } });
      const t = await r.text();
      results.push([suffix || '/', r.status, t.includes('SCOPE Unrelated') || t.includes('SENTINEL-RESUME-BYTES')]);
    }
    const n = await api(`/api/candidates/${spelling}/notes`, { method: 'POST', token: hm, body: { body: 'probe' } });
    results.push(['notes(HM)', n.status, false]);
    c(`non-canonical id "${decodeURIComponent(spelling)}" never resolves past scope`, results.every(([, st, leak]) => [400, 403, 404].includes(st) && !leak), JSON.stringify(results));
  }
  const tAssigned = await api(`/api/candidates/${assigned}`, { token: interviewer });
  c('note tied to the unrelated application omitted', !tAssigned.text.includes('SENTINEL-UNRELATED-NOTE'));
  c('activity tied to the unrelated application omitted (incl. its rejection reason)', !tAssigned.text.includes('SENTINEL-UNRELATED-ACTIVITY') && !tAssigned.text.includes('Not a fit for that role'));
  c('activity on the assigned application kept', tAssigned.text.includes('SENTINEL-OWN-ACTIVITY'));
  const hrAssigned = await api(`/api/candidates/${assigned}`, { token: hrMgr });
  c('HR still sees the unrelated note and activity', hrAssigned.text.includes('SENTINEL-UNRELATED-NOTE') && hrAssigned.text.includes('SENTINEL-UNRELATED-ACTIVITY'));

  console.log('\n— anyhelp assistant tools (real seeded DB, no AI call) —');
  const monaUser = userContext(mona.id);
  const tools = createAnyhelpTools({ user: monaUser, all: db.all });
  const found = await tools.execute('search_candidates', { query: 'SCOPE', limit: 10 });
  c('search returns only the assigned candidate', (found.records || []).every((r) => r.id === assigned) && (found.records || []).some((r) => r.id === assigned), JSON.stringify((found.records || []).map((r) => r.id)));
  c('get_candidate on the unrelated id is unavailable', (await tools.execute('get_candidate', { id: unrelated })).error === 'Record unavailable.');
  const hrTools = createAnyhelpTools({ user: userContext((await api('/api/auth/me', { token: hrMgr })).json.user.id), all: db.all });
  const hrFound = ((await hrTools.execute('search_candidates', { query: 'SCOPE', limit: 10 })).records || []).map((r) => r.id);
  c('HR assistant still searches the whole pool', [assigned, hmCand, unrelated].every((id) => hrFound.includes(id)), JSON.stringify(hrFound));
  c('unrelated request still denied', [403, 404].includes((await api(`/api/requests/${rSecret}`, { token: interviewer })).status));

  console.log('\n— Hiring Manager (requester) —');
  const hl = await api('/api/candidates?pageSize=200', { token: hm });
  c('sees own request\'s candidate only', ids(hl).includes(hmCand) && !ids(hl).includes(unrelated) && !ids(hl).includes(assigned), JSON.stringify(ids(hl)));
  c('unrelated detail denied', [403, 404].includes((await api(`/api/candidates/${unrelated}`, { token: hm })).status));
  c('unrelated note denied', [403, 404].includes((await api(`/api/candidates/${unrelated}/notes`, { method: 'POST', token: hm, body: { body: 'x' } })).status));
  const hmDetail = await api(`/api/candidates/${hmCand}`, { token: hm });
  c('standalone offer on an unrelated request is not exposed to the scoped offer viewer', hmDetail.status === 200 && !hmDetail.text.includes('SENTINEL Standalone Offer') && !hmDetail.text.includes('SCOPE Unrelated Confidential Request'), `${hmDetail.status}`);
  c('HR still sees that offer', (await api(`/api/candidates/${hmCand}`, { token: hrMgr })).text.includes('SENTINEL Standalone Offer'));

  console.log('\n— Offers module follows the same scope —');
  const mkOffer = async (body) => { const r = await api('/api/offers', { method: 'POST', token: recruiter, body: { joiningDate: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10), ...body } }); if (!r.json?.offer?.id) throw new Error('fixture offer ' + r.text); return r.json.offer.id; };
  const offerOwn = await mkOffer({ applicationId: appHm, salaryOffered: 41000 });
  const offerUnrelated = await mkOffer({ applicationId: appUnrelated, salaryOffered: 88888 });
  const offerSentinel = offer.json.offer.id;
  const hol = await api('/api/offers', { token: hm });
  const holIds = (hol.json?.offers || []).map((o) => o.id);
  c('HM offer list includes the offer on their own request', hol.status === 200 && holIds.includes(offerOwn), JSON.stringify(holIds));
  c('HM offer list excludes offers on unrelated requests', !holIds.includes(offerUnrelated) && !holIds.includes(offerSentinel)
    && !hol.text.includes('SCOPE Unrelated Candidate') && !hol.text.includes('SCOPE Unrelated Confidential Request'), JSON.stringify(holIds));
  const hod = await api(`/api/offers/${offerUnrelated}`, { token: hm });
  c('HM opening an unrelated offer is refused (403)', hod.status === 403 && !hod.text.includes('SCOPE Unrelated Candidate'), `${hod.status} ${hod.text.slice(0, 80)}`);
  c('HM unrelated standalone offer refused (403)', (await api(`/api/offers/${offerSentinel}`, { token: hm })).status === 403);
  const hop = await api(`/api/offers/${offerUnrelated}/preview`, { token: hm });
  c('HM unrelated offer letter refused (403)', hop.status === 403 && !hop.text.includes('SCOPE Unrelated Candidate'), `${hop.status}`);
  const hoa = await api(`/api/offers/application/${appUnrelated}`, { token: hm });
  c('HM offers-by-application for an unrelated application reveal nothing', [200, 403].includes(hoa.status) && !(hoa.json?.offers || []).length && !hoa.text.includes('SCOPE Unrelated Candidate'), `${hoa.status} ${hoa.text.slice(0, 80)}`);
  const hown = await api(`/api/offers/${offerOwn}`, { token: hm });
  c('HM opens the offer on their own request, salary masked', hown.status === 200 && hown.json.offer.salaryVisible === false && hown.json.offer.salaryOffered === null && !hown.text.includes('41000'), `${hown.status}`);
  const hrl = ((await api('/api/offers', { token: hrMgr })).json?.offers || []).map((o) => o.id);
  c('HR still lists every offer', [offerOwn, offerUnrelated, offerSentinel].every((id) => hrl.includes(id)), JSON.stringify(hrl));

  console.log('\n— Project Manager (no interview scope) —');
  const pl = await api('/api/candidates?pageSize=200', { token: pm });
  c('sees no unrelated candidates', pl.status === 200 && !ids(pl).includes(unrelated) && !ids(pl).includes(assigned));

  console.log('\n— Broad roles keep the whole Talent Pool —');
  for (const [who, t] of [['HR manager', hrMgr], ['HR director', hrDir], ['recruiter', recruiter], ['viewer', viewer]]) {
    const l = await api('/api/candidates?pageSize=200', { token: t });
    c(`${who} lists every candidate`, [assigned, hmCand, unrelated].every((id) => ids(l).includes(id)));
    c(`${who} opens the unrelated candidate`, (await api(`/api/candidates/${unrelated}`, { token: t })).status === 200);
  }
  const hrDetail = await api(`/api/candidates/${assigned}`, { token: hrMgr });
  c('HR still sees every request the candidate is on', (hrDetail.json?.candidate?.links || []).some((l) => l.requestId === rSecret));
} catch (e) { console.error(e); fail++; }
finally {
  console.log(`\n=== CANDIDATE SCOPE: ${pass} passed, ${fail} failed ===\n`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.exit(fail ? 1 : 0);
}
