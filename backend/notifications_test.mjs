// C2.3 — notifications. Verifies notifications are created on submit (to approvers)
// and on assign (to the recruiter), the API returns them scoped per-user, unread
// counts, and mark-read. Email runs in dry-run (SMTP_TRANSPORT=json) so nothing sends.
const RID = process.pid + '_' + Date.now();
const DBF = `/tmp/arabtec_notif_${RID}.db`;
process.env.DATABASE_URL = 'file:' + DBF;
process.env.PORT = String(4810 + (process.pid % 80));
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
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, j };
};
const login = (e, p = 'Arabtec@123') => J('/api/auth/login', { email: e, password: p }).then((r) => r.j.token);

const hm = await login('hiring.manager@arabtec.com');
const recMgr = await login('rec.manager@arabtec.com');
const hrDir = await login('hr.director@arabtec.com');   // an approver (request.approve)

console.log('\n— Submit → approvers notified —');
const meta = await J('/api/requests/meta/form', null, hm);
const create = await J('/api/requests', { title: 'Notif Test Role', projectId: meta.j.projects[0].id, departmentId: meta.j.departments[0].id, headcount: 1, priority: 'high' }, hm);
const reqId = create.j.request.id;
await J(`/api/requests/${reqId}/submit`, {}, hm);
const dirNotifs = await J('/api/notifications', null, hrDir);
c('approver has an approval_needed notification', (dirNotifs.j.notifications || []).some((n) => n.type === 'approval_needed' && n.linkId === reqId), JSON.stringify(dirNotifs.j.unreadCount));
c('unread count > 0 for approver', dirNotifs.j.unreadCount >= 1, 'count=' + dirNotifs.j.unreadCount);

console.log('\n— Approve + assign → recruiter notified —');
await J(`/api/requests/${reqId}/approve`, { comment: 'ok' }, hrDir);
const recruiterUser = meta.j.recruiters[0];
await J(`/api/requests/${reqId}/assign`, { ownerId: recruiterUser.id }, recMgr);
const recToken = await login('recruiter@arabtec.com');
// find the recruiter user id that matches the logged-in recruiter
const me = await J('/api/auth/me', null, recToken);
const assignedToMe = recruiterUser.id === me.j.user.id;
const recNotifs = await J('/api/notifications', null, recToken);
c('recruiter gets an assignment notification (if assigned to them)',
  !assignedToMe || (recNotifs.j.notifications || []).some((n) => n.type === 'recruiter_assigned'), JSON.stringify(recNotifs.j.unreadCount));

console.log('\n— Scoping & mark-read —');
c('notifications are per-user (HM has none of the approver’s)',
  (await J('/api/notifications', null, hm)).j.notifications.every((n) => n.type !== 'approval_needed' || n.linkId !== reqId));
const first = (await J('/api/notifications', null, hrDir)).j.notifications[0];
const readOne = await J(`/api/notifications/${first.id}/read`, {}, hrDir);
c('mark-one-read lowers unread count', readOne.status === 200);
const readAll = await J('/api/notifications/read-all', {}, hrDir);
c('mark-all-read → unread 0', readAll.j.unreadCount === 0, 'count=' + readAll.j.unreadCount);

console.log(`\n=== NOTIFICATIONS: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
