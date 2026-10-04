// Direct-API RBAC probe on the BOARD DEMO server after the golden path.
// Values are summarised (never printed raw): presence of salary figures, HR-only
// fields and unrelated names/request titles in each response body.
const B = 'http://localhost:4410'; const PW = process.env.DEMO_PW;
const st = JSON.parse((await import('node:fs')).readFileSync(new URL('./gp_state.json', import.meta.url)));
const login = async (e) => (await (await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: e, password: PW }) })).json()).token;
const get = async (t, p) => { const r = await fetch(B + p, { headers: { Authorization: 'Bearer ' + t } }); const text = await r.text(); return { status: r.status, text }; };
const hr = await login('hr.manager@arabtec.com');
const reqs = JSON.parse((await get(hr, '/api/requests?pageSize=50')).text).requests;
const bg = reqs.find((r) => /Quantity Surveyor/.test(r.title));
const cands = JSON.parse((await get(hr, '/api/candidates?pageSize=50')).text).candidates;
const unrelated = cands.filter((c) => c.id !== st.candidateId);
const SENSITIVE = { offerSalary: '42000', unrelatedName: 'Youssef Kamal', unrelatedName2: 'Laila Mansour', unrelatedRequest: 'Quantity Surveyor' };
const leaks = (text) => Object.entries(SENSITIVE).filter(([, v]) => text.includes(v)).map(([k]) => k);
const out = {};
for (const [who, email] of [['technicalInterviewer', 'interviewer@arabtec.com'], ['hiringManager', 'hiring.manager@arabtec.com']]) {
  const t = await login(email); const r = {};
  const list = await get(t, '/api/candidates?pageSize=50');
  r.talentPool = { status: list.status, ids: (JSON.parse(list.text).candidates || []).map((c) => c.id), leaks: leaks(list.text) };
  for (const c of unrelated) { const x = await get(t, `/api/candidates/${c.id}`); r[`unrelatedCandidate_${c.id}`] = x.status; }
  const own = await get(t, `/api/candidates/${st.candidateId}`);
  let ownJson = {}; try { ownJson = JSON.parse(own.text).candidate || {}; } catch {}
  r.assignedCandidate = { status: own.status, expectedSalaryValue: ownJson.expectedSalary ?? null, currentSalaryValue: ownJson.currentSalary ?? null, requestsShown: (ownJson.applications || []).map((a) => a.requestId), leaks: leaks(own.text) };
  r.unrelatedRequest = (await get(t, `/api/requests/${bg.id}`)).status;
  const rl = await get(t, '/api/requests?pageSize=50'); r.requestList = { status: rl.status, leaks: leaks(rl.text) };
  const ol = await get(t, '/api/offers'); r.offers = { status: ol.status, leaks: leaks(ol.text) };
  r.offerDetail = (await get(t, `/api/offers/${st.offerId}`)).status;
  r.offerLetter = (await get(t, `/api/offers/${st.offerId}/preview`)).status;
  const as = await get(t, `/api/assessments/application/${st.applicationId}`);
  let a = {}; try { a = JSON.parse(as.text).assessment || {}; } catch {}
  r.assessment = { status: as.status, salaryVisible: a.context?.salaryVisible ?? null, hrSectionKeys: a.hr ? Object.keys(a.hr) : null, finalDecision: a.finalDecision ? Object.keys(a.finalDecision) : null, leaks: leaks(as.text) };
  const pv = await get(t, `/api/assessments/application/${st.applicationId}/preview`); r.assessmentPrint = { status: pv.status, leaks: leaks(pv.text) };
  r.cvIntakes = (await get(t, '/api/candidates/intakes')).status;
  out[who] = r;
}
console.log(JSON.stringify(out, null, 1));
