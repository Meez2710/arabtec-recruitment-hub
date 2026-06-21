import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { Users, UserRoles, UserScopes, Sessions, Audit } from '../lib/models.js';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { writeAudit } from '../lib/audit.js';

const router = Router();
router.use(requireAuth);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PWD_MIN = 8;

function serializeUser(u) {
  if (!u) return null;
  const roles = UserRoles.forUser(u.id);
  const scopes = UserScopes.forUser(u.id);
  return {
    id: u.id, employeeNo: u.employee_no, fullName: u.full_name, email: u.email,
    phone: u.phone, jobTitle: u.job_title, status: u.status, departmentId: u.department_id,
    roles, // [{code,name}]
    projectScopes: scopes.filter((s) => s.scope_type === 'project').map((s) => s.project_id),
    siteScopes: scopes.filter((s) => s.scope_type === 'site').map((s) => s.site_id),
    isGlobalScope: scopes.some((s) => s.scope_type === 'global'),
    lastLoginAt: u.last_login_at, createdAt: u.created_at,
  };
}

function applyAssignments(userId, { roleCodes, projectIds, siteIds, globalScope }) {
  if (Array.isArray(roleCodes)) UserRoles.set(userId, roleCodes);
  if (Array.isArray(projectIds) || Array.isArray(siteIds) || typeof globalScope === 'boolean') {
    UserScopes.set(userId, {
      globalScope: !!globalScope,
      projectIds: (projectIds || []).map(Number),
      siteIds: (siteIds || []).map(Number),
    });
  }
}

router.get('/', requirePermission('user.manage'), (req, res) => {
  const users = Users.list({ q: req.query.q, status: req.query.status });
  res.json({ users: users.map(serializeUser) });
});

router.get('/:id', requirePermission('user.manage'), (req, res) => {
  const u = Users.byId(Number(req.params.id));
  if (!u) return res.status(404).json({ error: 'User not found.' });
  res.json({ user: serializeUser(u) });
});

router.get('/:id/activity', requirePermission('user.manage'), (req, res) => {
  const logs = Audit.forActor(Number(req.params.id), 100).map((l) => ({
    ...l,
    oldValue: l.old_value ? JSON.parse(l.old_value) : null,
    newValue: l.new_value ? JSON.parse(l.new_value) : null,
  }));
  res.json({ activity: logs });
});

router.post('/', requirePermission('user.manage'), async (req, res) => {
  const { fullName, email, phone, jobTitle, employeeNo, departmentId,
    roleCodes, projectIds, siteIds, globalScope, password } = req.body || {};

  if (!fullName || !email) return res.status(400).json({ error: 'Full name and email are required.' });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Invalid email format.' });
  if (Users.byEmail(email.toLowerCase().trim())) return res.status(409).json({ error: 'A user with this email already exists.' });

  const initialPassword = password || 'Arabtec@123';
  if (initialPassword.length < PWD_MIN) return res.status(400).json({ error: `Password must be at least ${PWD_MIN} characters.` });

  const rounds = parseInt(process.env.BCRYPT_ROUNDS || '10', 10);
  const passwordHash = await bcrypt.hash(initialPassword, rounds);

  const created = Users.create({
    fullName, email: email.toLowerCase().trim(), phone, jobTitle,
    employeeNo: employeeNo || null, departmentId: departmentId ? Number(departmentId) : null,
    passwordHash, status: 'active',
  });
  applyAssignments(created.id, { roleCodes, projectIds, siteIds, globalScope });

  const out = serializeUser(Users.byId(created.id));
  writeAudit(req, { action: 'user.created', entityType: 'user', entityId: created.id, newValue: out });
  res.status(201).json({ user: out });
});

router.put('/:id', requirePermission('user.manage'), (req, res) => {
  const id = Number(req.params.id);
  const before = Users.byId(id);
  if (!before) return res.status(404).json({ error: 'User not found.' });

  const { fullName, email, phone, jobTitle, employeeNo, departmentId,
    roleCodes, projectIds, siteIds, globalScope } = req.body || {};
  if (email && !EMAIL_RE.test(email)) return res.status(400).json({ error: 'Invalid email format.' });
  if (email && email.toLowerCase().trim() !== before.email) {
    if (Users.byEmail(email.toLowerCase().trim())) return res.status(409).json({ error: 'Email already in use.' });
  }
  const beforeOut = serializeUser(before);
  Users.update(id, {
    fullName, email: email ? email.toLowerCase().trim() : undefined, phone, jobTitle, employeeNo,
    departmentId: departmentId !== undefined ? (departmentId ? Number(departmentId) : null) : undefined,
  });
  applyAssignments(id, { roleCodes, projectIds, siteIds, globalScope });

  const afterOut = serializeUser(Users.byId(id));
  writeAudit(req, { action: 'user.updated', entityType: 'user', entityId: id, oldValue: beforeOut, newValue: afterOut });
  res.json({ user: afterOut });
});

router.post('/:id/activate', requirePermission('user.manage'), (req, res) => {
  const id = Number(req.params.id);
  Users.setStatus(id, 'active');
  writeAudit(req, { action: 'user.activated', entityType: 'user', entityId: id });
  res.json({ ok: true, status: 'active' });
});

router.post('/:id/deactivate', requirePermission('user.manage'), (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: 'You cannot deactivate your own account.' });
  Users.setStatus(id, 'inactive');
  Sessions.revokeForUser(id); // revoke active sessions on deactivation
  writeAudit(req, { action: 'user.deactivated', entityType: 'user', entityId: id });
  res.json({ ok: true, status: 'inactive' });
});

router.post('/:id/reset-password', requirePermission('user.manage'), async (req, res) => {
  const id = Number(req.params.id);
  const pwd = (req.body || {}).newPassword || 'Arabtec@123';
  if (pwd.length < PWD_MIN) return res.status(400).json({ error: `Password must be at least ${PWD_MIN} characters.` });
  const rounds = parseInt(process.env.BCRYPT_ROUNDS || '10', 10);
  Users.setPassword(id, await bcrypt.hash(pwd, rounds));
  Sessions.revokeForUser(id); // force re-login after reset
  writeAudit(req, { action: 'user.password_reset', entityType: 'user', entityId: id });
  res.json({ ok: true, message: 'Password reset. The user must log in again.' });
});

export default router;
