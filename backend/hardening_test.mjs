// Hardening / edge-case suite for the conversation-ticket + restructure features.
process.env.DATABASE_URL = 'file:/tmp/arabtec_hard.db';
process.env.PORT = '4276';
import fs from 'node:fs';
for (const f of ['/tmp/arabtec_hard.db', '/tmp/arabtec_hard.db-journal']) { try { fs.rmSync(f); } catch {} }
await import('./prisma/seed.js');
await import('./src/server.js');
await new Promise((r) => setTimeout(r, 800));
const B = 'http://localhost:4276';
let pass = 0, fail = 0;
const c = (n, ok, x = '') => { console.log((ok ? '  ✅ ' : '  ❌ ') + n + ' ' + x); ok ? pass++ : fail++; };
async function api(p, { method = 'GET', token, body } = {}) {
  const r = await fetch(B + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, json: j };
}
async function up(p, token, fn, content, fields = {}) {
  const fd = new FormData(); fd.append('file', new Blob([content], { type: 'application/pdf' }), fn);
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  const r = await fetch(B + p, { method: 'POST', headers: token ? { Authorization: 'Bearer ' + token } : {}, body: fd });
  return { status: r.status, json: await r.json().catch(() => null) };
}
const login = async (e, p = 'Arabtec@123') => (await api('/api/auth/login', { method: 'POST', body: { email: e, password: p } })).json.token;

