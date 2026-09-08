// Live organization-structure nodes (Phase 1).
// Separate from projects/sites/departments (`org.manage`). Optional user/department/project
// FKs are stored for Phase 2 transfers and are unused by Phase 1 workflows.
import { get, all, run } from './db.js';

const nowISO = () => new Date().toISOString();

export const NODE_TYPES = ['employee_position', 'vacant_position', 'department', 'project', 'organizational_unit'];
export const NODE_STATUSES = ['filled', 'vacant'];

export function toOrgNode(row) {
  if (!row) return null;
  return {
    id: row.id,
    employeeName: row.employee_name || '',
    positionTitle: row.position_title || '',
    department: row.department || '',
    projectOrLocation: row.project_or_location || '',
    parentId: row.parent_id == null ? null : row.parent_id,
    nodeType: row.node_type,
    status: row.status,
    sortOrder: row.sort_order ?? 0,
    userId: row.user_id == null ? null : row.user_id,
    departmentId: row.department_id == null ? null : row.department_id,
    projectId: row.project_id == null ? null : row.project_id,
    notes: row.notes || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function childCount(id) {
  return get('SELECT COUNT(*) AS c FROM organization_node WHERE parent_id=?', [id])?.c ?? 0;
}

export const OrganizationNodes = {
  count() {
    return get('SELECT COUNT(*) AS c FROM organization_node')?.c ?? 0;
  },
  all() {
    return all('SELECT * FROM organization_node ORDER BY sort_order ASC, id ASC').map(toOrgNode);
  },
  byId(id) {
    return toOrgNode(get('SELECT * FROM organization_node WHERE id=?', [Number(id)]));
  },
  children(parentId) {
    if (parentId == null) {
      return all('SELECT * FROM organization_node WHERE parent_id IS NULL ORDER BY sort_order ASC, id ASC').map(toOrgNode);
    }
    return all('SELECT * FROM organization_node WHERE parent_id=? ORDER BY sort_order ASC, id ASC', [Number(parentId)]).map(toOrgNode);
  },
  descendantIds(id) {
    const out = [];
    const queue = [Number(id)];
    const seen = new Set();
    while (queue.length) {
      const cur = queue.shift();
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const row of all('SELECT id FROM organization_node WHERE parent_id=?', [cur])) {
        out.push(row.id);
        queue.push(row.id);
      }
    }
    return out;
  },
  wouldCreateCycle(id, newParentId) {
    if (newParentId == null || newParentId === '') return false;
    const nid = Number(id);
    const pid = Number(newParentId);
    if (!Number.isFinite(nid) || !Number.isFinite(pid)) return false;
    if (nid === pid) return true;
    let cur = this.byId(pid);
    const seen = new Set();
    while (cur) {
      if (cur.id === nid) return true;
      if (seen.has(cur.id)) return true;
      seen.add(cur.id);
      cur = cur.parentId == null ? null : this.byId(cur.parentId);
    }
    return false;
  },
  create(d) {
    const r = run(
      `INSERT INTO organization_node
        (employee_name, position_title, department, project_or_location, parent_id, node_type, status,
         sort_order, user_id, department_id, project_id, notes, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        d.employeeName || null,
        d.positionTitle || '',
        d.department || null,
        d.projectOrLocation || null,
        d.parentId == null || d.parentId === '' ? null : Number(d.parentId),
        d.nodeType || 'employee_position',
        d.status || 'filled',
        d.sortOrder ?? 0,
        d.userId == null || d.userId === '' ? null : Number(d.userId),
        d.departmentId == null || d.departmentId === '' ? null : Number(d.departmentId),
        d.projectId == null || d.projectId === '' ? null : Number(d.projectId),
        d.notes || null,
        nowISO(),
        nowISO(),
      ],
    );
    return this.byId(Number(r.lastInsertRowid));
  },
  update(id, d) {
    const c = this.byId(id);
    if (!c) return null;
    run(
      `UPDATE organization_node SET employee_name=?, position_title=?, department=?, project_or_location=?,
        parent_id=?, node_type=?, status=?, sort_order=?, user_id=?, department_id=?, project_id=?, notes=?, updated_at=?
       WHERE id=?`,
      [
        d.employeeName !== undefined ? (d.employeeName || null) : (c.employeeName || null),
        d.positionTitle !== undefined ? d.positionTitle : c.positionTitle,
        d.department !== undefined ? (d.department || null) : (c.department || null),
        d.projectOrLocation !== undefined ? (d.projectOrLocation || null) : (c.projectOrLocation || null),
        d.parentId !== undefined ? (d.parentId == null || d.parentId === '' ? null : Number(d.parentId)) : c.parentId,
        d.nodeType !== undefined ? d.nodeType : c.nodeType,
        d.status !== undefined ? d.status : c.status,
        d.sortOrder !== undefined ? Number(d.sortOrder) : c.sortOrder,
        d.userId !== undefined ? (d.userId == null || d.userId === '' ? null : Number(d.userId)) : c.userId,
        d.departmentId !== undefined ? (d.departmentId == null || d.departmentId === '' ? null : Number(d.departmentId)) : c.departmentId,
        d.projectId !== undefined ? (d.projectId == null || d.projectId === '' ? null : Number(d.projectId)) : c.projectId,
        d.notes !== undefined ? (d.notes || null) : (c.notes || null),
        nowISO(),
        Number(id),
      ],
    );
    return this.byId(id);
  },
  move(id, parentId, sortOrder) {
    const c = this.byId(id);
    if (!c) return null;
    run(
      'UPDATE organization_node SET parent_id=?, sort_order=?, updated_at=? WHERE id=?',
      [
        parentId == null || parentId === '' ? null : Number(parentId),
        sortOrder === undefined ? c.sortOrder : Number(sortOrder),
        nowISO(),
        Number(id),
      ],
    );
    return this.byId(id);
  },
  reassignChildren(id, newParentId) {
    run(
      'UPDATE organization_node SET parent_id=?, updated_at=? WHERE parent_id=?',
      [newParentId == null || newParentId === '' ? null : Number(newParentId), nowISO(), Number(id)],
    );
  },
  remove(id) {
    run('DELETE FROM organization_node WHERE id=?', [Number(id)]);
  },
  removeBranch(id) {
    const ids = this.descendantIds(id);
    ids.reverse();
    for (const childId of ids) run('DELETE FROM organization_node WHERE id=?', [childId]);
    run('DELETE FROM organization_node WHERE id=?', [Number(id)]);
  },
  childCount,
};
