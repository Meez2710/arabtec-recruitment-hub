// Super-admin Control Center: buttons, logo, field visibility, custom fields.
process.env.DATABASE_URL = process.env.PG_ENGINE ? '' : 'file:/tmp/arabtec_aui.db';
process.env.PORT = process.env.PORT || '4360';
import fs from 'node:fs';
if (!process.env.PG_ENGINE) { for (const f of ['/tmp/arabtec_aui.db', '/tmp/arabtec_aui.db-journal']) { try { fs.rmSync(f); } catch {} } }
await import('./prisma/seed.js'); await import('./src/server.js');
await new Promise((r) => setTimeout(r, 1100));
const B = 'http://localhost:' + process.env.PORT;
let pass = 0, fail = 0; const c = (n, ok, x = '') => { console.log((ok ? '  ✅ ' : '  ❌ ') + n + ' ' + x); ok ? pass++ : fail++; };
const J = (p, b, t, m = 'POST') => fetch(B + p, { method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: b ? JSON.stringify(b) : undefined }).then(async (r) => ({ s: r.status, j: await r.json().catch(() => null) }));
const G = (p, t) => fetch(B + p, { headers: { Authorization: 'Bearer ' + t } }).then(async (r) => ({ s: r.status, j: await r.json().catch(() => null) }));
async function up(p, t, fn, content) { const fd = new FormData(); fd.append('file', new Blob([content], { type: 'image/png' }), fn); const r = await fetch(B + p, { method: 'POST', headers: { Authorization: 'Bearer ' + t }, body: fd }); return { s: r.status, j: await r.json().catch(() => null) }; }

(async () => {
  const admin = (await J('/api/auth/login', { email: 'admin@arabtec.com', password: 'Admin@12345' }, null)).j.token;
  const recruiter = (await J('/api/auth/login', { email: 'recruiter@arabtec.com', password: 'Arabtec@123' }, null)).j.token;

  console.log('\n— Buttons —');
  const btns = await G('/api/settings/buttons', admin);
  c('button list', btns.s === 200 && btns.j.buttons.length > 0);
  const aKey = btns.j.buttons[0].buttonKey;
  const upd = await J('/api/settings/buttons/' + aKey, { visible: false, label: 'Renamed' }, admin, 'PUT');
  c('toggle + rename button', upd.s === 200 && upd.j.button.visible === false && upd.j.button.label === 'Renamed');

  console.log('\n— Logo upload —');
  const logo = await up('/api/admin-ui/logo', admin, 'logo.png', 'PNG-LOGO-BYTES');
  c('logo upload (200)', logo.s === 200);
  const dl = await fetch(B + '/api/admin-ui/logo');
  c('logo served publicly', dl.status === 200);
  const brand = await G('/api/settings/branding', admin);
  c('branding records logo', !!brand.j.branding.logo_stored_name);

  console.log('\n— Built-in field visibility —');
  const cat = await G('/api/admin-ui/fields/request', admin);
  c('request field catalog', cat.s === 200 && cat.j.fields.some((f) => f.fieldKey === 'grade'));
  const hide = await J('/api/admin-ui/fields/request/grade', { visible: false, required: false }, admin, 'PUT');
  c('hide a request field', hide.s === 200 && hide.j.field.visible === false);
  const pub = await G('/api/admin-ui/field-config/request', admin);
  c('forms can read field overrides', pub.j.overrides.some((o) => o.fieldKey === 'grade' && o.visible === false));

  console.log('\n— Custom fields: candidate —');
  const cf1 = await J('/api/admin-ui/custom-fields/candidate', { label: 'Iqama Number', fieldType: 'text', required: true }, admin);
  c('create candidate custom field', cf1.s === 201);
  const candMeta = (await J('/api/auth/login', { email: 'admin@arabtec.com', password: 'Admin@12345' }, null)).j.token;
  const cand = await J('/api/candidates', { fullName: 'CF Cand', phone: '+9715' + Math.floor(Math.random() * 1e7), customFields: { iqama_number: 'ABC-123' } }, candMeta);
  c('candidate saves custom value', cand.s === 201);
  const cdet = await G('/api/candidates/' + cand.j.candidate.id, candMeta);
  c('candidate custom value reads back', cdet.j.candidate.customFields?.iqama_number === 'ABC-123');

  console.log('\n— Custom fields: request —');
  const cf2 = await J('/api/admin-ui/custom-fields/request', { label: 'Contract Type', fieldType: 'select', options: ['Permanent', 'Project'], required: false }, admin);
  c('create request custom field (select)', cf2.s === 201 && cf2.j.field.options.length === 2);
  const meta = (await G('/api/requests/meta/form', admin)).j;
  const cr = await J('/api/requests', { title: 'CF Req', justification: 'new_hire', projectId: meta.projects[0].id, departmentId: meta.departments[0].id, location: 'Dubai', hiringManagerId: meta.hiringManagers[0].id, headcount: 1, priority: 'high', keyResponsibilities: 'x', keyRequirements: 'y', customFields: { contract_type: 'Project' } }, admin);
  c('request saves custom value', cr.s === 201);
  const rdet = await G('/api/requests/' + cr.j.request.id, admin);
  c('request custom value reads back', rdet.j.request.customFields?.contract_type === 'Project');

  console.log('\n— Security: non-admin blocked —');
  const blocked = await J('/api/admin-ui/custom-fields/candidate', { label: 'Hack' }, recruiter);
  c('non-admin cannot create custom field (403)', blocked.s === 403);
  const blocked2 = await J('/api/admin-ui/fields/request/grade', { visible: true }, recruiter, 'PUT');
  c('non-admin cannot change field config (403)', blocked2.s === 403);

  console.log('\n— Delete custom field —');
  const del = await J('/api/admin-ui/custom-fields/candidate/iqama_number', null, admin, 'DELETE');
  c('delete custom field', del.s === 200);

  console.log(`\n=== ADMIN UI (${process.env.PG_ENGINE ? 'POSTGRES' : 'SQLITE'}): ${pass} passed, ${fail} failed ===\n`);
  process.exit(fail ? 1 : 0);
})();
