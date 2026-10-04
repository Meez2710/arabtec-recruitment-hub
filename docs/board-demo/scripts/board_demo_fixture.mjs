// BOARD DEMO fixture server: scratch DB + uploads, synthetic data only.
// Seeded demo users (backend/prisma/seed.js) + a small, clearly labelled
// background. The golden-path record itself is created later through the UI.
import fs from 'node:fs';
import path from 'node:path';
const REPO = '/Users/moutazadly/Documents/Codex/2026-10-01/referenced-chatgpt-conversation-this-is-an-3/work/repo/backend';
const HERE = path.dirname(new URL(import.meta.url).pathname);
// A NEW directory per run; nothing is deleted.
const DIR = path.join(HERE, process.env.DEMO_DB_DIR || ('board-demo-db-' + Date.now()));
if (fs.existsSync(DIR)) throw new Error('refusing to reuse ' + DIR);
fs.mkdirSync(DIR, { recursive: true });
console.log('DB_DIR ' + DIR);
Object.assign(process.env, {
  DATABASE_URL: 'file:' + path.join(DIR, 'board-demo.db'), UPLOAD_DIR: path.join(DIR, 'uploads'),
  PORT: process.env.PREVIEW_PORT || '4410', SEED_DEMO_DATA: 'true', SMTP_TRANSPORT: 'json', SEED_ADMIN_PASSWORD: 'Admin@12345',
});
process.chdir(REPO);
await import(REPO + '/prisma/seed.js');
await import(REPO + '/src/server.js');
const { waitForReady } = await import(REPO + '/test-support/wait-ready.mjs');
const B = 'http://localhost:' + process.env.PORT;
await waitForReady(B);
async function api(p, { method = 'GET', token, body } = {}) {
  const r = await fetch(B + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => null);
  if (r.status >= 400) throw new Error(`${method} ${p} → ${r.status} ${JSON.stringify(j)}`);
  return j;
}
const PW = process.env.DEMO_PW;
const login = async (e) => (await api('/api/auth/login', { method: 'POST', body: { email: e, password: PW } })).token;
const hrMgr = await login('hr.manager@arabtec.com'), hrDir = await login('hr.director@arabtec.com');
const recMgr = await login('rec.manager@arabtec.com'), recruiter = await login('recruiter@arabtec.com');
const meta = await api('/api/requests/meta/form', { token: hrMgr });
const dept = meta.departments.find((d) => d.name === 'Planning') || meta.departments[0];
const recId = meta.recruiters.find((r) => r.name === 'Karim Adel').id;

// Background: one open request with two candidates in its pipeline.
const bg = (await api('/api/requests', { method: 'POST', token: hrMgr, body: { title: 'Quantity Surveyor (BOARD DEMO)', justification: 'new_hire', projectId: meta.projects[0].id, departmentId: dept.id, location: 'New Capital', headcount: 2, priority: 'medium' } })).request;
await api(`/api/requests/${bg.id}/submit`, { method: 'POST', token: hrMgr });
await api(`/api/requests/${bg.id}/approve`, { method: 'POST', token: hrDir, body: {} });
await api(`/api/requests/${bg.id}/assign`, { method: 'POST', token: recMgr, body: { ownerId: recId } });
const people = [
  { fullName: 'Youssef Kamal (BOARD DEMO)', phone: '+201000009101', email: 'youssef.kamal.demo@example.com', currentPosition: 'Quantity Surveyor', yearsExperience: 6, university: 'Ain Shams University', major: 'Civil Engineering' },
  { fullName: 'Laila Mansour (BOARD DEMO)', phone: '+201000009102', email: 'laila.mansour.demo@example.com', currentPosition: 'Senior Quantity Surveyor', yearsExperience: 9, university: 'Cairo University', major: 'Civil Engineering' },
];
for (const p of people) {
  const cand = (await api('/api/candidates', { method: 'POST', token: hrMgr, body: p })).candidate;
  await api('/api/applications', { method: 'POST', token: recruiter, body: { candidateId: cand.id, requestId: bg.id, initialStatus: 'matched' } });
}
console.log(JSON.stringify({ ready: B, background: bg.ticketNo }));