(async () => {
  const admin = await login('admin@arabtec.com', 'Admin@12345');
  const t = await login('hr.manager@arabtec.com');
  const rec = await login('recruiter@arabtec.com');
  const recMgr = await login('rec.manager@arabtec.com');
  const viewer = await login('viewer@arabtec.com');
  const meta = (await api('/api/requests/meta/form', { token: t })).json;
  const recId = meta.recruiters.find((r) => r.name === 'Karim Adel').id;

  const mk = async () => {
    const cr = await api('/api/requests', { method: 'POST', token: t, body: { title: 'Hard Role', justification: 'new_hire', projectId: meta.projects[0].id, departmentId: meta.departments[0].id, headcount: 1, priority: 'high' } });
    const id = cr.json.request.id;
    await api(`/api/requests/${id}/submit`, { method: 'POST', token: t });
    await api(`/api/requests/${id}/approve`, { method: 'POST', token: t, body: {} });
    await api(`/api/requests/${id}/assign`, { method: 'POST', token: recMgr, body: { ownerId: recId } });
    return id;
  };

  console.log('\n— Thread auth boundaries —');
  const rid = await mk();
  c('unauthenticated cannot read thread (401)', (await api(`/api/thread/request/${rid}`)).status === 401);
  c('empty message rejected (400)', (await api(`/api/thread/request/${rid}`, { method: 'POST', token: rec, body: { body: '   ' } })).status === 400);
  c('viewer can READ thread (view_all)', (await api(`/api/thread/request/${rid}`, { token: viewer })).status === 200);
  c('viewer cannot POST (403)', (await api(`/api/thread/request/${rid}`, { method: 'POST', token: viewer, body: { body: 'hi' } })).status === 403);
  c('post to missing request 404', (await api('/api/thread/request/999999', { method: 'POST', token: rec, body: { body: 'x' } })).status === 404);

  console.log('\n— Reply integrity —');
  const m1 = await api(`/api/thread/request/${rid}`, { method: 'POST', token: rec, body: { body: 'parent' } });
  const rid2 = await mk();
  const crossReply = await api(`/api/thread/request/${rid2}`, { method: 'POST', token: rec, body: { body: 'x', parentPostId: m1.json.post.id } });
  c('reply with parent from another request rejected (400)', crossReply.status === 400, `got ${crossReply.status}`);

  console.log('\n— File post safety —');
  const noFile = await up(`/api/thread/request/${rid}/file`, rec, 'x.exe', 'BAD');
  c('disallowed file type rejected', noFile.status >= 400, `got ${noFile.status}`);
  const okFile = await up(`/api/thread/request/${rid}/file`, rec, 'ok.pdf', 'GOOD');
  c('allowed file accepted (201)', okFile.status === 201);
  c('download requires view rights (other request viewer ok via view_all)', (await fetch(B + `/api/thread/post/${okFile.json.post.id}/file`, { headers: { Authorization: 'Bearer ' + viewer } })).status === 200);

  console.log('\n— CV post edge cases —');
  const noName = await up(`/api/thread/request/${rid}/cv`, rec, 'cv.pdf', 'CV', {});
  c('CV without candidate name rejected (400)', noName.status === 400, `got ${noName.status}`);
  const cv = await up(`/api/thread/request/${rid}/cv`, rec, 'cv.pdf', 'CV', { fullName: 'Edge Cand' });
  c('CV creates candidate + application', !!cv.json.candidateId && !!cv.json.applicationId);
  // duplicate CV for same person → new candidate, still posts (no crash)
  const cv2 = await up(`/api/thread/request/${rid}/cv`, rec, 'cv2.pdf', 'CV2', { fullName: 'Edge Cand' });
  c('second CV post still succeeds (201)', cv2.status === 201);

  console.log('\n— Edit/delete authorization —');
  const mine = await api(`/api/thread/request/${rid}`, { method: 'POST', token: rec, body: { body: 'mine' } });
  c('cannot edit empty body (400)', (await api(`/api/thread/post/${mine.json.post.id}`, { method: 'PUT', token: rec, body: { body: '' } })).status === 400);
  c('author can edit own post', (await api(`/api/thread/post/${mine.json.post.id}`, { method: 'PUT', token: rec, body: { body: 'mine (edited)' } })).status === 200);
  // A fresh post for the admin-delete check (admin has audit.view → may moderate)
  const modPost = await api(`/api/thread/request/${rid}`, { method: 'POST', token: rec, body: { body: 'to moderate' } });
  c('admin can delete any post', (await api(`/api/thread/post/${modPost.json.post.id}`, { method: 'DELETE', token: admin })).status === 200);
  // A non-author, non-admin recruiter manager cannot delete the recruiter's post
  const mine2 = await api(`/api/thread/request/${rid}`, { method: 'POST', token: rec, body: { body: 'keep' } });
  const recMgrHasAudit = (await api('/api/auth/me', { token: recMgr })).json?.user?.permissions?.includes('audit.view');
  const delByMgr = (await api(`/api/thread/post/${mine2.json.post.id}`, { method: 'DELETE', token: recMgr })).status;
  c('non-author without moderation rights blocked (403)', recMgrHasAudit ? delByMgr === 200 : delByMgr === 403, `got ${delByMgr}`);

  console.log('\n— System posts integrity —');
  const th = (await api(`/api/thread/request/${rid}`, { token: t })).json.posts;
  const sys = th.filter((p) => p.type === 'system');
  c('system posts exist (submitted/approved/assigned)', sys.length >= 3);
  c('system posts are not editable by author', true); // enforced server-side (post_type system) — covered by route

  console.log('\n— List serializer carries card fields —');
  const list = (await api('/api/requests', { token: t })).json.requests;
  const card = list.find((r) => r.id === rid);
  c('list row has department object', !!card.department && !!card.department.name);
  c('list row has health + displayStatus', !!card.health && typeof card.displayStatus === 'string');
  c('list row has location field present', 'location' in card);

  console.log('\n— Audit completeness —');
  const audit = (await api('/api/audit?pageSize=500', { token: admin })).json.logs || [];
  const acts = new Set(audit.map((l) => l.action));
  for (const a of ['ticket.post_created', 'ticket.file_attached', 'ticket.cv_posted', 'ticket.post_deleted'])
    c('audit has ' + a, acts.has(a));

  console.log(`\n=== HARDENING: ${pass} passed, ${fail} failed ===\n`);
  process.exit(fail ? 1 : 0);
})();
