// Organization Structure v2 (backend) tests.
// Own process, throwaway SQLite DB, in-process server. Invented names only.

process.env.DATABASE_URL = 'file:/tmp/arabtec_org_chart_v2.db';
process.env.PORT = '4199';
process.env.NODE_ENV = 'test';
process.env.SEED_DEMO_DATA = 'true';
process.env.SEED_ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD || 'Admin@12345';
process.env.RATE_LIMIT_DISABLED = 'true';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'org-chart-v2-test-secret-value';
delete process.env.DOCLING_BASE_URL;
delete process.env.OCR_BASE_URL;

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { adminToken } from './test-support/admin-session.mjs';

const DB = '/tmp/arabtec_org_chart_v2.db';
for (const f of [DB, `${DB}-journal`, `${DB}-wal`, `${DB}-shm`]) {
  try { fs.rmSync(f); } catch { /* first run */ }
}

let passed = 0;
const failures = [];
const check = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  PASS  ${name}`); }
  catch (e) { failures.push(name); console.log(`  FAIL  ${name}\n        ${e.message}`); }
};

await import('./src/server.js');
const { all, get } = await import('./src/lib/db.js');
const { migrateOrganizationNodesToCharts } = await import('./src/lib/org-chart-v2-migrate.js');
const Charts = await import('./src/lib/org-charts.js');

const BASE = `http://127.0.0.1:${process.env.PORT}`;
const admin = await adminToken(BASE);

const raw = async (path, { method = 'GET', tok = admin, body } = {}) => {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, json, text };
};
const api = raw;
const login = async (email) => {
  const res = await raw('/api/auth/login', { method: 'POST', tok: null, body: { email, password: 'Arabtec@123' } });
  assert.equal(res.status, 200, `${email} login failed: HTTP ${res.status}`);
  return res.json.token;
};
const viewer = await login('viewer@arabtec.com');
const recruiter = await login('recruiter@arabtec.com');
const manager = await login('hr.manager@arabtec.com');
const director = await login('hr.director@arabtec.com');

/* ------------------------------- flag off ---------------------------------- */

const legacyBefore = await raw('/api/org/chart');
await check('flag off: new routes return 404 for read and write', async () => {
  for (const [method, path] of [['GET', '/api/org/charts'], ['POST', '/api/org/charts'], ['GET', '/api/org/charts/1'], ['PUT', '/api/org/charts/versions/1']]) {
    const r = await raw(path, { method, body: method === 'GET' ? undefined : {} });
    assert.equal(r.status, 404, `${method} ${path} gave HTTP ${r.status}`);
  }
});
await check('flag off: org_chart_v2 is listed and disabled by default', async () => {
  const f = await raw('/api/settings/features');
  const flag = f.json.features.find((x) => x.key === 'org_chart_v2');
  assert.ok(flag, 'flag missing');
  assert.equal(flag.enabled, false);
});

// Legacy tree: a project with a manager, three site engineers (one vacant), a QA team and a duplicated name.
const mk = async (b) => (await raw('/api/org/chart/nodes', { method: 'POST', body: b })).json.node;
const root = await mk({ positionTitle: 'Harbor Tower', nodeType: 'project', projectOrLocation: 'Harbor Tower' });
const pm = await mk({ employeeName: 'Lina Marwan', positionTitle: 'Project Manager', parentId: root.id, nodeType: 'employee_position' });
await mk({ employeeName: 'Omar Nassar', positionTitle: 'Site Engineer', department: 'Construction', parentId: pm.id });
await mk({ employeeName: 'Dina Yassin', positionTitle: 'Site Engineer', department: 'Construction', parentId: pm.id });
await mk({ positionTitle: 'Site Engineer', department: 'Construction', parentId: pm.id, nodeType: 'vacant_position', status: 'vacant' });
const qa = await mk({ positionTitle: 'QA/QC Team', nodeType: 'organizational_unit', parentId: pm.id });
await mk({ employeeName: 'Hadi Sabry', positionTitle: 'QA Engineer', parentId: qa.id });
await mk({ employeeName: 'Hadi Sabry', positionTitle: 'QA Engineer', parentId: root.id });

await check('flag off: legacy /api/org/chart still works', async () => {
  assert.equal(legacyBefore.status, 200);
  const r = await raw('/api/org/chart');
  assert.equal(r.status, 200);
  assert.ok(r.json.nodes.length > legacyBefore.json.nodes.length);
});

/* ------------------------------ flag on + migration ------------------------- */

const legacyNodesText = JSON.stringify(all('SELECT * FROM organization_node ORDER BY id'));
const flagOn = await raw('/api/settings/features/org_chart_v2', { method: 'PUT', body: { enabled: true } });
await check('admin can switch org_chart_v2 on', async () => {
  assert.equal(flagOn.status, 200);
  assert.equal(flagOn.json.enabled, true);
});
await check('flag on does not change the legacy /api/org/chart response or organization_node', async () => {
  const r = await raw('/api/org/chart');
  assert.equal(r.status, 200);
  assert.equal(r.json.nodes.length, JSON.parse(legacyNodesText).length);
  assert.equal(JSON.stringify(all('SELECT * FROM organization_node ORDER BY id')), legacyNodesText);
});

const nodes = all('SELECT * FROM organization_node');
const unitTypes = ['department', 'project', 'organizational_unit'];
const isPerson = (n) => (n.employee_name || '').trim() || !unitTypes.includes(n.node_type);
const expectedNamed = nodes.filter((n) => (n.employee_name || '').trim()).map((n) => n.employee_name.trim()).sort();
const expectedSeats = nodes.filter(isPerson).length;
const expectedRoots = nodes.filter((n) => n.parent_id == null).length;

