// Phase 1 organization-structure HTTP tests.
// Own process, throwaway SQLite DB, in-process server — same pattern as intake_route_http_test.mjs.

process.env.DATABASE_URL = 'file:/tmp/arabtec_org_chart.db';
process.env.PORT = '4197';
process.env.NODE_ENV = 'test';
process.env.SEED_DEMO_DATA = 'true';
process.env.SEED_ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD || 'Admin@12345';
process.env.RATE_LIMIT_DISABLED = 'true';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'org-chart-test-secret-value';
delete process.env.DOCLING_BASE_URL;
delete process.env.OCR_BASE_URL;

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { adminToken } from './test-support/admin-session.mjs';

const DB = '/tmp/arabtec_org_chart.db';
for (const f of [DB, `${DB}-journal`, `${DB}-wal`, `${DB}-shm`]) {
  try { fs.rmSync(f); } catch { /* first run */ }
}

let passed = 0;
const failures = [];
const check = (name, fn) => {
  try { fn(); passed += 1; console.log(`  PASS  ${name}`); }
  catch (e) { failures.push(name); console.log(`  FAIL  ${name}\n        ${e.message}`); }
};

await import('./src/server.js');

const BASE = `http://127.0.0.1:${process.env.PORT}`;
const token = await adminToken(BASE);

