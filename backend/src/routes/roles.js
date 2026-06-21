import { Router } from 'express';
import { Roles, Permissions } from '../lib/models.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { writeAudit } from '../lib/audit.js';

const router = Router();
router.use(requireAuth);

// GET /api/roles — roles with their permission codes
router.get('/', (req, res) => {
  const roles = Roles.all().map((r) => ({
    id: r.id, code: r.code, name: r.name, description: r.description,
    isSystem: r.is_system === 1, permissions: Roles.permissionsForRole(r.id),
  }));
  res.json({ roles });
});

// GET /api/roles/permissions — full permission catalog
router.get('/permissions', (req, res) => {
  res.json({ permissions: Permissions.all() });
});

// PUT /api/roles/:id/permissions — set permission matrix for a role
router.put('/:id/permissions', requirePermission('role.manage'), (req, res) => {
  const roleId = Number(req.params.id);
  const { permissionCodes } = req.body || {};
  if (!Array.isArray(permissionCodes)) return res.status(400).json({ error: 'permissionCodes must be an array.' });

  const role = Roles.byId(roleId);
  if (!role) return res.status(404).json({ error: 'Role not found.' });

  const before = Roles.permissionsForRole(roleId);
  const perms = Permissions.byCodes(permissionCodes);
  Roles.setPermissions(roleId, perms.map((p) => p.id));

  writeAudit(req, {
    action: 'role.permissions_changed', entityType: 'role', entityId: roleId,
    oldValue: { permissions: before }, newValue: { permissions: permissionCodes },
    comments: `Role ${role.code} permission set updated.`,
  });
  res.json({ ok: true, roleId, permissions: permissionCodes });
});

export default router;