const mig = migrateOrganizationNodesToCharts();
await check('migration creates one chart per root tree', async () => {
  assert.equal(mig.migrated, true);
  assert.equal(all('SELECT id FROM org_chart').length, expectedRoots);
  assert.equal(all("SELECT id FROM org_chart_version WHERE state='published'").length, expectedRoots);
});
await check('migration preserves every named person and every seat', async () => {
  const names = all('SELECT person_name FROM org_assignment').map((r) => r.person_name).sort();
  assert.deepEqual(names, expectedNamed);
  assert.equal(all('SELECT id FROM org_position WHERE closed_in_version_id IS NULL').length, expectedSeats);
});
await check('migration groups people into role boxes and keeps vacant seats', async () => {
  const chart = all('SELECT * FROM org_chart WHERE name=?', ['Harbor Tower'])[0];
  assert.ok(chart, 'Harbor Tower chart missing');
  const v = Charts.getVersion(chart.current_version_id);
  const boxes = Charts.allBoxes(v.payload);
  const eng = boxes.find((b) => b.title === 'Site Engineer');
  assert.equal(eng.kind, 'role');
  assert.equal(eng.planned, 3, 'two named + one vacant');
  assert.equal(all('SELECT id FROM org_assignment WHERE chart_id=? AND box_key=?', [chart.id, eng.key]).length, 2);
  assert.equal(boxes.find((b) => b.title === 'QA/QC Team').kind, 'team');
  assert.equal(boxes.find((b) => b.title === 'Project Manager').parentKey, boxes.find((b) => b.title === 'Harbor Tower').key);
  assert.ok(boxes.every((b) => b.w === 81 && Number.isFinite(b.x) && Number.isFinite(b.y)));
});
await check('migration gives a repeated legacy name share 1 on each row (names are not identities)', async () => {
  const rows = all("SELECT share FROM org_assignment WHERE person_name='Hadi Sabry'");
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.share === 1));
});
await check('migration is idempotent and never touches organization_node', async () => {
  const again = migrateOrganizationNodesToCharts();
  assert.equal(again.migrated, false);
  assert.equal(all('SELECT id FROM org_chart').length, expectedRoots);
  assert.equal(JSON.stringify(all('SELECT * FROM organization_node ORDER BY id')), legacyNodesText);
});

/* ------------------------------ permissions --------------------------------- */

const P = (title, extra = {}) => ({ kind: 'role', title, planned: 1, x: 0, y: 0, w: 81, ...extra });
const basePayload = () => ({
  pages: [{
    key: 'p1', name: 'Page 1', title1: 'Test Plaza', title2: 'Site chart', date: '2026-10-11', paper: 'A3',
    boxes: [
      P('Test Plaza', { key: 'root', kind: 'team', planned: 0 }),
      P('Project Manager', { key: 'pm', parentKey: 'root', x: 100, y: 100 }),
      P('Site Engineer', { key: 'eng', parentKey: 'pm', planned: 2, x: 100, y: 200 }),
      P('QA Engineer', { key: 'qa', parentKey: 'pm', planned: 1, x: 200, y: 200 }),
      P('Planner', { key: 'plan', parentKey: 'eng', planned: 1, x: 100, y: 300 }),
    ],
    links: [{ childKey: 'pm', kind: 'reports', fromSide: 'bottom', toSide: 'top' }],
    notes: [],
  }],
});

await check('viewer can read but not write', async () => {
  const list = await api('/api/org/charts', { tok: viewer });
  assert.equal(list.status, 200);
  assert.equal(list.json.canManage, false);
  assert.ok(list.json.charts.length >= expectedRoots);
  const w = await api('/api/org/charts', { method: 'POST', tok: viewer, body: { name: 'Nope' } });
  assert.equal(w.status, 403);
});
await check('recruiter is denied writes', async () => {
  const w = await api('/api/org/charts', { method: 'POST', tok: recruiter, body: { name: 'Nope' } });
  assert.equal(w.status, 403);
  assert.ok((w.json.requiredPermissions || []).includes('org_chart.manage'));
});
await check('unauthenticated requests are rejected', async () => {
  assert.equal((await api('/api/org/charts', { tok: null })).status, 401);
});

const created = await api('/api/org/charts', { method: 'POST', tok: manager, body: { name: 'Test Plaza', payload: basePayload() } });
const cid = created.json?.chart?.id;
const v1 = created.json?.version;
await check('manager can create a chart (published version 1, seats created)', async () => {
  assert.equal(created.status, 201, created.text);
  assert.equal(v1.state, 'published');
  assert.equal(created.json.chart.currentVersionId, v1.id);
  const d = await api(`/api/org/charts/${cid}`, { tok: viewer });
  assert.equal(d.status, 200);
  assert.equal(d.json.positions.length, 5);
  assert.equal(d.json.version.payload.pages[0].boxes.length, 5);
});
await check('bad ids and unknown charts give plain errors', async () => {
  assert.equal((await api('/api/org/charts/abc')).status, 400);
  assert.equal((await api('/api/org/charts/999999')).status, 404);
  assert.equal((await api('/api/org/charts/versions/999999')).status, 404);
  assert.equal((await api('/api/org/charts', { method: 'POST', body: { name: '  ' } })).status, 400);
});

/* ---------------------------- live edits on published ------------------------ */

let live = (await api(`/api/org/charts/versions/${v1.id}`)).json.version;
await check('live edit of title, width and position on the published version is allowed and audited', async () => {
  const p = structuredClone(live.payload);
  const eng = p.pages[0].boxes.find((b) => b.key === 'eng');
  Object.assign(eng, { title: 'Senior Site Engineer', w: 100, x: 140 });
  p.pages[0].links[0].points = [{ x: 1, y: 2 }];
  const r = await api(`/api/org/charts/versions/${v1.id}`, { method: 'PUT', tok: manager, body: { payload: p, updatedAt: live.updatedAt } });
  assert.equal(r.status, 200, r.text);
  live = r.json.version;
  assert.equal(live.state, 'published');
  const a = get("SELECT * FROM audit_log WHERE action='org_chart_v2.live_edit' AND entity_id=?", [String(v1.id)]);
  assert.ok(a && a.old_value && a.new_value, 'audit row with before/after');
});
await check('structural edits on the published version return 409 "restructure draft"', async () => {
  const cases = {
    addBox: (p) => p.pages[0].boxes.push(P('Extra', { key: 'extra', parentKey: 'pm' })),
    removeBox: (p) => { p.pages[0].boxes = p.pages[0].boxes.filter((b) => b.key !== 'plan'); },
    reparent: (p) => { p.pages[0].boxes.find((b) => b.key === 'qa').parentKey = 'root'; },
    planned: (p) => { p.pages[0].boxes.find((b) => b.key === 'eng').planned = 5; },
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const p = structuredClone(live.payload);
    mutate(p);
    const r = await api(`/api/org/charts/versions/${v1.id}`, { method: 'PUT', tok: manager, body: { payload: p, updatedAt: live.updatedAt } });
    assert.equal(r.status, 409, `${name}: HTTP ${r.status}`);
    assert.match(r.json.error, /restructure draft/i);
  }
  const unchanged = (await api(`/api/org/charts/versions/${v1.id}`)).json.version;
  assert.equal(unchanged.updatedAt, live.updatedAt, 'nothing was written');
});
await check('stale updatedAt gives 409 (optimistic concurrency)', async () => {
  const stale = live.updatedAt;
  const p = structuredClone(live.payload);
  p.pages[0].boxes[1].title = 'Project Director';
  const ok = await api(`/api/org/charts/versions/${v1.id}`, { method: 'PUT', tok: manager, body: { payload: p, updatedAt: stale } });
  assert.equal(ok.status, 200);
  live = ok.json.version;
  assert.notEqual(live.updatedAt, stale);
  const clash = await api(`/api/org/charts/versions/${v1.id}`, { method: 'PUT', tok: manager, body: { payload: p, updatedAt: stale } });
  assert.equal(clash.status, 409);
  assert.equal((await api(`/api/org/charts/versions/${v1.id}`, { method: 'PUT', tok: manager, body: { payload: p } })).status, 400);
});
await check('recruiter and viewer cannot live-edit', async () => {
  for (const tok of [recruiter, viewer]) {
    const r = await api(`/api/org/charts/versions/${v1.id}`, { method: 'PUT', tok, body: { payload: live.payload, updatedAt: live.updatedAt } });
    assert.equal(r.status, 403);
  }
});

