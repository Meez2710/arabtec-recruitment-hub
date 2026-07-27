import { verifyToken, loadUserContext } from '../lib/auth.js';
import { Sessions } from '../lib/models.js';

// Authenticates from Bearer token or httpOnly cookie; validates the session
// record (not revoked / not expired). RBAC is enforced server-side here.
export function requireAuth(req, res, next) {
  try {
    let token = null;
    const header = req.headers.authorization;
    if (header && header.startsWith('Bearer ')) token = header.slice(7);
    if (!token && req.cookies?.arabtec_token) token = req.cookies.arabtec_token;
    if (!token) return res.status(401).json({ error: 'Authentication required.' });

    let payload;
    try { payload = verifyToken(token); }
    catch { return res.status(401).json({ error: 'Invalid or expired token.' }); }

    const session = Sessions.byToken(token);
    if (!session || session.revoked_at || new Date(session.expires_at) < new Date()) {
      return res.status(401).json({ error: 'Session expired. Please log in again.' });
    }

    const ctx = loadUserContext(payload.sub);
    if (!ctx || ctx.status !== 'active') {
      return res.status(403).json({ error: 'Account inactive or not found.' });
    }
    req.user = ctx;
    req.sessionToken = token;

    // Forced-rotation gate. Placed here so it covers EVERY authenticated route
    // with no per-router wiring to forget. `code` lets the client show the
    // change-password screen instead of a generic error.
    if (passwordRotationBlocked(req)) {
      return res.status(403).json({
        error: 'Password change required',
        code: 'PASSWORD_CHANGE_REQUIRED',
      });
    }
    next();
  } catch (e) {
    console.error('Auth error:', e);
    res.status(500).json({ error: 'Authentication failure.' });
  }
}

// While a user carries must_change_password only these absolute routes stay
// reachable: read own identity, rotate the password, sign out. Matched against
// req.originalUrl so it does not depend on where a router is mounted — a newly
// added router cannot accidentally escape the gate.
const PASSWORD_ROTATION_ALLOWLIST = new Set([
  'GET /api/auth/me',
  'POST /api/auth/change-password',
  'POST /api/auth/logout',
]);

function passwordRotationBlocked(req) {
  if (!req.user || !req.user.mustChangePassword) return false;
  const path = String(req.originalUrl || '').split('?')[0].replace(/\/+$/, '') || '/';
  return !PASSWORD_ROTATION_ALLOWLIST.has(`${req.method} ${path}`);
}

export function requirePermission(...required) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
    const has = required.every((p) => req.user.permissions.includes(p));
    if (!has) {
      return res.status(403).json({ error: 'Insufficient permissions.', requiredPermissions: required });
    }
    next();
  };
}

export function requireAnyPermission(...anyOf) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
    const ok = anyOf.some((p) => req.user.permissions.includes(p));
    if (!ok) return res.status(403).json({ error: 'Insufficient permissions.', requiredAnyOf: anyOf });
    next();
  };
}
