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
await check('migration splits a repeated name so shares stay within 1', async () => {
  const rows = all("SELECT share FROM org_assignment WHERE person_name='Hadi Sabry'");
  assert.equal(rows.length, 2);
  assert.ok(rows.reduce((s, r) => s + r.share, 0) <= 1 + 1e-9);
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
await check('shares across charts cannot exceed 1 (name match is trimmed and case-insensitive)', async () => {
  const other = await api('/api/org/charts', { method: 'POST', body: { name: 'Second Site', payload: { pages: [{ key: 'p1', boxes: [P('Engineer', { key: 'e1' })] }] } } });
  assert.equal(other.status, 201, other.text);
  const first = await api(`/api/org/charts/${cid}/assignments`, { method: 'POST', body: { boxKey: 'eng', personName: 'Rana Fouad', share: 0.5 } });
  assert.equal(first.status, 201);
  const second = await api(`/api/org/charts/${other.json.chart.id}/assignments`, { method: 'POST', body: { boxKey: 'e1', personName: '  RANA fouad ', share: 0.5 } });
  assert.equal(second.status, 201, second.text);
  const third = await api(`/api/org/charts/${cid}/assignments`, { method: 'POST', body: { boxKey: 'qa', personName: 'rana Fouad', share: 0.1 } });
  assert.equal(third.status, 409);
  assert.match(third.json.error, /100% at most/);
  const raise = await api(`/api/org/charts/${cid}/assignments/${first.json.assignment.id}`, { method: 'PUT', body: { share: 0.9 } });
  assert.equal(raise.status, 409);
  assert.equal((await api(`/api/org/charts/${cid}/assignments`, { method: 'POST', body: { boxKey: 'eng', personName: 'Zed', share: 1.5 } })).status, 400);
  const byId = await api(`/api/org/charts/${cid}/assignments`, { method: 'POST', body: { boxKey: 'eng', personName: 'Rana Fouad', employeeId: 77, share: 1 } });
  assert.equal(byId.status, 201, 'employee_id match is separate from the name match');
  const byId2 = await api(`/api/org/charts/${cid}/assignments`, { method: 'POST', body: { boxKey: 'qa', personName: 'Someone Else', employeeId: 77, share: 0.2 } });
  assert.equal(byId2.status, 409);
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

console.log(`\n${failures.length === 0 ? 'ALL PASS' : 'FAILURES'} — ${passed} passed, ${failures.length} failed`);
if (failures.length) console.log('failed:', failures.join(' | '));
process.exit(failures.length === 0 ? 0 : 1);
