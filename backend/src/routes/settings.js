import { Router } from 'express';
import {
  Branding, Buttons, Workflows, SystemSettings,
} from '../lib/models.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { writeAudit } from '../lib/audit.js';

const router = Router();

// ---------------- Branding ----------------
// Public: the login screen themes itself (colors, company name, logo) before
// auth. Returns only presentational branding tokens — nothing sensitive.
router.get('/branding', (req, res) => res.json({ branding: Branding.all() }));

router.put('/branding', requireAuth, requirePermission('branding.manage'), (req, res) => {
  const updates = req.body?.branding || {};
  const before = Branding.all();
  for (const [key, value] of Object.entries(updates)) Branding.upsert(key, value);
  const after = Branding.all();
  writeAudit(req, { action: 'branding.changed', entityType: 'branding', entityId: 'global', oldValue: before, newValue: after });
  res.json({ branding: after });
});

// ---------------- Buttons ----------------
function buttonOut(b) {
  return {
    id: b.id, buttonKey: b.button_key, label: b.label, screen: b.screen,
    visible: b.visible === 1, enabled: b.enabled === 1,
    requiredPermission: b.required_permission,
    allowedRoles: b.allowed_roles ? JSON.parse(b.allowed_roles) : null,
    confirmRequired: b.confirm_required === 1, reasonRequired: b.reason_required === 1,
    auditRequired: b.audit_required === 1, variant: b.variant,
  };
}

router.get('/buttons', requireAuth, (req, res) => {
  res.json({ buttons: Buttons.all().map(buttonOut) });
});

// Resolve buttons for current user (RBAC + config enforced in logic).
router.get('/buttons/resolved', requireAuth, (req, res) => {
  const userPerms = new Set(req.user.permissions);
  const userRoles = new Set(req.user.roles);
  const resolved = Buttons.all().map((raw) => {
    const b = buttonOut(raw);
    const hasPerm = !b.requiredPermission || userPerms.has(b.requiredPermission);
    const roleOk = !b.allowedRoles || b.allowedRoles.some((r) => userRoles.has(r));
    const canSee = b.visible && hasPerm && roleOk;
    return {
      buttonKey: b.buttonKey, label: b.label, screen: b.screen, variant: b.variant,
      visible: canSee, enabled: canSee && b.enabled,
      confirmRequired: b.confirmRequired, reasonRequired: b.reasonRequired, auditRequired: b.auditRequired,
    };
  });
  res.json({ buttons: resolved });
});

router.put('/buttons/:key', requireAuth, requirePermission('button.manage'), (req, res) => {
  const { key } = req.params;
  const before = Buttons.byKey(key);
  if (!before) return res.status(404).json({ error: 'Button not found.' });
  const updated = Buttons.update(key, req.body || {});
  writeAudit(req, { action: 'button.setting_changed', entityType: 'button', entityId: key, oldValue: buttonOut(before), newValue: buttonOut(updated) });
  res.json({ button: buttonOut(updated) });
});

// ---------------- Workflows ----------------
function workflowOut(w) { return { id: w.id, key: w.key, name: w.name, value: JSON.parse(w.value), isActive: w.is_active === 1 }; }

router.get('/workflows', requireAuth, (req, res) => {
  res.json({ workflows: Workflows.all().map(workflowOut) });
});

router.put('/workflows/:key', requireAuth, requirePermission('workflow.manage'), (req, res) => {
  const { key } = req.params;
  const before = Workflows.byKey(key);
  if (!before) return res.status(404).json({ error: 'Workflow setting not found.' });
  const updated = Workflows.update(key, req.body || {});
  writeAudit(req, { action: 'workflow.setting_changed', entityType: 'workflow', entityId: key, oldValue: workflowOut(before), newValue: workflowOut(updated) });
  res.json({ workflow: workflowOut(updated) });
});

// ---------------- System ----------------
router.get('/system', requireAuth, (req, res) => res.json({ settings: SystemSettings.all() }));

router.put('/system', requireAuth, requirePermission('system.manage'), (req, res) => {
  const updates = req.body?.settings || {};
  const before = SystemSettings.all();
  for (const [key, value] of Object.entries(updates)) SystemSettings.upsert(key, value);
  const after = SystemSettings.all();
  writeAudit(req, { action: 'system.setting_changed', entityType: 'system', entityId: 'global', oldValue: before, newValue: after });
  res.json({ settings: after });
});

export default router;
