// Ticket thread: messages, replies, file attach, CV post (creates candidate+app),
// feedback post, system auto-posts on submit/approve/assign/stage-move, RBAC + audit.
process.env.DATABASE_URL = 'file:/tmp/arabtec_thread.db';
process.env.PORT = '4275';
import fs from 'node:fs';
for (const f of ['/tmp/arabtec_thread.db', '/tmp/arabtec_thread.db-journal']) { try { fs.rmSync(f); } catch {} }
await import('./prisma/seed.js');
await import('./src/server.js');
await new Promise((r) => setTimeout(r, 800));
const B = 'http://localhost:4275';
let pass = 0, fail = 0;
const c = (n, ok, x = '') => { console.log((ok ? '  ✅ ' : '  ❌ ') + n + ' ' + x); ok ? pass++ : fail++; };
async function api(p, { method = 'GET', token, body } = {}) {
  const r = await fetch(B + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, json: j };
}
async function upload(p, token, filename, content, fields = {}) {
  const fd = new FormData();
  fd.append('file', new Blob([content], { type: 'application/pdf' }), filename);
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  const r = await fetch(B + p, { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, json: j };
}
const login = async (e, p = 'Arabtec@123') => (await api('/api/auth/login', { method: 'POST', body: { email: e, password: p } })).json.token;

(async () => {
  const admin = await login('admin@arabtec.com', 'Admin@12345');
  const recruiter = await login('recruiter@arabtec.com');
  const hrMgr = await login('hr.manager@arabtec.com');
  const recMgr = await login('rec.manager@arabtec.com');
  const hm = await login('hiring.manager@arabtec.com');
  const interviewer = await login('interviewer@arabtec.com');
  const viewer = await login('viewer@arabtec.com');

  const meta = await api('/api/requests/meta/form', { token: hrMgr });
  const recId = meta.json.recruiters.find((r) => r.name === 'Karim Adel').id;
  const cr = await api('/api/requests', { method: 'POST', token: hrMgr, body: { title: 'Thread Engineer', justification: 'new_hire', projectId: meta.json.projects[0].id, departmentId: meta.json.departments[0].id, headcount: 2, priority: 'high' } });
  const reqId = cr.json.request.id;

  console.log('\n— System auto-posts on lifecycle —');
  await api(`/api/requests/${reqId}/submit`, { method: 'POST', token: hrMgr });
  await api(`/api/requests/${reqId}/approve`, { method: 'POST', token: hrMgr, body: {} });
  await api(`/api/requests/${reqId}/assign`, { method: 'POST', token: recMgr, body: { ownerId: recId } });
  let th = await api(`/api/thread/request/${reqId}`, { token: hrMgr });
  const sysTexts = th.json.posts.filter((p) => p.type === 'system').map((p) => p.body);
  c('system post: submitted', sysTexts.some((t) => /submitted/i.test(t)));
  c('system post: approved', sysTexts.some((t) => /approved/i.test(t)));
  c('system post: recruiter assigned', sysTexts.some((t) => /assigned/i.test(t)));

  console.log('\n— Message + reply —');
  const msg = await api(`/api/thread/request/${reqId}`, { method: 'POST', token: recruiter, body: { body: 'Sourcing started, will share CVs today.' } });
  c('recruiter posts message (201)', msg.status === 201);
  const reply = await api(`/api/thread/request/${reqId}`, { method: 'POST', token: hm, body: { body: 'Great, prioritise MEP background.', parentPostId: msg.json.post.id } });
  c('hiring manager replies (201)', reply.status === 201 && reply.json.post.parentPostId === msg.json.post.id);
  th = await api(`/api/thread/request/${reqId}`, { token: recruiter });
  const top = th.json.posts.find((p) => p.id === msg.json.post.id);
  c('reply nested under message', top && top.replies.length === 1);

  console.log('\n— File attachment —');
  const filePost = await upload(`/api/thread/request/${reqId}/file`, recruiter, 'jd-notes.pdf', 'NOTES-BYTES', { body: 'Updated JD notes' });
  c('file attached (201)', filePost.status === 201 && filePost.json.post.hasFile);
  const dl = await fetch(B + `/api/thread/post/${filePost.json.post.id}/file`, { headers: { Authorization: 'Bearer ' + hm } });
  c('attachment downloads', dl.status === 200 && (await dl.text()).includes('NOTES-BYTES'));

  console.log('\n— CV post creates candidate + application —');
  const cv = await upload(`/api/thread/request/${reqId}/cv`, recruiter, 'omar-cv.pdf', 'CV-BYTES', { fullName: 'Omar Khaled', currentPosition: 'MEP Engineer', employer: 'Orascom', yearsExperience: '6' });
  c('CV posted (201)', cv.status === 201, `got ${cv.status}`);
  c('candidate created from CV', !!cv.json.candidateId);
  c('application linked from CV', !!cv.json.applicationId);
  c('CV post carries candidate name', cv.json.post.payload?.candidateName === 'Omar Khaled');
  // resume retrievable on the created candidate
  const rdl = await fetch(B + `/api/candidates/${cv.json.candidateId}/resume`, { headers: { Authorization: 'Bearer ' + recruiter } });
  c('CV stored as candidate résumé', rdl.status === 200 && (await rdl.text()).includes('CV-BYTES'));

  console.log('\n— Stage move auto-posts into thread —');
  await api(`/api/applications/${cv.json.applicationId}/move`, { method: 'POST', token: recruiter, body: { status: 'shortlisted' } });
  th = await api(`/api/thread/request/${reqId}`, { token: recruiter });
  c('stage move shows in thread', th.json.posts.some((p) => p.type === 'system' && /Omar Khaled moved/i.test(p.body || '')));

  console.log('\n— Structured feedback post —');
  await api(`/api/applications/${cv.json.applicationId}/move`, { method: 'POST', token: recruiter, body: { status: 'interview_1' } });
  const fb = await api(`/api/thread/request/${reqId}/feedback`, { method: 'POST', token: interviewer, body: { applicationId: cv.json.applicationId, candidateId: cv.json.candidateId, recommendation: 'proceed', rating: 4, body: 'Strong technical depth.' } });
  c('interviewer posts feedback (201)', fb.status === 201 && fb.json.post.type === 'feedback');
  c('feedback carries recommendation', fb.json.post.payload?.recommendation === 'proceed');

  console.log('\n— Edit / delete own post + RBAC —');
  const edit = await api(`/api/thread/post/${msg.json.post.id}`, { method: 'PUT', token: recruiter, body: { body: 'Sourcing started (edited).' } });
  c('author edits own post', edit.status === 200 && edit.json.post.edited === true);
  const cantEdit = await api(`/api/thread/post/${msg.json.post.id}`, { method: 'PUT', token: hm, body: { body: 'hijack' } });
  c('non-author cannot edit (403)', cantEdit.status === 403, `got ${cantEdit.status}`);
  const cantSystem = await api(`/api/thread/request/${reqId}`, { method: 'POST', token: viewer, body: { body: 'viewer note' } });
  c('viewer without request view scope blocked (403/404)', [403, 404].includes(cantSystem.status), `got ${cantSystem.status}`);
  const del = await api(`/api/thread/post/${filePost.json.post.id}`, { method: 'DELETE', token: recruiter });
  c('author deletes own post', del.status === 200);

  console.log('\n— Audit —');
  const audit = await api('/api/audit?pageSize=400', { token: admin });
  const acts = new Set((audit.json.logs || []).map((l) => l.action));
  for (const a of ['ticket.post_created', 'ticket.file_attached', 'ticket.cv_posted', 'ticket.feedback_posted', 'ticket.post_deleted'])
    c('audit has ' + a, acts.has(a));

  console.log(`\n=== THREAD: ${pass} passed, ${fail} failed ===\n`);
  process.exit(fail ? 1 : 0);
})();
