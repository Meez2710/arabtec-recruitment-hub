// Independent review findings on the assessment RC, as regression tests on the
// real HTTP routes (disposable SQLite DB):
//   AR-02 omitted `submitted` keeps the current state (only false withdraws)
//   AR-03 one parent/child policy rule; contradictory grants refused;
//         unsaved settings resolved by the server (preview endpoint)
//   AR-04 hidden Final Recommendation hides its justifications in API AND print;
//         printed Fit lines follow their evaluation section
//   AR-07 the printable document carries its own no-script CSP
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'arabtec-arfix-'));
process.env.DATABASE_URL = 'file:' + path.join(TMP, 'arfix.db');
process.env.UPLOAD_DIR = path.join(TMP, 'uploads');
process.env.PORT = process.env.ARFIX_TEST_PORT || '4395';
process.env.SEED_DEMO_DATA ||= 'true';
process.env.SMTP_TRANSPORT = 'json';
const { adminToken, ADMIN_BOOTSTRAP_PASSWORD } = await import('./test-support/admin-session.mjs');
process.env.SEED_ADMIN_PASSWORD ||= ADMIN_BOOTSTRAP_PASSWORD;
await import('./prisma/seed.js');
await import('./src/server.js');
const { waitForReady } = await import('./test-support/wait-ready.mjs');
const B = 'http://localhost:' + process.env.PORT;
await waitForReady(B);
const P = await import('./src/lib/assessment-policy.js');

