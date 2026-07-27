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

  // ---- Privilege-escalation guard -----------------------------------------
  // Platform-governance permissions may only ever live on system_admin. Without
  // this, anyone holding role.manage could grant user.manage to hr_director (or
  // any other role) through the Roles & Permissions screen and take over account
  // administration — exactly the escalation path we are closing.
  const GOVERNANCE_PERMS = ['user.manage', 'role.manage', 'app.manage_ui', 'system.manage'];
  if (role.code !== 'system_admin') {
    const escalated = permissionCodes.filter((c) => GOVERNANCE_PERMS.includes(c));
    if (escalated.length) {
      return res.status(403).json({
        error: `These permissions are reserved for System Admin and cannot be granted to "${role.name}": ${escalated.join(', ')}.`,
        code: 'GOVERNANCE_PERMISSION_RESERVED',
        reserved: escalated,
      });
    }
  } else {
    // Conversely, system_admin must not be stripped of the ability to manage users.
    const missing = GOVERNANCE_PERMS.filter((c) => !permissionCodes.includes(c));
    if (missing.length) {
      return res.status(409).json({
        error: `System Admin must retain: ${missing.join(', ')}.`,
        code: 'GOVERNANCE_PERMISSION_REQUIRED',
      });
    }
  }

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
