// One way for a test suite to obtain a usable system_admin session.
//
// WHY THIS EXISTS. Two deliberate security controls made every suite's
// hand-rolled admin login stop working, and the suites were never updated:
//
//   1. The seed no longer ships a hardcoded default password. It uses
//      SEED_ADMIN_PASSWORD when given, otherwise a random one-time password
//      printed once. A suite that hardcodes a password gets 401.
//   2. The bootstrap admin carries must_change_password=1, and the auth
//      middleware blocks EVERY authenticated route except /auth/me,
//      /auth/change-password and /auth/logout until it is rotated. A suite that
//      logs in and goes straight to /api/users gets 403 — which reads exactly
//      like a missing permission but is not one.
//
// Both controls are correct and are not to be relaxed to make tests pass. The
// fixture is what was wrong: a real administrator rotates the bootstrap
// password at first login, so the suites must do the same.
//
// The session token survives the rotation (change-password revokes every OTHER
// session), so the token returned here is the one obtained at login.

export const ADMIN_EMAIL = 'admin@arabtec.com';

/** What the suites seed with. Test-only, and never a value the app defaults to. */
export const ADMIN_BOOTSTRAP_PASSWORD = 'Admin@12345';

/**
 * What the bootstrap password is rotated to, once, per test database. Must
 * satisfy the live password policy (12+ chars, mixed classes) — the rotation
 * endpoint enforces it, so a short value fails the whole suite.
 */
export const ADMIN_ROTATED_PASSWORD = 'Rotated#Aa12345';

const post = async (base, path, body, token) => {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* a non-JSON body is itself the finding */ }
  return { status: res.status, json };
};

/**
 * Sign in as the seeded system_admin and satisfy the forced first-login
 * rotation, returning a token that can reach protected routes.
 *
 * Safe to call more than once against the same database: after the first call
 * the bootstrap password no longer works, so the rotated one is used.
 *
 * @param {string} base   e.g. 'http://localhost:4120'
 * @param {{bootstrap?: string}} [opts]  overrides the seeded bootstrap password
 * @returns {Promise<string>} a bearer token for a fully unblocked admin
 */
export async function adminToken(base, opts = {}) {
  const bootstrap = opts.bootstrap
    ?? process.env.SEED_ADMIN_PASSWORD
    ?? ADMIN_BOOTSTRAP_PASSWORD;

  // The app holds every request with HTTP 503 until migrations and the seed
  // finish. On a cold CI database that readiness gate can still be closed when
  // the first suite calls in, which used to surface as an intermittent
  // "bootstrap attempt: HTTP 503" and fail the whole run. A 503 (or a refused
  // socket) here means "not ready yet", not "wrong password" — wait it out,
  // bounded to ~10s. Any other status is a real answer and breaks the loop.
  let login = { status: 0, json: null };
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      login = await post(base, '/api/auth/login', { email: ADMIN_EMAIL, password: bootstrap });
    } catch {
      login = { status: 0, json: null }; // server socket not accepting yet
    }
    if (login.status !== 503 && login.status !== 0) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  const bootstrapStatus = login.status;

  // Already rotated by an earlier call in this suite.
  if (login.status !== 200) {
    login = await post(base, '/api/auth/login', { email: ADMIN_EMAIL, password: ADMIN_ROTATED_PASSWORD });
  }
  if (login.status !== 200 || !login.json?.token) {
    // Say enough to diagnose this from a CI log alone. This has failed
    // intermittently across many suites at once, and the previous message —
    // just the second status — could not distinguish "wrong password" from
    // "account locked by an earlier assertion" from "seeded with a different
    // password", which are three different bugs with the same symptom.
    const locked = login.status === 423;
    const limited = login.status === 429;
    throw new Error(
      `admin login failed for ${ADMIN_EMAIL}.\n`
      + `  bootstrap attempt : HTTP ${bootstrapStatus}\n`
      + `  rotated attempt   : HTTP ${login.status}${login.json?.error ? ' — ' + login.json.error : ''}\n`
      + `  DATABASE_URL      : ${process.env.DATABASE_URL || '(unset — shared default file)'}\n`
      + `  SEED_ADMIN_PASSWORD set: ${process.env.SEED_ADMIN_PASSWORD ? 'yes' : 'NO'}\n`
      + (locked
        ? '  DIAGNOSIS: the account is LOCKED. An earlier assertion in this suite '
          + 'exhausted the failed-login threshold; the lockout outlives it.'
        : limited
          ? '  DIAGNOSIS: rate limited (>20 login attempts in 15 minutes from this IP).'
          : '  DIAGNOSIS: neither the bootstrap nor the rotated password matched, so '
            + 'this database was seeded with a third value, or a test changed the '
            + 'admin password and did not restore it.'),
    );
  }

  const token = login.json.token;
  if (!login.json.mustChangePassword) return token;

  const rotated = await post(base, '/api/auth/change-password', {
    currentPassword: bootstrap, newPassword: ADMIN_ROTATED_PASSWORD,
  }, token);
  if (rotated.status !== 200) {
    throw new Error(`admin password rotation failed (HTTP ${rotated.status}): ${rotated.json?.error}`);
  }
  return token;
}