const api = async (path, { method = 'GET', tok = token, body } = {}) => {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(tok ? { authorization: `Bearer ${tok}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON is itself a finding */ }
  return { status: res.status, json };
};

const login = async (email, password) => {
  const res = await api('/api/auth/login', { method: 'POST', tok: null, body: { email, password } });
  assert.equal(res.status, 200, `${email} login failed: HTTP ${res.status} ${res.json?.error || ''}`);
  return res.json.token;
};

const chart = await api('/api/org/chart');
check('admin can read the org chart', () => {
  assert.equal(chart.status, 200, `got HTTP ${chart.status}`);
  assert.ok(Array.isArray(chart.json.nodes), 'expected nodes array');
  assert.equal(chart.json.canManage, true, 'admin should be able to manage');
  assert.ok(chart.json.nodes.length > 5, `seed should create a live tree, got ${chart.json.nodes.length}`);
});

check('seed reconstructed Head Office and project charts', () => {
  const titles = chart.json.nodes.map((n) => `${n.employeeName}|${n.positionTitle}|${n.projectOrLocation}`);
  const blob = titles.join('\n');
  assert.match(blob, /Head Office/);
  assert.match(blob, /Aliva/);
  assert.match(blob, /Ahmed Abuzeid/);
  assert.match(blob, /Ramy Rabie/);
  assert.match(blob, /The Estate/);
});

check('admin holds org_chart.manage', async () => {});
const me = await api('/api/auth/me');
check('admin permission list includes org_chart.manage', () => {
  assert.ok((me.json.user?.permissions || []).includes('org_chart.manage'), 'missing org_chart.manage');
});

const viewerTok = await login('viewer@arabtec.com', 'Arabtec@123');
const viewerChart = await api('/api/org/chart', { tok: viewerTok });
check('any authenticated user can view the chart', () => {
  assert.equal(viewerChart.status, 200);
  assert.equal(viewerChart.json.canManage, false);
  assert.ok(viewerChart.json.nodes.length > 0);
});

const recruiterTok = await login('recruiter@arabtec.com', 'Arabtec@123');
const denied = await api('/api/org/chart/nodes', {
  method: 'POST', tok: recruiterTok,
  body: { employeeName: 'Test User', positionTitle: 'Should Fail', nodeType: 'employee_position' },
});
check('recruiter cannot create nodes', () => {
  assert.equal(denied.status, 403, `got HTTP ${denied.status}`);
  assert.ok((denied.json.requiredPermissions || []).includes('org_chart.manage'));
});

const parent = chart.json.nodes.find((n) => n.positionTitle === 'Projects') || chart.json.nodes[0];
const created = await api('/api/org/chart/nodes', {
  method: 'POST',
  body: {
    employeeName: 'Nour Test',
    positionTitle: 'Planning Engineer',
    department: 'Planning',
    projectOrLocation: 'Aliva',
    parentId: parent.id,
    nodeType: 'employee_position',
    status: 'filled',
  },
});
check('admin can add a position', () => {
  assert.equal(created.status, 201, `got HTTP ${created.status}: ${created.json?.error}`);
  assert.equal(created.json.node.employeeName, 'Nour Test');
});

const updated = await api(`/api/org/chart/nodes/${created.json.node.id}`, {
  method: 'PUT',
  body: { positionTitle: 'Senior Planning Engineer', status: 'filled' },
});
check('admin can edit a position', () => {
  assert.equal(updated.status, 200);
  assert.equal(updated.json.node.positionTitle, 'Senior Planning Engineer');
});

const selfParent = await api(`/api/org/chart/nodes/${created.json.node.id}/move`, {
  method: 'POST',
  body: { parentId: created.json.node.id },
});
check('a node cannot report to itself', () => {
  assert.equal(selfParent.status, 400);
  assert.match(String(selfParent.json.error), /itself/i);
});

const child = await api('/api/org/chart/nodes', {
  method: 'POST',
  body: {
    employeeName: 'Child Test',
    positionTitle: 'Site Engineer',
    parentId: created.json.node.id,
    nodeType: 'employee_position',
    status: 'filled',
  },
});
assert.equal(child.status, 201, `child create failed: ${child.json?.error}`);

const cycle = await api(`/api/org/chart/nodes/${created.json.node.id}/move`, {
  method: 'POST',
  body: { parentId: child.json.node.id },
});
check('cycles are rejected', () => {
  assert.equal(cycle.status, 400);
  assert.match(String(cycle.json.error), /cycle/i);
});

const blockedDelete = await api(`/api/org/chart/nodes/${created.json.node.id}`, { method: 'DELETE' });
check('deleting a parent without reassign or branch confirm is refused', () => {
  assert.equal(blockedDelete.status, 409, `got HTTP ${blockedDelete.status}`);
  assert.ok(blockedDelete.json.childCount >= 1);
});

const vacant = await api('/api/org/chart/nodes', {
  method: 'POST',
  body: {
    employeeName: '',
    positionTitle: 'Cost Control Engineer',
    parentId: parent.id,
    nodeType: 'vacant_position',
    status: 'vacant',
  },
});
check('admin can mark a vacant professional role', () => {
  assert.equal(vacant.status, 201, vacant.json?.error);
  assert.equal(vacant.json.node.status, 'vacant');
});

const leafDelete = await api(`/api/org/chart/nodes/${vacant.json.node.id}`, { method: 'DELETE' });
check('a leaf node can be deleted without a branch confirm', () => {
  assert.equal(leafDelete.status, 200);
});

const branchDel = await api(`/api/org/chart/nodes/${created.json.node.id}?mode=branch&confirm=true`, { method: 'DELETE' });
check('branch delete requires confirm and then removes the subtree', () => {
  assert.equal(branchDel.status, 200, branchDel.json?.error);
});

const after = await api('/api/org/chart');
check('deleted branch is gone and seed rows remain', () => {
  const ids = after.json.nodes.map((n) => n.id);
  assert.ok(!ids.includes(created.json.node.id));
  assert.ok(!ids.includes(child.json.node.id));
  assert.ok(after.json.nodes.some((n) => n.employeeName === 'Ahmed Abuzeid'));
});

const anon = await api('/api/org/chart', { tok: null });
check('unauthenticated users cannot view the chart', () => {
  assert.equal(anon.status, 401);
});

console.log(`\n${failures.length === 0 ? 'ALL PASS' : 'FAILURES'} — ${passed} passed, ${failures.length} failed`);
if (failures.length) console.log('failed:', failures.join(' | '));
process.exit(failures.length === 0 ? 0 : 1);
