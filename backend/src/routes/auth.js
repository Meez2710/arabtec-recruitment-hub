import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { Users, Sessions } from '../lib/models.js';
import { signToken, loadUserContext } from '../lib/auth.js';
import { requireAuth } from '../middleware/auth.js';
import { writeAudit } from '../lib/audit.js';

const router = Router();

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
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) {
    writeAudit({ ...req, user: { id: user.id, fullName: user.full_name } },
      { action: 'auth.login_failed', entityType: 'user', entityId: user.id, comments: 'Bad password' });
    return fail();
  }

  const token = signToken({ sub: user.id }, !!remember);
  const timeoutMin = remember ? 7 * 24 * 60 : 120;
  const expiresAt = new Date(Date.now() + timeoutMin * 60 * 1000).toISOString();
  Sessions.create({
    id: randomUUID(), userId: user.id, token, ip: req.ip,
    userAgent: req.headers['user-agent'] || null, expiresAt,
  });
  Users.touchLogin(user.id);

  const ctx = loadUserContext(user.id);
  writeAudit({ ...req, user: ctx }, { action: 'auth.login', entityType: 'user', entityId: user.id });

  res.cookie('arabtec_token', token, {
    httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production',
    maxAge: timeoutMin * 60 * 1000,
  });
  res.json({ token, user: ctx });
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
