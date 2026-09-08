// Chart routes are registered onto the existing /api/org router.
import { OrganizationNodes, NODE_TYPES, NODE_STATUSES } from '../lib/organization-nodes.js';
import { requirePermission } from '../middleware/auth.js';
import { writeAudit } from '../lib/audit.js';

function canManage(req) {
  return !!(req.user && Array.isArray(req.user.permissions) && req.user.permissions.includes('org_chart.manage'));
}

function parseParentId(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '' || value === 'null') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function validateNodePayload(body, { partial = false } = {}) {
  const errors = [];
  if (!partial && !(body.positionTitle || '').trim() && !(body.employeeName || '').trim()) {
    errors.push('Position title or employee name is required.');
  }
  if (body.nodeType != null && !NODE_TYPES.includes(body.nodeType)) {
    errors.push('Invalid node type.');
  }
  if (body.status != null && !NODE_STATUSES.includes(body.status)) {
    errors.push('Invalid status. Use filled or vacant.');
  }
  return errors;
}

export function registerOrgChartRoutes(router) {
  router.get('/chart', (req, res) => {
    res.json({
      nodes: OrganizationNodes.all(),
      canManage: canManage(req),
    });
  });

  router.post('/chart/nodes', requirePermission('org_chart.manage'), (req, res) => {
    const body = req.body || {};
    const errors = validateNodePayload(body);
    if (errors.length) return res.status(400).json({ error: errors[0] });
    const parentId = parseParentId(body.parentId);
    if (parentId != null && !OrganizationNodes.byId(parentId)) {
      return res.status(400).json({ error: 'Reports-to node was not found.' });
    }
    const created = OrganizationNodes.create({
      employeeName: body.employeeName,
      positionTitle: body.positionTitle,
      department: body.department,
      projectOrLocation: body.projectOrLocation,
      parentId,
      nodeType: body.nodeType || ((body.employeeName || '').trim() ? 'employee_position' : 'vacant_position'),
      status: body.status || ((body.employeeName || '').trim() ? 'filled' : 'vacant'),
      sortOrder: body.sortOrder,
      userId: body.userId,
      departmentId: body.departmentId,
      projectId: body.projectId,
      notes: body.notes,
    });
    writeAudit(req, {
      action: 'org_chart.node_created',
      entityType: 'organization_node',
      entityId: created.id,
      newValue: created,
    });
    res.status(201).json({ node: created });
  });

  router.put('/chart/nodes/:id', requirePermission('org_chart.manage'), (req, res) => {
    const id = Number(req.params.id);
    const before = OrganizationNodes.byId(id);
    if (!before) return res.status(404).json({ error: 'Organization node not found.' });
    const body = req.body || {};
    const errors = validateNodePayload(body, { partial: true });
    if (errors.length) return res.status(400).json({ error: errors[0] });
    let parentId = before.parentId;
    if (body.parentId !== undefined) {
      parentId = parseParentId(body.parentId);
      if (parentId != null && !OrganizationNodes.byId(parentId)) {
        return res.status(400).json({ error: 'Reports-to node was not found.' });
      }
      if (parentId === id) return res.status(400).json({ error: 'A position cannot report to itself.' });
      if (OrganizationNodes.wouldCreateCycle(id, parentId)) {
        return res.status(400).json({ error: 'That change would create a reporting cycle.' });
      }
    }
    const updated = OrganizationNodes.update(id, { ...body, parentId });
    writeAudit(req, {
      action: 'org_chart.node_updated',
      entityType: 'organization_node',
      entityId: id,
      oldValue: before,
      newValue: updated,
    });
    res.json({ node: updated });
  });

  router.post('/chart/nodes/:id/move', requirePermission('org_chart.manage'), (req, res) => {
    const id = Number(req.params.id);
    const before = OrganizationNodes.byId(id);
    if (!before) return res.status(404).json({ error: 'Organization node not found.' });
    const parentId = parseParentId((req.body || {}).parentId);
    if (parentId === id) return res.status(400).json({ error: 'A position cannot report to itself.' });
    if (parentId != null && !OrganizationNodes.byId(parentId)) {
      return res.status(400).json({ error: 'Reports-to node was not found.' });
    }
    if (OrganizationNodes.wouldCreateCycle(id, parentId)) {
      return res.status(400).json({ error: 'That move would create a reporting cycle.' });
    }
    const updated = OrganizationNodes.move(id, parentId, (req.body || {}).sortOrder);
    writeAudit(req, {
      action: 'org_chart.node_moved',
      entityType: 'organization_node',
      entityId: id,
      oldValue: { parentId: before.parentId, sortOrder: before.sortOrder },
      newValue: { parentId: updated.parentId, sortOrder: updated.sortOrder },
    });
    res.json({ node: updated });
  });

  router.delete('/chart/nodes/:id', requirePermission('org_chart.manage'), (req, res) => {
    const id = Number(req.params.id);
    const before = OrganizationNodes.byId(id);
    if (!before) return res.status(404).json({ error: 'Organization node not found.' });
    const mode = String((req.query && req.query.mode) || (req.body && req.body.mode) || 'node');
    const confirm = String((req.query && req.query.confirm) || (req.body && req.body.confirm) || '') === 'true';
    const reassignTo = parseParentId((req.query && req.query.reassignTo) || (req.body && req.body.reassignTo));
    const kids = OrganizationNodes.childCount(id);

    if (mode === 'branch') {
      if (!confirm) {
        return res.status(409).json({
          error: 'Deleting a branch needs confirmation. This will remove the position and everyone under it.',
          childCount: kids,
          requiresConfirm: true,
        });
      }
      OrganizationNodes.removeBranch(id);
      writeAudit(req, {
        action: 'org_chart.branch_deleted',
        entityType: 'organization_node',
        entityId: id,
        oldValue: before,
        comments: `Removed node and ${kids} direct reports (full subtree).`,
      });
      return res.json({ ok: true, mode: 'branch' });
    }

    if (kids > 0) {
      if (reassignTo === undefined || reassignTo === id) {
        return res.status(409).json({
          error: 'This position has people under it. Reassign them first, or confirm deleting the whole branch.',
          childCount: kids,
          requiresReassign: true,
        });
      }
      if (reassignTo != null && !OrganizationNodes.byId(reassignTo)) {
        return res.status(400).json({ error: 'Reassign-to node was not found.' });
      }
      if (reassignTo != null && OrganizationNodes.wouldCreateCycle(id, reassignTo)) {
        return res.status(400).json({ error: 'Reassigning there would create a reporting cycle.' });
      }
      OrganizationNodes.reassignChildren(id, reassignTo);
    }
    OrganizationNodes.remove(id);
    writeAudit(req, {
      action: 'org_chart.node_deleted',
      entityType: 'organization_node',
      entityId: id,
      oldValue: before,
      comments: kids ? `Reassigned ${kids} reports to ${reassignTo}` : null,
    });
    res.json({ ok: true, mode: 'node' });
  });
}