/* -------------------------------- assignments -------------------------------- */

let asg;
await check('assignment create takes a free seat; joining + date + suffix + move between boxes', async () => {
  const r = await api(`/api/org/charts/${cid}/assignments`, { method: 'POST', tok: manager, body: { boxKey: 'eng', personName: ' Karim Zaki ', status: 'joining', effectiveDate: '2026-10-30', suffix: 'Sr.' } });
  assert.equal(r.status, 201, r.text);
  asg = r.json.assignment;
  assert.equal(asg.personName, 'Karim Zaki');
  assert.equal(asg.status, 'joining');
  assert.equal(asg.effectiveDate, '2026-10-30');
  assert.ok(asg.positionId, 'seat assigned');
  const m = await api(`/api/org/charts/${cid}/assignments/${asg.id}`, { method: 'PUT', tok: manager, body: { boxKey: 'qa', sortOrder: 3, status: 'in_post' } });
  assert.equal(m.status, 200, m.text);
  assert.equal(m.json.assignment.boxKey, 'qa');
  assert.equal(get('SELECT box_key FROM org_position WHERE id=?', [m.json.assignment.positionId]).box_key, 'qa');
  assert.ok(get("SELECT id FROM audit_log WHERE action='org_chart_v2.assignment_updated'"));
});
await check('assignment validation: bad status, bad date, unknown box, recruiter denied', async () => {
  const post = (body, tok = manager) => api(`/api/org/charts/${cid}/assignments`, { method: 'POST', tok, body });
  assert.equal((await post({ boxKey: 'eng', personName: 'A B', status: 'gone' })).status, 400);
  assert.equal((await post({ boxKey: 'eng', personName: 'A B', effectiveDate: '30/10' })).status, 400);
  assert.equal((await post({ boxKey: 'nope', personName: 'A B' })).status, 400);
  assert.equal((await post({ boxKey: 'eng', personName: '' })).status, 400);
  assert.equal((await post({ boxKey: 'eng', personName: 'A B' }, recruiter)).status, 403);
});
await check('shares are enforced per employee_id only; same-name people are never blocked but are flagged', async () => {
  const other = await api('/api/org/charts', { method: 'POST', body: { name: 'Second Site', payload: { pages: [{ key: 'p1', boxes: [P('Engineer', { key: 'e1' })] }] } } });
  assert.equal(other.status, 201, other.text);
  const first = await api(`/api/org/charts/${cid}/assignments`, { method: 'POST', body: { boxKey: 'eng', personName: 'Rana Fouad', share: 0.5 } });
  assert.equal(first.status, 201);
  const second = await api(`/api/org/charts/${other.json.chart.id}/assignments`, { method: 'POST', body: { boxKey: 'e1', personName: '  RANA   fouad ', share: 1 } });
  assert.equal(second.status, 201, second.text);
  const third = await api(`/api/org/charts/${cid}/assignments`, { method: 'POST', body: { boxKey: 'eng', personName: 'rana Fouad', share: 1 } });
  assert.equal(third.status, 201, third.text);
  const raise = await api(`/api/org/charts/${cid}/assignments/${first.json.assignment.id}`, { method: 'PUT', body: { share: 1 } });
  assert.equal(raise.status, 200, raise.text);
  const dup = (await api(`/api/org/charts/${other.json.chart.id}`)).json.possibleDuplicates.find((g) => g.personName.toLowerCase().includes('rana'));
  assert.ok(dup, 'flagged');
  assert.equal(dup.occurrences.length, 3);
  assert.deepEqual(Object.keys(dup.occurrences[0]).sort(), ['boxKey', 'boxTitle', 'chartId', 'chartName']);
  assert.equal((await api(`/api/org/charts/${cid}/assignments`, { method: 'POST', body: { boxKey: 'eng', personName: 'Zed', share: 1.5 } })).status, 400);
  const byId = await api(`/api/org/charts/${cid}/assignments`, { method: 'POST', body: { boxKey: 'eng', personName: 'Rana Fouad', employeeId: 77, share: 1 } });
  assert.equal(byId.status, 201);
  const byId2 = await api(`/api/org/charts/${cid}/assignments`, { method: 'POST', body: { boxKey: 'eng', personName: 'Someone Else', employeeId: 77, share: 0.2 } });
  assert.equal(byId2.status, 409);
  assert.match(byId2.json.error, /100% at most/);
});
await check('assignment delete works and is audited', async () => {
  const r = await api(`/api/org/charts/${cid}/assignments/${asg.id}`, { method: 'DELETE', tok: manager });
  assert.equal(r.status, 200);
  assert.equal((await api(`/api/org/charts/${cid}/assignments/${asg.id}`, { method: 'DELETE', tok: manager })).status, 404);
  assert.ok(get("SELECT id FROM audit_log WHERE action='org_chart_v2.assignment_deleted'"));
});

/* ------------------------- draft -> submit -> approve -> publish -------------- */

