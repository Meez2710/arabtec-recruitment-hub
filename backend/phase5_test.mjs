// Phase 5 — Offers & Joining tests.
process.env.DATABASE_URL = 'file:/tmp/arabtec_p5.db';
process.env.PORT = '4170';
import fs from 'node:fs';
for (const f of ['/tmp/arabtec_p5.db', '/tmp/arabtec_p5.db-journal']) { try { fs.rmSync(f); } catch {} }
await import('./prisma/seed.js');
await import('./src/server.js');
await new Promise((r) => setTimeout(r, 700));
const B = 'http://localhost:4170';
let pass = 0, fail = 0;
const c = (n, ok, x = '') => { console.log((ok ? '  ✅ ' : '  ❌ ') + n + ' ' + x); ok ? pass++ : fail++; };
async function api(p, { method = 'GET', token, body } = {}) {
  const r = await fetch(B + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, json: j };
}
const login = async (e, p = 'Arabtec@123') => (await api('/api/auth/login', { method: 'POST', body: { email: e, password: p } })).json.token;

async function approvedRequest(token, recMgr, headcount = 1) {
  const meta = await api('/api/requests/meta/form', { token });
  const cr = await api('/api/requests', { method: 'POST', token, body: { title: 'Offer Role', projectId: meta.json.projects[0].id, departmentId: meta.json.departments[0].id, headcount, priority: 'high' } });
  const id = cr.json.request.id;
  await api(`/api/requests/${id}/submit`, { method: 'POST', token });
  for (let i = 0; i < 3; i++) await api(`/api/requests/${id}/approve`, { method: 'POST', token, body: {} });
  const recId = meta.json.recruiters.find((r) => r.name === 'Karim Adel').id;
  await api(`/api/requests/${id}/assign`, { method: 'POST', token: recMgr, body: { ownerId: recId } });
  return id;
}
async function linkApp(token, reqId, name, status = 'final_interview') {
  const cand = await api('/api/candidates', { method: 'POST', token, body: { fullName: name, phone: '+2010' + Math.floor(Math.random() * 1e8) } });
  const app = await api('/api/applications', { method: 'POST', token, body: { candidateId: cand.json.candidate.id, requestId: reqId, initialStatus: status } });
  return { candId: cand.json.candidate.id, appId: app.json.application.id };
}
async function fullOffer(token, recMgr, hrMgr, salary, headcount = 1) {
  const reqId = await approvedRequest(hrMgr, recMgr, headcount);
  const { candId, appId } = await linkApp(token, reqId, 'Offer Cand ' + Math.random().toString(36).slice(2, 6));
  const create = await api('/api/offers', { method: 'POST', token, body: { applicationId: appId, salaryOffered: salary, joiningDate: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10), benefits: 'Housing, transport' } });
  return { reqId, candId, appId, offerId: create.json.offer?.id, create };
}

