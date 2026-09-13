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

/* ---------------------------------------------------------------------------
   The chart must frame itself. `.org-canvas` is `width: max-content` and the
   tree centres inside it, so with the seeded org the canvas lays out ~19500px
   wide and the root sits ~9700px in. Pan (0,0) shows the canvas's far-left
   edge — and the wrap is `overflow: hidden` on both axes, so nothing scrolls
   there. `fit()` used to be exactly `setScale(1); setPan({x:0,y:0})`, i.e. the
   broken state itself, and zoom only scales about `transform-origin: 0 0`. Net
   effect measured in a browser: 5 of 339 cards reachable, root not among them.
   ------------------------------------------------------------------------ */
{
  const orgJsx = fs.readFileSync(new URL('../frontend/public/org-structure.jsx', import.meta.url), 'utf8');
  const fnBody = (name) => {
    const at = orgJsx.indexOf(name);
    if (at < 0) return '';
    let depth = 0;
    for (let i = orgJsx.indexOf('{', at); i < orgJsx.length; i++) {
      if (orgJsx[i] === '{') depth++;
      else if (orgJsx[i] === '}') { depth--; if (depth === 0) return orgJsx.slice(at, i + 1); }
    }
    return '';
  };
  const fit = fnBody('function fit()');
  check('fit() measures the canvas instead of resetting the pan to the origin', () => {
    assert.ok(fit.length > 0, 'fit() is still declared');
    assert.ok(/offsetWidth/.test(fit) && /clientWidth/.test(fit),
      'fit() must measure the canvas against its wrapper, not assume a position');
    assert.ok(!/setPan\(\s*\{\s*x:\s*0\s*,\s*y:\s*0\s*\}\s*\)\s*;?\s*\}\s*$/.test(fit.replace(/\s+/g, ' ')),
      'fit() must not end by parking the canvas back at the origin');
    assert.ok(/centerOn\(/.test(fit), 'fit() centres through the shared helper');
  });
  check('the centring helper positions the canvas midpoint, not its left edge', () => {
    // The maths moved into the exported, pure `centerOffset` so it can be
    // asserted on real numbers (ui_behavior_test.mjs); this only pins that
    // centerOn still delegates there rather than re-deriving a pan of its own.
    const centre = fnBody('const centerOn = useCallback');
    assert.match(centre, /setPan\(centerOffset\(/, 'centerOn delegates to the shared maths');
    // Matched against the file, not via fnBody: centerOffset destructures its
    // argument, so the first `{` after the name is the parameter pattern and
    // brace-matching from there returns the signature, never the body.
    assert.match(orgJsx, /x:\s*Math\.round\(\(wrapW - canvasW \* scale\) \/ 2\)/,
      'centerOffset offsets by half the difference between wrapper and canvas width');
  });
  check('re-framing watches the canvas width, not the visible-node count', () => {
    // Keying on `visible.length` missed expand/collapse entirely — those change
    // the `collapsed` Set, not `visible` — so collapsing the root left the pan
    // 9228px from the only remaining card. The canvas's layout width is the
    // signal that moves for every cause. The outcome (root on screen after each
    // of those) is asserted on real numbers in ui_behavior_test.mjs.
    assert.match(orgJsx, /new ResizeObserver\(reframe\)/, 'the canvas width is observed');
    assert.match(orgJsx, /ro\.observe\(canvas\)/, 'the observer is attached to the canvas itself');
    assert.match(orgJsx, /w === lastWidth/, 're-framing is skipped when the width has not moved');
    assert.ok(!/framedFor\.current = visible\.length/.test(orgJsx),
      'the old visible.length key is gone');
    assert.match(orgJsx, /centerOn\(framedOnce\.current \? scaleRef\.current : 1\)/,
      're-framing keeps the scale the user chose after the first frame');
  });
  check('searching brings the first match into view', () => {
    assert.match(orgJsx, /querySelector\('\.org-card\.is-match'\)/,
      'search pans to its match instead of only ringing it');
  });
  check('the collapse toggle is a full-size click target', () => {
    const rule = orgJsx.slice(orgJsx.indexOf('.org-toggle {'), orgJsx.indexOf('}', orgJsx.indexOf('.org-toggle {')));
    assert.match(rule, /min-height:\s*28px/, '.org-toggle keeps a 28px minimum height');
  });
}

console.log(`\n${failures.length === 0 ? 'ALL PASS' : 'FAILURES'} — ${passed} passed, ${failures.length} failed`);
if (failures.length) console.log('failed:', failures.join(' | '));
process.exit(failures.length === 0 ? 0 : 1);