const draftRes = await api(`/api/org/charts/${cid}/drafts`, { method: 'POST', tok: manager, body: { label: 'Option A' } });
let draft = draftRes.json?.version;
await check('manager can start a restructure draft copied from the published version', async () => {
  assert.equal(draftRes.status, 201, draftRes.text);
  assert.equal(draft.state, 'draft');
  assert.equal(draft.basedOnVersionId, live.id);
  assert.deepEqual(draft.payload, (await api(`/api/org/charts/versions/${live.id}`)).json.version.payload);
  assert.equal((await api(`/api/org/charts/${cid}/drafts`, { method: 'POST', tok: recruiter, body: {} })).status, 403);
});
await check('draft accepts structural change; a reporting cycle is rejected', async () => {
  const p = structuredClone(draft.payload);
  p.pages[0].boxes.find((b) => b.key === 'pm').parentKey = 'plan'; // plan is below pm: cycle
  const bad = await api(`/api/org/charts/versions/${draft.id}`, { method: 'PUT', tok: manager, body: { payload: p, updatedAt: draft.updatedAt } });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /cycle/i);
  const self = structuredClone(draft.payload);
  self.pages[0].boxes.find((b) => b.key === 'qa').parentKey = 'qa';
  assert.equal((await api(`/api/org/charts/versions/${draft.id}`, { method: 'PUT', tok: manager, body: { payload: self, updatedAt: draft.updatedAt } })).status, 400);
  const dup = structuredClone(draft.payload);
  dup.pages[0].boxes.push(P('Dup', { key: 'qa' }));
  assert.equal((await api(`/api/org/charts/versions/${draft.id}`, { method: 'PUT', tok: manager, body: { payload: dup, updatedAt: draft.updatedAt } })).status, 400);
  const arr = structuredClone(draft.payload);
  arr.pages[0].boxes.find((b) => b.key === 'qa').arrange = 'diagonal';
  assert.equal((await api(`/api/org/charts/versions/${draft.id}`, { method: 'PUT', tok: manager, body: { payload: arr, updatedAt: draft.updatedAt } })).status, 400);
});
await check('draft: insert manager above two boxes, add seats; draft save respects updatedAt', async () => {
  const p = structuredClone(draft.payload);
  const bx = p.pages[0].boxes;
  bx.push(P('Delivery Lead', { key: 'lead', parentKey: 'pm', x: 150, y: 150, arrange: 'col-left' }));
  bx.find((b) => b.key === 'eng').parentKey = 'lead';
  bx.find((b) => b.key === 'qa').parentKey = 'lead';
  bx.find((b) => b.key === 'qa').planned = 2;
  bx.find((b) => b.key === 'qa').proposed = 1;
  const r = await api(`/api/org/charts/versions/${draft.id}`, { method: 'PUT', tok: manager, body: { payload: p, updatedAt: draft.updatedAt } });
  assert.equal(r.status, 200, r.text);
  const stale = await api(`/api/org/charts/versions/${draft.id}`, { method: 'PUT', tok: manager, body: { payload: p, updatedAt: draft.updatedAt } });
  assert.equal(stale.status, 409);
  draft = r.json.version;
});
await check('the published chart is untouched by draft edits', async () => {
  const d = await api(`/api/org/charts/${cid}`);
  assert.equal(d.json.version.id, live.id);
  assert.equal(d.json.version.payload.pages[0].boxes.length, 5);
});
await check('diff reports boxes moved/added, seats and layers on a known change', async () => {
  const r = await api(`/api/org/charts/${cid}/diff?a=${live.id}&b=${draft.id}`);
  assert.equal(r.status, 200, r.text);
  const d = r.json.diff;
  assert.deepEqual(d.boxesAdded.map((b) => b.key), ['lead']);
  assert.deepEqual(d.boxesRemoved, []);
  assert.deepEqual(d.boxesMoved.map((b) => b.key).sort(), ['eng', 'qa']);
  assert.deepEqual(d.boxesRenamed, []);
  assert.deepEqual(d.seatsDelta, { approved: 1 + 1, proposed: 1 });
  assert.equal(d.layersBefore, 4);
  assert.equal(d.layersAfter, 5);
  assert.equal(d.widestSpanBefore, 2);
  assert.equal(d.widestSpanAfter, 2);
  assert.equal((await api(`/api/org/charts/${cid}/diff?a=${live.id}`)).status, 400);
  assert.equal((await api(`/api/org/charts/${cid}/diff?a=${live.id}&b=999999`)).status, 404);
});
await check('publish before approval is refused; submit moves draft to pending_approval', async () => {
  assert.equal((await api(`/api/org/charts/versions/${draft.id}/publish`, { method: 'POST', tok: manager })).status, 409);
  assert.equal((await api(`/api/org/charts/versions/${draft.id}/approve`, { method: 'POST', tok: director })).status, 409, 'a draft must be submitted first');
  const s = await api(`/api/org/charts/versions/${draft.id}/submit`, { method: 'POST', tok: manager });
  assert.equal(s.status, 200, s.text);
  assert.equal(s.json.version.state, 'pending_approval');
  assert.equal(s.json.version.submittedBy, (await api('/api/auth/me', { tok: manager })).json.user.id);
  assert.equal((await api(`/api/org/charts/versions/${draft.id}/submit`, { method: 'POST', tok: manager })).status, 409);
  const edit = await api(`/api/org/charts/versions/${draft.id}`, { method: 'PUT', tok: manager, body: { payload: draft.payload, updatedAt: draft.updatedAt } });
  assert.equal(edit.status, 409, 'pending drafts cannot be edited');
  assert.equal((await api(`/api/org/charts/versions/${draft.id}/publish`, { method: 'POST', tok: manager })).status, 409, 'submitted but not approved');
});
await check('only the HR Director approves or rejects', async () => {
  for (const [name, tok] of [['hr manager', manager], ['recruiter', recruiter], ['viewer', viewer], ['system admin', admin]]) {
    const r = await api(`/api/org/charts/versions/${draft.id}/approve`, { method: 'POST', tok });
    assert.ok([403].includes(r.status), `${name} got HTTP ${r.status}`);
    const j = await api(`/api/org/charts/versions/${draft.id}/reject`, { method: 'POST', tok });
    assert.equal(j.status, 403, `${name} reject got HTTP ${j.status}`);
  }
  assert.equal((await api(`/api/org/charts/versions/${draft.id}`)).json.version.state, 'pending_approval');
});
await check('reject returns the draft to its editors; resubmit works', async () => {
  const r = await api(`/api/org/charts/versions/${draft.id}/reject`, { method: 'POST', tok: director, body: { comment: 'Needs seat justification' } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.version.state, 'draft');
  assert.equal(r.json.version.approvedBy, null);
  assert.equal((await api(`/api/org/charts/versions/${draft.id}/submit`, { method: 'POST', tok: manager })).status, 200);
});
await check('HR Director approves; manager publishes; previous version is superseded', async () => {
  const a = await api(`/api/org/charts/versions/${draft.id}/approve`, { method: 'POST', tok: director });
  assert.equal(a.status, 200, a.text);
  assert.ok(a.json.version.approvedBy);
  assert.equal(a.json.version.state, 'pending_approval');
  const p = await api(`/api/org/charts/versions/${draft.id}/publish`, { method: 'POST', tok: manager });
  assert.equal(p.status, 200, p.text);
  assert.equal(p.json.version.state, 'published');
  assert.ok(p.json.version.publishedAt);
  assert.equal(p.json.supersededVersionId, live.id);
  assert.equal((await api(`/api/org/charts/versions/${live.id}`)).json.version.state, 'superseded');
  const d = await api(`/api/org/charts/${cid}`);
  assert.equal(d.json.chart.currentVersionId, draft.id);
  assert.equal(d.json.version.payload.pages[0].boxes.length, 6);
  const versions = (await api(`/api/org/charts/${cid}/versions`)).json.versions;
  assert.deepEqual(versions.map((v) => v.state), ['published', 'superseded']);
  assert.ok(versions.every((v) => v.payload === undefined), 'list omits payloads');
  for (const action of ['org_chart_v2.version_submit', 'org_chart_v2.version_approve', 'org_chart_v2.version_publish']) {
    assert.ok(get('SELECT id FROM audit_log WHERE action=?', [action]), `${action} audited`);
  }
});
await check('published version is immutable: history is read-only and structure still needs a draft', async () => {
  const old = (await api(`/api/org/charts/versions/${live.id}`)).json.version;
  const r = await api(`/api/org/charts/versions/${live.id}`, { method: 'PUT', tok: manager, body: { payload: old.payload, updatedAt: old.updatedAt } });
  assert.equal(r.status, 409);
  assert.equal((await api(`/api/org/charts/versions/${live.id}/submit`, { method: 'POST', tok: manager })).status, 409);
  assert.equal((await api(`/api/org/charts/versions/${draft.id}/submit`, { method: 'POST', tok: manager })).status, 409);
});
await check('publishing synced seats: new seat IDs added, existing seat IDs kept', async () => {
  const pos = (await api(`/api/org/charts/${cid}`)).json.positions;
  const qaSeats = pos.filter((x) => x.boxKey === 'qa');
  assert.deepEqual(qaSeats.map((x) => x.approval), ['approved', 'approved', 'proposed']);
  assert.equal(pos.filter((x) => x.boxKey === 'lead').length, 1);
  assert.equal(qaSeats[0].createdInVersionId, live.id, 'seat 1 kept its original id');
});

/* ------------------------- delete box: promote vs branch ---------------------- */

await check('deleteBox promote: reports move to its parent; branch removes the subtree', async () => {
  const p = (await api(`/api/org/charts/${cid}`)).json.version.payload;
  const promote = Charts.deleteBox(p, 'eng', 'promote');
  const bx = Charts.allBoxes(promote.payload);
  assert.equal(bx.find((b) => b.key === 'plan').parentKey, 'lead');
  assert.ok(!bx.find((b) => b.key === 'eng'));
  assert.deepEqual(promote.promoted, ['plan']);
  const branch = Charts.deleteBox(p, 'eng', 'branch');
  assert.deepEqual(branch.removed.sort(), ['eng', 'plan']);
  assert.ok(!Charts.allBoxes(branch.payload).find((b) => b.key === 'plan'));
  assert.equal(Charts.findCycle(Charts.allBoxes(promote.payload)), null);
  assert.throws(() => Charts.deleteBox(p, 'eng', 'weird'), /promote or branch/);
});
await check('delete endpoint: promote by default, branch needs confirmation, published refused', async () => {
  const d2 = (await api(`/api/org/charts/${cid}/drafts`, { method: 'POST', tok: manager, body: { label: 'Option B' } })).json.version;
  const noConfirm = await api(`/api/org/charts/versions/${d2.id}/boxes/eng?mode=branch`, { method: 'DELETE', tok: manager });
  assert.equal(noConfirm.status, 409);
  assert.equal(noConfirm.json.requiresConfirm, true);
  assert.equal(noConfirm.json.boxCount, 2);
  const promote = await api(`/api/org/charts/versions/${d2.id}/boxes/eng`, { method: 'DELETE', tok: manager });
  assert.equal(promote.status, 200, promote.text);
  assert.deepEqual(promote.json.promoted, ['plan']);
  const branch = await api(`/api/org/charts/versions/${d2.id}/boxes/qa?mode=branch&confirm=true`, { method: 'DELETE', tok: manager });
  assert.equal(branch.status, 200, branch.text);
  assert.deepEqual(branch.json.removed, ['qa']);
  const pub = await api(`/api/org/charts/versions/${draft.id}/boxes/plan`, { method: 'DELETE', tok: manager });
  assert.equal(pub.status, 409);
  assert.equal((await api(`/api/org/charts/versions/${d2.id}/boxes/nope`, { method: 'DELETE', tok: manager })).status, 404);

  // People still sit in the removed boxes: publishing must ask where they go.
  await api(`/api/org/charts/versions/${d2.id}/submit`, { method: 'POST', tok: manager });
  await api(`/api/org/charts/versions/${d2.id}/approve`, { method: 'POST', tok: director });
  const blocked = await api(`/api/org/charts/versions/${d2.id}/publish`, { method: 'POST', tok: manager });
  assert.equal(blocked.status, 409, blocked.text);
  assert.ok(blocked.json.orphanBoxKeys.includes('eng'));
  const moved = await api(`/api/org/charts/versions/${d2.id}/publish`, { method: 'POST', tok: manager, body: { moves: { eng: 'lead' } } });
  assert.equal(moved.status, 200, moved.text);
  const d = (await api(`/api/org/charts/${cid}`)).json;
  assert.ok(d.assignments.filter((a) => a.boxKey === 'lead').length >= 1);
  assert.ok(d.assignments.every((a) => Charts.allBoxes(d.version.payload).some((b) => b.key === a.boxKey)));
});
await check('a draft whose base is no longer the published version cannot be submitted', async () => {
  const stale = (await api(`/api/org/charts/${cid}/drafts`, { method: 'POST', tok: manager, body: {} })).json.version;
  const newer = (await api(`/api/org/charts/${cid}/drafts`, { method: 'POST', tok: manager, body: {} })).json.version;
  for (const v of [newer]) {
    await api(`/api/org/charts/versions/${v.id}/submit`, { method: 'POST', tok: manager });
    await api(`/api/org/charts/versions/${v.id}/approve`, { method: 'POST', tok: director });
    assert.equal((await api(`/api/org/charts/versions/${v.id}/publish`, { method: 'POST', tok: manager })).status, 200);
  }
  assert.equal((await api(`/api/org/charts/versions/${stale.id}/submit`, { method: 'POST', tok: manager })).status, 409);
});

/* --------------------- live edits after a draft started ---------------------- */

{
  const mkc = (await api('/api/org/charts', { method: 'POST', tok: manager, body: { name: 'Stale Tower', payload: basePayload() } })).json;
  const sc = mkc.chart.id;
  const liveEdit = async (mutate) => {
    const cur = (await api(`/api/org/charts/versions/${mkc.chart.currentVersionId}`)).json.version;
    const p = structuredClone(cur.payload);
    mutate(p.pages[0]);
    const r = await api(`/api/org/charts/versions/${cur.id}`, { method: 'PUT', tok: manager, body: { payload: p, updatedAt: cur.updatedAt } });
    assert.equal(r.status, 200, r.text);
    return r.json.version;
  };
  const box = (pg, k) => pg.boxes.find((b) => b.key === k);
  const dr = (await api(`/api/org/charts/${sc}/drafts`, { method: 'POST', tok: manager, body: {} })).json.version;
  // The draft itself retitles "eng" and moves "qa".
  const dv = (await api(`/api/org/charts/versions/${dr.id}`)).json.version;
  const dp = structuredClone(dv.payload);
  box(dp.pages[0], 'eng').title = 'Draft Engineer';
  box(dp.pages[0], 'qa').x = 555;
  const saved = await api(`/api/org/charts/versions/${dr.id}`, { method: 'PUT', tok: manager, body: { payload: dp, updatedAt: dv.updatedAt } });
  // Live edits: retitle eng (draft also changed it), retitle pm, widen qa, re-route a line.
  await liveEdit((pg) => {
    box(pg, 'eng').title = 'Live Engineer';
    box(pg, 'pm').title = 'Live Manager';
    box(pg, 'qa').w = 120;
    pg.links[0].points = [{ x: 5, y: 6 }];
  });
  await check('live route edit may add a link entry (reporting lines are implied by parentKey)', async () => {
    const cur = (await api(`/api/org/charts/versions/${mkc.chart.currentVersionId}`)).json.version;
    const p = structuredClone(cur.payload);
    p.pages[0].links.push({ childKey: 'qa', kind: 'reports', fromSide: 'bottom', toSide: 'top', points: [{ x: 1, y: 2 }, { x: 3, y: 2 }] });
    const r = await api(`/api/org/charts/versions/${cur.id}`, { method: 'PUT', tok: manager, body: { payload: p, updatedAt: cur.updatedAt } });
    assert.equal(r.status, 200, r.text);
    p.pages[0].links.push({ childKey: 'qa', kind: 'dotted', fromSide: 'bottom', toSide: 'top' });
    assert.equal((await api(`/api/org/charts/versions/${cur.id}`, { method: 'PUT', tok: manager, body: { payload: p, updatedAt: r.json.version.updatedAt } })).status, 409, 'dotted line stays structural');
  });
  await check('stale draft: submit returns 409 with a live-changes summary', async () => {
    assert.equal(saved.status, 200, saved.text);
    const r = await api(`/api/org/charts/versions/${dr.id}/submit`, { method: 'POST', tok: manager });
    assert.equal(r.status, 409);
    assert.equal(r.json.error, 'The live chart changed after this draft started.');
    assert.ok(Array.isArray(r.json.liveChanges) && r.json.liveChanges.length >= 3);
    assert.ok(r.json.liveChanges.some((x) => /Live Manager/.test(x)));
  });
  await check('rebase brings live changes in; the draft\'s own changes win', async () => {
    assert.equal((await api(`/api/org/charts/versions/${dr.id}/rebase`, { method: 'POST', tok: viewer })).status, 403);
    const r = await api(`/api/org/charts/versions/${dr.id}/rebase`, { method: 'POST', tok: manager });
    assert.equal(r.status, 200, r.text);
    const pg = r.json.version.payload.pages[0];
    assert.equal(box(pg, 'eng').title, 'Draft Engineer', 'draft title wins');
    assert.equal(box(pg, 'qa').x, 555, 'draft position wins');
    assert.equal(box(pg, 'pm').title, 'Live Manager', 'live-only change copied');
    assert.equal(box(pg, 'qa').w, 120, 'live-only width copied');
    assert.deepEqual(pg.links[0].points, [{ x: 5, y: 6 }], 'live route copied');
    assert.deepEqual(pg.links.find((l) => l.childKey === 'qa').points, [{ x: 1, y: 2 }, { x: 3, y: 2 }], 'route added live for a new link entry is copied');
  });
  await check('after rebase the draft submits, and a newer live edit blocks publish again', async () => {
    assert.equal((await api(`/api/org/charts/versions/${dr.id}/submit`, { method: 'POST', tok: manager })).status, 200);
    assert.equal((await api(`/api/org/charts/versions/${dr.id}/approve`, { method: 'POST', tok: director })).status, 200);
    // approved drafts are pending; live edit now makes publish stale
    await liveEdit((pg) => { box(pg, 'plan').title = 'Live Planner'; });
    const r = await api(`/api/org/charts/versions/${dr.id}/publish`, { method: 'POST', tok: manager });
    assert.equal(r.status, 409);
    assert.equal(r.json.error, 'The live chart changed after this draft started.');
    assert.ok(r.json.liveChanges.some((x) => /Live Planner/.test(x)));
    const rb = await api(`/api/org/charts/versions/${dr.id}/rebase`, { method: 'POST', tok: manager });
    assert.equal(rb.status, 200, rb.text);
    assert.equal(rb.json.version.state, 'pending_approval', 'approval is kept');
    assert.equal(box(rb.json.version.payload.pages[0], 'plan').title, 'Live Planner');
    const pub = await api(`/api/org/charts/versions/${dr.id}/publish`, { method: 'POST', tok: manager });
    assert.equal(pub.status, 200, pub.text);
  });
}

/* ------------------------------ import (drafts) ----------------------------- */

{
  const importPayload = () => ({
    pages: [{
      key: 'p1', name: 'Imported', title1: 'Import Plaza', title2: 'Site chart', date: '11/10/2026', paper: 'A3',
      boxes: [
        P('Import Plaza', { key: 'iroot', kind: 'team', planned: 0 }),
        P('Project Manager', { key: 'ipm', parentKey: 'iroot', x: 100, y: 100 }),
        P('Site Engineer', { key: 'ieng', parentKey: 'ipm', planned: 2, x: 100, y: 200 }),
        P('Planner', { key: 'iplan', parentKey: 'ipm', planned: 1, x: 200, y: 200 }),
      ],
      links: [{ childKey: 'ipm', kind: 'reports', fromSide: 'bottom', toSide: 'top' }],
      notes: [],
      importPeople: [
        { boxKey: 'ipm', personName: 'Rana Idris', status: 'in_post', suffix: 'Deputy', share: 1, sortOrder: 0 },
        { boxKey: 'ieng', personName: 'Karim Zaki', status: 'joining', effectiveDate: '2026-10-30', share: 1, sortOrder: 0 },
        { boxKey: 'ieng', personName: 'Dalia Fawzy', status: 'in_post', share: 1, sortOrder: 1 },
        { boxKey: 'ghost', personName: 'Nobody Here', status: 'in_post', share: 1 },
      ],
    }],
  });
  let ic;
  await check('import as a new chart creates a draft, never a published version', async () => {
    const r = await api('/api/org/charts', { method: 'POST', tok: manager, body: { name: 'Import Plaza', payload: importPayload(), asDraft: true } });
    assert.equal(r.status, 201, r.text);
    ic = r.json;
    assert.equal(ic.version.state, 'draft');
    assert.equal(ic.chart.currentVersionId, null);
    assert.equal(ic.version.payload.pages[0].importPeople.length, 3, 'a person whose box is not in the file is dropped');
    assert.equal(all('SELECT id FROM org_assignment WHERE chart_id=?', [ic.chart.id]).length, 0, 'no people yet');
    assert.equal(all('SELECT id FROM org_position WHERE chart_id=?', [ic.chart.id]).length, 0, 'no seats yet');
    assert.equal(all("SELECT id FROM org_chart_version WHERE chart_id=? AND state='published'", [ic.chart.id]).length, 0);
    const detail = await api(`/api/org/charts/${ic.chart.id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.json.version, null);
    assert.equal(all("SELECT id FROM audit_log WHERE action='org_chart_v2.chart_imported'").length >= 1, true, 'import is audited');
  });
  await check('an import with duplicate short names publishes and reports them', async () => {
    const pl = importPayload();
    pl.pages[0].importPeople = [
      { boxKey: 'ieng', personName: 'Sami Dup', share: 1, sortOrder: 0 },
      { boxKey: 'ieng', personName: 'sami  dup', share: 1, sortOrder: 1 },
      { boxKey: 'ipm', personName: 'Sami Dup', share: 1, sortOrder: 2 },
    ];
    const r = await api('/api/org/charts', { method: 'POST', tok: manager, body: { name: 'Dup Plaza', payload: pl, asDraft: true } });
    const v = r.json.version.id;
    await api(`/api/org/charts/versions/${v}/submit`, { method: 'POST', tok: manager });
    await api(`/api/org/charts/versions/${v}/approve`, { method: 'POST', tok: director });
    const pub = await api(`/api/org/charts/versions/${v}/publish`, { method: 'POST', tok: manager });
    assert.equal(pub.status, 200, pub.text);
    assert.equal(pub.json.importedPeople, 3);
    const g = pub.json.possibleDuplicates.find((x) => x.personName === 'Sami Dup');
    assert.equal(g.occurrences.length, 3);
    assert.ok(g.occurrences.some((o) => o.boxTitle === 'Project Manager'));
  });
  await check('a viewer cannot import', async () => {
    assert.equal((await api('/api/org/charts', { method: 'POST', tok: viewer, body: { name: 'X', payload: importPayload(), asDraft: true } })).status, 403);
  });
  await check('an imported draft publishes through submit, approve, publish and then creates its people', async () => {
    const v = ic.version.id;
    assert.equal((await api(`/api/org/charts/versions/${v}/submit`, { method: 'POST', tok: manager })).status, 200);
    assert.equal((await api(`/api/org/charts/versions/${v}/approve`, { method: 'POST', tok: director })).status, 200);
    assert.equal(all('SELECT id FROM org_assignment WHERE chart_id=?', [ic.chart.id]).length, 0, 'still nothing before publish');
    const pub = await api(`/api/org/charts/versions/${v}/publish`, { method: 'POST', tok: manager });
    assert.equal(pub.status, 200, pub.text);
    assert.equal(pub.json.importedPeople, 3);
    const d = (await api(`/api/org/charts/${ic.chart.id}`)).json;
    assert.equal(d.chart.currentVersionId, v);
    assert.equal(d.assignments.length, 3);
    const k = d.assignments.find((a) => a.personName === 'Karim Zaki');
    assert.equal(k.status, 'joining');
    assert.equal(k.effectiveDate, '2026-10-30');
    assert.equal(k.boxKey, 'ieng');
    assert.ok(k.positionId, 'seated');
    assert.equal(d.assignments.find((a) => a.personName === 'Rana Idris').suffix, 'Deputy');
    assert.equal(d.version.payload.pages[0].importPeople, undefined, 'import list is not kept on the published version');
  });
  await check('a draft started from the published imported chart does not carry importPeople (no duplicates)', async () => {
    const r = await api(`/api/org/charts/${ic.chart.id}/drafts`, { method: 'POST', tok: manager, body: { label: 'Next' } });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.version.payload.pages[0].importPeople, undefined);
  });
  await check('a new draft on an existing chart can take an imported payload; live chart and people stay untouched', async () => {
    const base = (await api('/api/org/charts', { method: 'POST', tok: manager, body: { name: 'Existing Site', payload: basePayload() } })).json;
    await api(`/api/org/charts/${base.chart.id}/assignments`, { method: 'POST', tok: manager, body: { boxKey: 'pm', personName: 'Live Person' } });
    const r = await api(`/api/org/charts/${base.chart.id}/drafts`, { method: 'POST', tok: manager, body: { label: 'Imported', payload: importPayload() } });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.version.state, 'draft');
    assert.equal(r.json.version.basedOnVersionId, base.chart.currentVersionId);
    assert.equal(r.json.version.payload.pages[0].boxes.length, 4);
    const d = (await api(`/api/org/charts/${base.chart.id}`)).json;
    assert.equal(d.version.payload.pages[0].boxes.length, 5, 'published chart unchanged');
    assert.deepEqual(d.assignments.map((a) => a.personName), ['Live Person']);
    const bad = await api(`/api/org/charts/${base.chart.id}/drafts`, { method: 'POST', tok: manager, body: { payload: { pages: [] } } });
    assert.equal(bad.status, 400);
  });
  await check('deleting a box in a draft drops the people imported into it', async () => {
    const r = await api('/api/org/charts', { method: 'POST', tok: manager, body: { name: 'Import Two', payload: importPayload(), asDraft: true } });
    const del = await api(`/api/org/charts/versions/${r.json.version.id}/boxes/ieng?mode=promote`, { method: 'DELETE', tok: manager });
    assert.equal(del.status, 200, del.text);
    assert.deepEqual(del.json.version.payload.pages[0].importPeople.map((x) => x.personName), ['Rana Idris']);
  });
  await check('creating a published chart directly with importPeople creates the people at once', async () => {
    const pl = importPayload();
    pl.pages[0].importPeople.forEach((x) => { x.personName += ' Three'; });
    const r = await api('/api/org/charts', { method: 'POST', tok: manager, body: { name: 'Import Three', payload: pl } });
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.version.state, 'published');
    assert.equal(r.json.version.payload.pages[0].importPeople, undefined);
    assert.equal(all('SELECT id FROM org_assignment WHERE chart_id=?', [r.json.chart.id]).length, 3);
  });
  await check('re-import on an existing chart replaces its people when published (flag set by the import)', async () => {
    const base = (await api('/api/org/charts', { method: 'POST', tok: manager, body: { name: 'Replace Site', payload: basePayload() } })).json;
    await api(`/api/org/charts/${base.chart.id}/assignments`, { method: 'POST', tok: manager, body: { boxKey: 'pm', personName: 'Old Person' } });
    const pl = importPayload();
    pl.importReplacesPeople = true;
    pl.pages[0].importPeople.forEach((x) => { x.personName += ' Replace'; });
    const dr = (await api(`/api/org/charts/${base.chart.id}/drafts`, { method: 'POST', tok: manager, body: { payload: pl } })).json.version;
    await api(`/api/org/charts/versions/${dr.id}/submit`, { method: 'POST', tok: manager });
    await api(`/api/org/charts/versions/${dr.id}/approve`, { method: 'POST', tok: director });
    const pub = await api(`/api/org/charts/versions/${dr.id}/publish`, { method: 'POST', tok: manager });
    assert.equal(pub.status, 200, pub.text);
    const d = (await api(`/api/org/charts/${base.chart.id}`)).json;
    assert.deepEqual(d.assignments.map((a) => a.personName).sort(), ['Dalia Fawzy Replace', 'Karim Zaki Replace', 'Rana Idris Replace']);
    assert.equal(d.version.payload.importReplacesPeople, undefined);
  });
  await check('live edits cannot smuggle importPeople into a published version', async () => {
    const d = (await api(`/api/org/charts/${ic.chart.id}`)).json;
    const pl = structuredClone(d.version.payload);
    pl.pages[0].importPeople = [{ boxKey: 'ipm', personName: 'Sneaky Person', share: 1 }];
    const r = await api(`/api/org/charts/versions/${d.version.id}`, { method: 'PUT', tok: manager, body: { payload: pl, updatedAt: d.version.updatedAt } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.version.payload.pages[0].importPeople, undefined);
  });
  await check('CSV import groups people rows into role boxes with the migration rules and and has no logo obstacle', async () => {
    const rows = [
      { id: '1', name: 'Mona Adel', title: 'Project Manager', department: 'Site' },
      { id: '2', name: 'Tarek Wael', title: 'Site Engineer', department: 'Site', reportsToId: '1' },
      { id: '3', name: 'Yara Hosny', title: 'Site Engineer', department: 'Site', reportsToId: '1' },
      { id: '4', name: '', title: 'Planner', department: 'Site', reportsTo: 'Mona Adel' },
    ];
    const r = await api('/api/org/charts/import/csv', { method: 'POST', tok: manager, body: { rows, name: 'CSV Site' } });
    assert.equal(r.status, 200, r.text);
    const pg = r.json.payload.pages[0];
    const eng = pg.boxes.filter((b) => b.title === 'Site Engineer');
    assert.equal(eng.length, 1, 'same title and department share one box');
    assert.equal(eng[0].planned, 2);
    assert.equal(pg.importPeople.filter((x) => x.boxKey === eng[0].key).length, 2);
    assert.equal(pg.importPeople.length, 3);
    assert.equal(new Set(pg.boxes.map((b) => b.key)).size, pg.boxes.length);
    assert.equal((await api('/api/org/charts/import/csv', { method: 'POST', tok: viewer, body: { rows } })).status, 403);
    assert.equal((await api('/api/org/charts/import/csv', { method: 'POST', tok: manager, body: { rows: [] } })).status, 400);
    const asNew = await api('/api/org/charts', { method: 'POST', tok: manager, body: { name: 'CSV Site', payload: r.json.payload, asDraft: true } });
    assert.equal(asNew.status, 201, asNew.text);
  });
}

console.log(`\n${failures.length === 0 ? 'ALL PASS' : 'FAILURES'} — ${passed} passed, ${failures.length} failed`);
if (failures.length) console.log('failed:', failures.join(' | '));
process.exit(failures.length === 0 ? 0 : 1);
