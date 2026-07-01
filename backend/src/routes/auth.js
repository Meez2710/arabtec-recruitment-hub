import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { Users, Sessions, SystemSettings } from '../lib/models.js';
import { signToken, loadUserContext } from '../lib/auth.js';
import { requireAuth } from '../middleware/auth.js';
import { writeAudit } from '../lib/audit.js';
import { validatePassword } from '../lib/passwords.js';

const router = Router();

// Account-lockout config (C1.3). Tunable via env; safe defaults.
const LOCK_THRESHOLD = Number(process.env.LOGIN_LOCK_THRESHOLD || 5);
const LOCK_MINUTES = Number(process.env.LOGIN_LOCK_MINUTES || 15);

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { email, password, remember } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });

  const user = Users.byEmail(String(email).toLowerCase().trim());
  const fail = () => res.status(401).json({ error: 'Invalid email or password.' });

  if (!user) {
    writeAudit(req, { action: 'auth.login_failed', entityType: 'user', comments: `Unknown email: ${email}` });
    return fail();
  }
  if (user.status !== 'active') {
    writeAudit({ ...req, user: { id: user.id, fullName: user.full_name } },
      { action: 'auth.login_blocked', entityType: 'user', entityId: user.id, comments: 'Inactive account' });
    return res.status(403).json({ error: 'Account is inactive. Contact your administrator.' });
  }
  // Account lockout: refuse before checking the password if currently locked.
  const lockMs = Users.lockRemainingMs(user);
  if (lockMs > 0) {
    writeAudit({ ...req, user: { id: user.id, fullName: user.full_name } },
      { action: 'auth.login_blocked', entityType: 'user', entityId: user.id, comments: 'Account locked' });
    return res.status(423).json({ error: `Account locked. Try again in ${Math.ceil(lockMs / 60000)} minute(s).` });
  }
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) {
    const r = Users.recordFailedLogin(user.id, { threshold: LOCK_THRESHOLD, lockMinutes: LOCK_MINUTES });
    writeAudit({ ...req, user: { id: user.id, fullName: user.full_name } },
      { action: r.locked ? 'auth.account_locked' : 'auth.login_failed', entityType: 'user', entityId: user.id,
        comments: r.locked ? `Locked after ${r.count} failed attempts` : 'Bad password' });
    if (r.locked) return res.status(423).json({ error: `Too many failed attempts. Account locked for ${LOCK_MINUTES} minutes.` });
    return fail();
  }
  // Success → clear any failed-attempt / lock state.
  Users.clearFailedLogins(user.id);

  const token = signToken({ sub: user.id }, !!remember);
  const timeoutMin = remember ? 7 * 24 * 60 : 120;
  const expiresAt = new Date(Date.now() + timeoutMin * 60 * 1000).toISOString();
  Sessions.create({
    id: randomUUID(), userId: user.id, token, ip: req.ip,
    userAgent: req.headers['user-agent'] || null, expiresAt,
  });
  Users.touchLogin(user.id);

  const ctx = loadUserContext(user.id);
  // Surface the forced-rotation flag so the client can require a password change
  // before allowing any other action. (RBAC/session are unchanged.)
  ctx.mustChangePassword = !!user.must_change_password;
  writeAudit({ ...req, user: ctx }, { action: 'auth.login', entityType: 'user', entityId: user.id });

  res.cookie('arabtec_token', token, {
    httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production',
    maxAge: timeoutMin * 60 * 1000,
  });
  res.json({ token, user: ctx, mustChangePassword: ctx.mustChangePassword });
});

// POST /api/auth/change-password — authenticated self-service change.
// Verifies the current password, enforces a minimum strength, sets the new hash,
// and clears must_change_password. This is what satisfies the first-login rotation.
router.post('/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Current and new password are required.' });
  }
  const minLen = Number(SystemSettings?.get?.('password_min_length') || 8) || 8;
  const policy = validatePassword(newPassword, { minLength: minLen });
  if (!policy.ok) return res.status(400).json({ error: policy.error });
  if (newPassword === currentPassword) {
    return res.status(400).json({ error: 'New password must be different from the current one.' });
  }
  const user = Users.byId(req.user.id);
  const ok = await bcrypt.compare(currentPassword, user.password_hash);
  if (!ok) {
    writeAudit(req, { action: 'auth.password_change_failed', entityType: 'user', entityId: user.id, comments: 'Wrong current password' });
    return res.status(401).json({ error: 'Current password is incorrect.' });
  }
  const rounds = Number(process.env.BCRYPT_ROUNDS || 10);
  Users.setPassword(user.id, await bcrypt.hash(newPassword, rounds));
  // Invalidate other sessions on password change (defense in depth); keep current.
  Sessions.revokeAllForUserExcept?.(user.id, req.sessionToken);
  writeAudit(req, { action: 'auth.password_changed', entityType: 'user', entityId: user.id });
  res.json({ ok: true, mustChangePassword: false });
});

// POST /api/auth/logout
router.post('/logout', requireAuth, (req, res) => {
  Sessions.revoke(req.sessionToken);
  writeAudit(req, { action: 'auth.logout', entityType: 'user', entityId: req.user.id });
  res.clearCookie('arabtec_token');
  res.json({ ok: true });
});

// GET /api/auth/me
router.get('/me', requireAuth, (req, res) => res.json({ user: req.user }));

// POST /api/auth/forgot-password — placeholder (no email system in Phase 1)
router.post('/forgot-password', (req, res) => {
  const { email } = req.body || {};
  writeAudit(req, { action: 'auth.forgot_password_requested', entityType: 'user', comments: email });
  res.json({
    ok: true,
    message: 'If an account exists for this email, a reset link would be sent. '
      + '(Email delivery is not configured in Phase 1; an administrator can reset the password.)',
  });
});

// POST /api/auth/reset-password — placeholder
router.post('/reset-password', (req, res) => {
  res.status(501).json({
    error: 'Self-service password reset is not enabled in Phase 1. '
      + 'Please ask a System Admin to reset your password from User Management.',
  });
});

export default router;
