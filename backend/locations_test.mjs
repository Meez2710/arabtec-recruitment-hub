// Hiring locations (recruitment team, 25 Oct 2026): a request is for the Head
// Office or for a site; sites carry the area they are in; the recruitment team
// keeps areas and sites current under its own permission. Disposable SQLite DB.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'arabtec-locations-'));
process.env.DATABASE_URL = 'file:' + path.join(TMP, 'loc.db');
process.env.UPLOAD_DIR = path.join(TMP, 'uploads');
process.env.PORT = process.env.LOCATIONS_TEST_PORT || '4642';
process.env.SEED_DEMO_DATA = 'true';
process.env.SMTP_TRANSPORT = 'json';
process.env.SEED_ADMIN_PASSWORD ||= 'Locations#2026x';
await import('./prisma/seed.js');
await import('./src/server.js');
const { waitForReady } = await import('./test-support/wait-ready.mjs');
const db = await import('./src/lib/db.js');
const B = 'http://localhost:' + process.env.PORT;
await waitForReady(B);

let pass = 0, fail = 0;
const c = (n, ok, x = '') => { console.log((ok ? '  ✅ ' : '  ❌ ') + n + (ok ? '' : ' ' + x)); ok ? pass++ : fail++; };
async function api(p, { method = 'GET', token, body } = {}) {
  const r = await fetch(B + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}
const login = async (e) => (await api('/api/auth/login', { method: 'POST', body: { email: e, password: 'Arabtec@123' } })).json.token;

try {
  db.run('UPDATE users SET must_change_password=0');
  // Production shape: projects whose `location` is the old city text.
  // (The Head Office row already exists — the server creates it at start-up.)
  db.run("UPDATE project SET location='Cairo' WHERE id=(SELECT MIN(id) FROM project WHERE code<>'HEAD-OFFICE')");
  db.run("UPDATE project SET location='Ras El Hikma' WHERE id=(SELECT MAX(id) FROM project WHERE code<>'HEAD-OFFICE')");
  const rec = await login('recruiter@arabtec.com'), hm = await login('hiring.manager@arabtec.com');

  // 1. Reading the list creates the Head Office once and normalises legacy areas.
  const l1 = await api('/api/org/locations', { token: rec });
  c('recruiter reads the locations list', l1.status === 200, l1.text.slice(0, 200));
  c('default areas are Cairo Area and North Coast Area', JSON.stringify(l1.json.areas) === JSON.stringify(['Cairo Area', 'North Coast Area']), JSON.stringify(l1.json.areas));
  c('Head Office exists as its own row', l1.json.headOffice && l1.json.headOffice.name === 'Head Office' && l1.json.headOffice.isHeadOffice === true);
  c('…created at start-up, before anyone opened a form', db.get("SELECT created_at FROM project WHERE code='HEAD-OFFICE'") != null);
  c('Head Office is not in the Sites list', !l1.json.sites.some((s) => s.isHeadOffice));
  c("legacy 'Cairo' became 'Cairo Area' and 'Ras El Hikma' became 'North Coast Area'", l1.json.sites.some((s) => s.area === 'Cairo Area') && l1.json.sites.some((s) => s.area === 'North Coast Area'), JSON.stringify(l1.json.sites.map((s) => s.area)));
  c('sites are alphabetical', l1.json.sites.every((s, i) => i === 0 || l1.json.sites[i - 1].name.localeCompare(s.name, undefined, { sensitivity: 'base' }) <= 0));
  const hoCount = () => db.get("SELECT COUNT(*) AS n FROM project WHERE code='HEAD-OFFICE'").n;
  await api('/api/org/locations', { token: rec });
  c('a second read does not create a second Head Office', hoCount() === 1);

  // 2. The request form metadata carries the same model.
  const m = await api('/api/requests/meta/form', { token: rec });
  c('form meta names the Head Office project', m.json.headOfficeProjectId === l1.json.headOffice.id, JSON.stringify(m.json.headOfficeProjectId));
  c('form meta projects carry area, status and the Head Office flag', m.json.projects.every((p) => 'area' in p && 'status' in p && 'isHeadOffice' in p));
  c('form meta carries the area list', JSON.stringify(m.json.areas) === JSON.stringify(l1.json.areas));

  // 3. Recruitment edits; a hiring manager cannot.
  const a1 = await api('/api/org/locations/areas', { method: 'PUT', token: rec, body: { areas: ['Cairo Area', 'North Coast Area', ' Upper Egypt Area ', 'cairo area'] } });
  c('recruiter adds an area (trimmed, de-duplicated case-insensitively)', a1.status === 200 && JSON.stringify(a1.json.areas) === JSON.stringify(['Cairo Area', 'North Coast Area', 'Upper Egypt Area']), a1.text.slice(0, 200));
  const a0 = await api('/api/org/locations/areas', { method: 'PUT', token: rec, body: { areas: [] } });
  c('an empty area list is refused', a0.status === 400);
  const s1 = await api('/api/org/locations/sites', { method: 'POST', token: rec, body: { name: 'Zed Towers', area: 'Upper Egypt Area' } });
  c('recruiter adds a site with its area', s1.status === 201 && s1.json.site.name === 'Zed Towers' && s1.json.site.area === 'Upper Egypt Area' && /^PRJ-/.test(s1.json.site.code), s1.text.slice(0, 200));
  const dup = await api('/api/org/locations/sites', { method: 'POST', token: rec, body: { name: 'zed towers', area: 'Cairo Area' } });
  c('a duplicate site name is refused', dup.status === 409, dup.text);
  const noArea = await api('/api/org/locations/sites', { method: 'POST', token: rec, body: { name: 'No Area Site' } });
  c('a site needs an area', noArea.status === 400);
  const u1 = await api(`/api/org/locations/sites/${s1.json.site.id}`, { method: 'PUT', token: rec, body: { area: 'Cairo Area', status: 'on_hold' } });
  c('recruiter moves a site to another area and puts it on hold', u1.status === 200 && u1.json.site.area === 'Cairo Area' && u1.json.site.status === 'on_hold', u1.text.slice(0, 200));
  const ho = await api(`/api/org/locations/sites/${l1.json.headOffice.id}`, { method: 'PUT', token: rec, body: { name: 'HQ' } });
  c('the Head Office cannot be renamed', ho.status === 400, ho.text);
  const hoArea = await api(`/api/org/locations/sites/${l1.json.headOffice.id}`, { method: 'PUT', token: rec, body: { area: 'Cairo Area' } });
  c('…but its area can be set', hoArea.status === 200 && hoArea.json.headOffice.area === 'Cairo Area');
  const f1 = await api('/api/org/locations/areas', { method: 'PUT', token: hm, body: { areas: ['X'] } });
  const f2 = await api('/api/org/locations/sites', { method: 'POST', token: hm, body: { name: 'Nope', area: 'Cairo Area' } });
  c('a hiring manager can read but not edit locations', f1.status === 403 && f2.status === 403, `${f1.status} ${f2.status}`);
  c('the edits are audited', db.get("SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'location.%'").n >= 3);

  // 4. Requests take their location from the place they are for.
  const dept = db.get('SELECT id FROM department LIMIT 1').id;
  const site = l1.json.sites.find((s) => s.area === 'North Coast Area');
  const r1 = await api('/api/requests', { method: 'POST', token: rec, body: { title: 'Site Engineer', projectId: site.id, departmentId: dept } });
  c('a request for a site records the site area as its location', r1.status === 201 && r1.json.request.location === 'North Coast Area', r1.text.slice(0, 300));
  c('…and prints as "<site> · <area>"', r1.json.request.place === `${site.name} · North Coast Area` && r1.json.request.project.area === 'North Coast Area', JSON.stringify({ place: r1.json.request.place, project: r1.json.request.project, site }));
  const r2 = await api('/api/requests', { method: 'POST', token: rec, body: { title: 'Receptionist', projectId: l1.json.headOffice.id, departmentId: dept } });
  c('a request for the Head Office prints as "Head Office"', r2.status === 201 && r2.json.request.location === 'Head Office' && r2.json.request.place === 'Head Office' && r2.json.request.project.isHeadOffice === true, JSON.stringify({ location: r2.json.request.location, place: r2.json.request.place, project: r2.json.request.project }));
  const moved = await api(`/api/requests/${r2.json.request.id}`, { method: 'PUT', token: rec, body: { projectId: site.id } });
  c('moving a request to a site updates its location', moved.status === 200 && moved.json.request.location === 'North Coast Area', moved.text.slice(0, 300));
  const same = await api(`/api/requests/${moved.json.request.id}`, { method: 'PUT', token: rec, body: { title: 'Receptionist II' } });
  c('an edit that leaves the site alone keeps the location', same.status === 200 && same.json.request.location === 'North Coast Area', same.text.slice(0, 200));
} catch (e) { c('suite ran without throwing', false, e.stack || e.message); }
console.log(`\n=== LOCATIONS: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