let pass = 0, fail = 0;
const c = (n, ok, x = '') => { console.log((ok ? '  ✅ ' : '  ❌ ') + n + (ok ? '' : ' ' + x)); ok ? pass++ : fail++; };
async function api(p, { method = 'GET', token, body } = {}) {
  const r = await fetch(B + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch {}
  return { status: r.status, json: j, text };
}
const login = async (e) => (await api('/api/auth/login', { method: 'POST', body: { email: e, password: 'Arabtec@123' } })).json.token;
const TECH = ['technical_knowledge', 'relevant_experience', 'problem_solving', 'tools_software', 'planning_organizing'];
const rows = (s) => Object.fromEntries(TECH.map((k) => [k, { score: s, notes: '' }]));

try {
  const admin = await adminToken(B);
  const hrMgr = await login('hr.manager@arabtec.com');
  const hrDir = await login('hr.director@arabtec.com');
  const recMgr = await login('rec.manager@arabtec.com');
  const recruiter = await login('recruiter@arabtec.com');
  const interviewer = await login('interviewer@arabtec.com');
  const meta = (await api('/api/requests/meta/form', { token: hrMgr })).json;
  const cr = await api('/api/requests', { method: 'POST', token: hrMgr, body: { title: 'ARFIX Request', justification: 'new_hire', projectId: meta.projects[0].id, departmentId: meta.departments[0].id, location: 'Cairo', headcount: 1, priority: 'high' } });
  const rid = cr.json.request.id;
  await api(`/api/requests/${rid}/submit`, { method: 'POST', token: hrMgr });
  await api(`/api/requests/${rid}/approve`, { method: 'POST', token: hrDir, body: {} });
  await api(`/api/requests/${rid}/assign`, { method: 'POST', token: recMgr, body: { ownerId: meta.recruiters.find((r) => r.name === 'Karim Adel').id } });
  const cand = (await api('/api/candidates', { method: 'POST', token: hrMgr, body: { fullName: 'ARFIX Candidate', phone: '+201000000501' } })).json.candidate.id;
  const appId = (await api('/api/applications', { method: 'POST', token: recruiter, body: { candidateId: cand, requestId: rid, initialStatus: 'matched' } })).json.application.id;
  await api(`/api/applications/${appId}/move`, { method: 'POST', token: recruiter, body: { status: 'interviewing' } });
  const mona = (await api('/api/interviews/meta/form', { token: recruiter })).json.interviewers.find((u) => u.name === 'Mona Sami');
  await api('/api/interviews', { method: 'POST', token: recruiter, body: { applicationId: appId, interviewType: 'technical', scheduledAt: new Date(Date.now() + 86400000).toISOString(), panel: [{ interviewerId: mona.id }] } });
  const post = (body) => api(`/api/assessments/application/${appId}`, { method: 'POST', token: interviewer, body });
  const bundle = async (t = interviewer) => (await api(`/api/assessments/application/${appId}`, { token: t })).json.assessment;

  console.log('\n— AR-02 omitted submitted keeps state —');
  c('submit technical (201)', (await post({ evaluatorType: 'technical', submitted: true, technical: rows(4), recommendation: 'proceed', technicalJustification: 'ARFIX-JUSTIFICATION' })).status === 201);
  const partial = await post({ evaluatorType: 'technical', technical: { technical_knowledge: { score: 5 } } });
  c('partial update without `submitted` accepted', partial.status === 201, partial.text);
  c('…and the evaluation stays submitted', partial.json?.assessment?.technical?.status === 'submitted');
  c('…with the new score saved', partial.json?.assessment?.technical?.rows?.technical_knowledge?.score === 5);
  const logs = (await api('/api/audit?pageSize=200', { token: admin })).json.logs.filter((l) => String(l.entityId) === String(appId) && l.action.startsWith('assessment.'));
  c('audited as an update of a submitted evaluation', logs[0]?.action === 'assessment.updated' && logs[0]?.newValue?.state === 'submitted');
  const withdraw = await post({ evaluatorType: 'technical', submitted: false });
  c('explicit submitted:false still withdraws to draft', withdraw.json?.assessment?.technical?.status === 'draft');
  await post({ evaluatorType: 'technical', submitted: true });
  c('resubmitting needs no fields re-sent', (await bundle()).technical.status === 'submitted');

  console.log('\n— AR-03 one parent/child rule —');
  const tech = { id: 1, roles: ['interviewer'], permissions: ['candidate.view', 'interview.view_all', 'interview.feedback'] };
  const app = { id: 1, status: 'interviewing', request_id: null };
  const r = (key, overrides) => P.resolveAssessmentPermission({ user: tech, application: app, fieldKey: key, overrides });
  c('resolver: child grant under hidden section is not effective', JSON.stringify(r('assessment.behavioral.openness', { technical: { 'assessment.behavioral.openness': { view: true, edit: true } } })) === JSON.stringify({ canView: false, canEdit: false }));
  c('resolver: hiding Final Recommendation hides its default-visible justification', JSON.stringify(r('assessment.finalRecommendation.technicalJustification', { technical: { 'assessment.finalRecommendation': { view: false, edit: false } } })) === JSON.stringify({ canView: false, canEdit: false }));
  c('resolver: read-only evaluation section blocks editing its criteria', r('assessment.technical.toolsSoftware', { technical: { 'assessment.technical': { view: true, edit: false } } }).canEdit === false);
  c('resolver: justification edit is independent of the shared decision (default technical)', JSON.stringify(r('assessment.finalRecommendation.technicalJustification', {})) === JSON.stringify({ canView: true, canEdit: true }));
  const contradictory = await api('/api/assessments/policy', { method: 'PUT', token: admin, body: { overrides: { technical: { 'assessment.behavioral.openness': { view: true, edit: true } } } } });
  c('PUT refuses a field grant under a hidden section (400, explained)', contradictory.status === 400 && /hidden/.test(contradictory.json?.error || ''), contradictory.text);
  const roEdit = await api('/api/assessments/policy', { method: 'PUT', token: admin, body: { overrides: { technical: { 'assessment.technical': { view: true, edit: false }, 'assessment.technical.toolsSoftware': { view: true, edit: true } } } } });
  c('PUT refuses an editable criterion under a read-only evaluation section (400)', roEdit.status === 400 && /read-only/.test(roEdit.json?.error || ''), roEdit.text);
  const prev = await api('/api/assessments/policy/preview', { method: 'POST', token: admin, body: { overrides: { technical: { 'assessment.finalRecommendation': { view: false, edit: false } } } } });
  c('preview returns server-resolved effective result for unsaved changes', prev.status === 200 && prev.json.valid === true
    && prev.json.effective.technical['assessment.finalRecommendation.technicalJustification'].view === false
    && prev.json.effective.technical['assessment.finalRecommendation.technicalJustification'].configured.view === true, prev.text.slice(0, 200));
  const badPrev = await api('/api/assessments/policy/preview', { method: 'POST', token: admin, body: { overrides: { technical: { 'assessment.behavioral.openness': { view: true, edit: false } } } } });
  c('preview reports an invalid draft instead of guessing', badPrev.json?.valid === false && /hidden/.test(badPrev.json?.error || ''));
  c('preview needs the settings permission (403 for HR manager)', (await api('/api/assessments/policy/preview', { method: 'POST', token: hrMgr, body: { overrides: {} } })).status === 403);
  const pol = (await api('/api/assessments/policy', { token: admin })).json.policy;
  c('policy definition marks which sections gate their fields', pol.sections.find((s) => s.key === 'assessment.finalRecommendation').gatesView === true && pol.sections.find((s) => s.key === 'assessment.candidate').gatesView === false);

  console.log('\n— AR-04 hidden Final Recommendation: API and print agree —');
  const hide = await api('/api/assessments/policy', { method: 'PUT', token: admin, body: { overrides: { technical: { 'assessment.finalRecommendation': { view: false, edit: false } } } } });
  c('hide Final Recommendation for technical (200)', hide.status === 200);
  const hb = await bundle();
  c('API: shared decision absent', !('finalDecision' in hb));
  c('API: technical justification absent', hb.technical && !('justification' in hb.technical) && !JSON.stringify(hb).includes('ARFIX-JUSTIFICATION'));
  c('API: technical fit still present (belongs to the technical section)', hb.technical?.computedFit === 'acceptable' || hb.technical?.computedFit === 'strong');
  const pv = await api(`/api/assessments/application/${appId}/preview`, { token: interviewer });
  c('print: Technical Fit shown', pv.text.includes('Technical Fit'));
  c('print: justification and decision line omitted', !pv.text.includes('ARFIX-JUSTIFICATION') && !pv.text.includes('<strong>Decision:</strong>'));
  await api('/api/assessments/policy', { method: 'PUT', token: admin, body: { overrides: {} } });
  const pv2 = await api(`/api/assessments/application/${appId}/preview`, { token: interviewer });
  c('print with defaults: justification shown again', pv2.text.includes('ARFIX-JUSTIFICATION') && pv2.text.includes('<strong>Decision:</strong>'));

  console.log('\n— AR-07 printable document carries its own no-script CSP —');
  c('meta CSP is in the document head, before any content', /<head><meta charset="UTF-8">\s*<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'/.test(pv2.text));
  c('meta CSP forbids scripts (no script-src, default none)', !/script-src/.test(pv2.text.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1] || 'script-src'));
} catch (e) { console.error(e); fail++; }
finally {
  console.log(`\n=== ASSESSMENT REVIEW FIXES: ${pass} passed, ${fail} failed ===\n`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.exit(fail ? 1 : 0);
}