(async () => {
  const admin = await login('admin@arabtec.com', 'Admin@12345');
  const recruiter = await login('recruiter@arabtec.com');
  const hrMgr = await login('hr.manager@arabtec.com');
  const recMgr = await login('rec.manager@arabtec.com');
  const hrDir = await login('hr.director@arabtec.com');
  const hm = await login('hiring.manager@arabtec.com');
  const interviewer = await login('interviewer@arabtec.com');
  const viewer = await login('viewer@arabtec.com');

  console.log('\n— Create offer + links + app→offer_preparation —');
  const o1 = await fullOffer(recruiter, recMgr, hrMgr, 30000);
  c('recruiter creates offer (201)', o1.create.status === 201, `got ${o1.create.status}`);
  const offer = o1.create.json.offer;
  c('offer has OFR id', /^OFR-\d{4}-\d{5}$/.test(offer.offerNo || ''), offer.offerNo);
  c('offer links to application/candidate/request', offer.application?.id === o1.appId && offer.candidate?.id === o1.candId && offer.request?.id === o1.reqId);
  c('offer status draft', offer.status === 'draft');
  const appAfter = await api(`/api/applications/${o1.appId}`, { token: recruiter });
  // Workflow was simplified (Phase 0): offer creation now lands on the canonical
  // 'issuing_offer' stage (formerly 'offer_preparation').
  c('application moved to issuing_offer', appAfter.json.application.status === 'issuing_offer', appAfter.json.application.status);

  console.log('\n— Salary restriction server-side —');
  const asHm = await api(`/api/offers/${offer.id}`, { token: hm });
  c('HM sees offer but salary masked (null + false)', asHm.json.offer.salaryVisible === false && asHm.json.offer.salaryOffered === null);
  const asRec = await api(`/api/offers/${offer.id}`, { token: recruiter });
  c('recruiter sees offer salary (30000)', asRec.json.offer.salaryOffered === 30000);
  const interviewerSee = await api(`/api/offers/${offer.id}`, { token: interviewer });
  c('interviewer cannot access offer detail (403)', interviewerSee.status === 403, `got ${interviewerSee.status}`);

  console.log('\n— Approval chain (low salary → HR Manager only) —');
  await api(`/api/offers/${offer.id}/submit`, { method: 'POST', token: recruiter });
  const detail1 = await api(`/api/offers/${offer.id}`, { token: recruiter });
  c('submit → pending_approval', detail1.json.offer.status === 'pending_approval');
  c('chain has 1 level (HR Manager, salary ≤ threshold)', detail1.json.offer.approvals.length === 1, `got ${detail1.json.offer.approvals.length}`);
  const recCannotApprove = await api(`/api/offers/${offer.id}/approve`, { method: 'POST', token: recruiter, body: {} });
  c('recruiter cannot approve (403)', recCannotApprove.status === 403);
  const appr = await api(`/api/offers/${offer.id}/approve`, { method: 'POST', token: hrMgr, body: { comment: 'ok' } });
  c('HR manager approves → approved', appr.json.offer.status === 'approved', appr.json.offer.status);
  c('approvedBy recorded', !!appr.json.offer.approvedBy);

  console.log('\n— High-salary offer requires Director level —');
  const o2 = await fullOffer(recruiter, recMgr, hrMgr, 80000);
  await api(`/api/offers/${o2.offerId}/submit`, { method: 'POST', token: recruiter });
  const hiDetail = await api(`/api/offers/${o2.offerId}`, { token: recruiter });
  c('high-value chain has 2 levels (HR Mgr + Director)', hiDetail.json.offer.approvals.length === 2, `got ${hiDetail.json.offer.approvals.length}`);

  console.log('\n— Re-approval on salary change —');
  const o3 = await fullOffer(recruiter, recMgr, hrMgr, 20000);
  await api(`/api/offers/${o3.offerId}/submit`, { method: 'POST', token: recruiter });
  await api(`/api/offers/${o3.offerId}/approve`, { method: 'POST', token: hrMgr, body: {} });
  const beforeChange = await api(`/api/offers/${o3.offerId}`, { token: recruiter });
  c('offer approved before salary change', beforeChange.json.offer.status === 'approved');
  const salChange = await api(`/api/offers/${o3.offerId}`, { method: 'PUT', token: recruiter, body: { salaryOffered: 25000 } });
  c('salary change resets to pending_approval', salChange.json.offer.status === 'pending_approval', salChange.json.offer.status);

  console.log('\n— Reject approval requires reason —');
  const o4 = await fullOffer(recruiter, recMgr, hrMgr, 15000);
  await api(`/api/offers/${o4.offerId}/submit`, { method: 'POST', token: recruiter });
  const rejNoReason = await api(`/api/offers/${o4.offerId}/reject-approval`, { method: 'POST', token: hrMgr, body: {} });
  c('reject approval without reason (400)', rejNoReason.status === 400);
  const rej = await api(`/api/offers/${o4.offerId}/reject-approval`, { method: 'POST', token: hrMgr, body: { reason: 'over budget' } });
  c('reject approval with reason → rejected_by_approver', rej.json.offer.status === 'rejected_by_approver');

  console.log('\n— Send + result tracking —');
  // recruiter cannot send (no offer.send); HR Manager sends.
  const recCannotSend = await api(`/api/offers/${offer.id}/send`, { method: 'POST', token: recruiter });
  c('recruiter cannot send offer (403)', recCannotSend.status === 403, `got ${recCannotSend.status}`);
  const send = await api(`/api/offers/${offer.id}/send`, { method: 'POST', token: hrMgr });
  c('HR manager sends approved offer → sent', send.json.offer.status === 'sent', send.json.offer?.status || send.json.error);
  const appSent = await api(`/api/applications/${o1.appId}`, { token: recruiter });
  c('application → offer_sent (controlled)', appSent.json.application.status === 'offer_sent');
  const rejCandNoReason = await api(`/api/offers/${offer.id}/result`, { method: 'POST', token: recruiter, body: { result: 'rejected_by_candidate' } });
  c('candidate-reject without reason (400)', rejCandNoReason.status === 400);
  const accept = await api(`/api/offers/${offer.id}/result`, { method: 'POST', token: recruiter, body: { result: 'accepted' } });
  c('accept → accepted', accept.json.offer.status === 'accepted');
  const appAcc = await api(`/api/applications/${o1.appId}`, { token: recruiter });
  // In the simplified workflow, offer acceptance is tracked on the OFFER object
  // (offer.status = 'accepted'); the application stage remains 'offer_sent' until
  // the candidate joins. There is no separate 'offer_accepted' application stage.
  c('application stays offer_sent after accept (acceptance tracked on offer)', appAcc.json.application.status === 'offer_sent', appAcc.json.application.status);

  console.log('\n— Joining + vacancy automation (no overfill/double-count, transactional) —');
  const join = await api(`/api/offers/${offer.id}/result`, { method: 'POST', token: recruiter, body: { result: 'joined' } });
  c('mark joined → offer joined', join.json.offer.status === 'joined');
  const appJoined = await api(`/api/applications/${o1.appId}`, { token: recruiter });
  c('application → joined', appJoined.json.application.status === 'joined');
  const reqAfter = await api(`/api/requests/${o1.reqId}`, { token: hrMgr });
  c('request headcountFilled = 1', reqAfter.json.request.headcountFilled === 1, `got ${reqAfter.json.request.headcountFilled}`);
  c('request → filled (1 of 1)', reqAfter.json.request.status === 'filled', reqAfter.json.request.status);
  const reJoin = await api(`/api/offers/${offer.id}/result`, { method: 'POST', token: recruiter, body: { result: 'joined' } });
  c('re-join blocked, no double-count (409)', reJoin.status === 409, `got ${reJoin.status}`);

  console.log('\n— Overfill across two offers on a 1-seat request —');
  const reqId = await approvedRequest(hrMgr, recMgr, 1);
  const a = await linkApp(recruiter, reqId, 'Fill A'); const b = await linkApp(recruiter, reqId, 'Fill B');
  const oA = await api('/api/offers', { method: 'POST', token: recruiter, body: { applicationId: a.appId, salaryOffered: 10000, joiningDate: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10) } });
  const oB = await api('/api/offers', { method: 'POST', token: recruiter, body: { applicationId: b.appId, salaryOffered: 10000, joiningDate: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10) } });
  for (const id of [oA.json.offer.id, oB.json.offer.id]) {
    await api(`/api/offers/${id}/submit`, { method: 'POST', token: recruiter });
    await api(`/api/offers/${id}/approve`, { method: 'POST', token: hrMgr, body: {} });
    await api(`/api/offers/${id}/send`, { method: 'POST', token: hrMgr });
    await api(`/api/offers/${id}/result`, { method: 'POST', token: recruiter, body: { result: 'accepted' } });
  }
  const joinA = await api(`/api/offers/${oA.json.offer.id}/result`, { method: 'POST', token: recruiter, body: { result: 'joined' } });
  c('first join ok', joinA.json.offer.status === 'joined');
  const joinB = await api(`/api/offers/${oB.json.offer.id}/result`, { method: 'POST', token: recruiter, body: { result: 'joined' } });
  c('second join blocked — no overfill (409)', joinB.status === 409, `got ${joinB.status}`);
  const reqFill = await api(`/api/requests/${reqId}`, { token: hrMgr });
  c('headcountFilled stays 1', reqFill.json.request.headcountFilled === 1);

  console.log('\n— Terminal-app offer block + override —');
  const reqT = await approvedRequest(hrMgr, recMgr, 1);
  const t = await linkApp(recruiter, reqT, 'Rej Cand');
  await api(`/api/applications/${t.appId}/move`, { method: 'POST', token: recruiter, body: { status: 'rejected', reason: 'no' } });
  const offTerminal = await api('/api/offers', { method: 'POST', token: recruiter, body: { applicationId: t.appId, salaryOffered: 10000 } });
  c('cannot create offer for rejected app (409)', offTerminal.status === 409);
  const offOverrideNoPerm = await api('/api/offers', { method: 'POST', token: recruiter, body: { applicationId: t.appId, salaryOffered: 10000, overrideTerminal: true, overrideReason: 'x' } });
  c('recruiter cannot override (403)', offOverrideNoPerm.status === 403);
  const offOverride = await api('/api/offers', { method: 'POST', token: hrMgr, body: { applicationId: t.appId, salaryOffered: 10000, overrideTerminal: true, overrideReason: 'reconsidered' } });
  c('authorized override creates offer (201)', offOverride.status === 201);

  console.log('\n— RBAC + viewer —');
  c('viewer cannot create offer (403)', (await api('/api/offers', { method: 'POST', token: viewer, body: { applicationId: o1.appId } })).status === 403);
  const viewerList = await api('/api/offers', { token: viewer });
  c('viewer cannot view offers (403, no offer.view)', viewerList.status === 403, `got ${viewerList.status}`);

  console.log('\n— Candidate profile offers tab + masking —');
  const prof = await api(`/api/candidates/${o1.candId}`, { token: recruiter });
  c('candidate profile shows offers', (prof.json.candidate.offers || []).some((x) => x.id === offer.id));
  const profHm = await api(`/api/candidates/${o1.candId}`, { token: hm });
  c('HM profile offers: salary masked', (profHm.json.candidate.offers || []).every((x) => x.salaryVisible === false));

  console.log('\n— Audit —');
  const audit = await api('/api/audit?pageSize=500', { token: admin });
  const acts = new Set((audit.json.logs || []).map((l) => l.action));
  for (const a of ['offer.created', 'offer.submitted', 'offer.approved', 'offer.rejected_by_approver', 'offer.sent', 'offer.accepted', 'offer.joined', 'offer.salary_changed', 'request.seat_filled', 'request.vacancy_changed']) c('audit has ' + a, acts.has(a));

  console.log(`\n=== PHASE 5: ${pass} passed, ${fail} failed ===\n`);
  process.exit(fail ? 1 : 0);
})();
