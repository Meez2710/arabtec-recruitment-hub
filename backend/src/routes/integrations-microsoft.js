// Microsoft 365 delegated mailbox integration — System Admin routes.
//
// EVERY route here is `system.manage`. Connecting a mailbox, revoking it, or
// pulling mail into the review queue is platform governance, not recruiting, so
// it sits behind the same permission as the rest of System Settings. The one
// exception in shape (not in authority) is the OAuth callback, which is a
// browser navigation from Microsoft rather than an API call from the SPA — see
// the note on it below.
//
// NOTHING here returns a token, a refresh token, the client secret, or the
// encryption key. The status object is assembled by connection-store.js, which
// is the only module that can see the token column at all.

import { Router } from 'express';

import { requireAuth, requirePermission } from '../middleware/auth.js';
import { writeAudit } from '../lib/audit.js';
import {
  configuredMailbox, isConfigured, missingConfig, microsoftConfig, AUTH_SCOPES,
} from '../lib/microsoft/config.js';
import { hasEncryptionKey } from '../lib/microsoft/crypto.js';
import {
  clearConnection, connectionStatus, connectionRow, recentIngestions, saveConnection, STATUS,
} from '../lib/microsoft/connection-store.js';
import { consumeState, issueState } from '../lib/microsoft/oauth-state.js';
import {
  buildAuthCodeUrl, exchangeCodeForAccount, acquireGraphToken, classify,
  MicrosoftAuthError, CODES, RECONNECT_MESSAGE,
} from '../lib/microsoft/msal-client.js';
import { inboxProbe } from '../lib/microsoft/graph.js';
import { runMailboxSync, isSyncRunning } from '../lib/microsoft/mailbox-sync.js';

const router = Router();

/** Where the SPA's Microsoft settings panel lives, for post-callback redirects. */
const SETTINGS_PATH = '/#microsoft';

const adminOnly = [requireAuth, requirePermission('system.manage')];

/** The environment half of the status: wired or not, and what is missing. */
function configState() {
  const missing = [...missingConfig()];
  if (!hasEncryptionKey()) missing.push('MICROSOFT_TOKEN_ENCRYPTION_KEY');
  return {
    configured: isConfigured() && hasEncryptionKey(),
    // NAMES ONLY. Never a value, never a partial value.
    missing,
    mailbox: configuredMailbox(),
    redirectUri: microsoftConfig().redirectUri || null,
    scopes: [...AUTH_SCOPES],
  };
}

/* --------------------------------- status --------------------------------- */

router.get('/status', ...adminOnly, (req, res) => {
  const config = configState();
  const connection = connectionStatus();
  res.json({
    provider: 'microsoft',
    ...config,
    ...connection,
    // The configured mailbox always wins for display: before anyone connects
    // there is no connected mailbox, and the panel still has to say which one
    // the administrator is expected to sign in as.
    mailbox: connection.mailbox || config.mailbox,
    syncRunning: isSyncRunning(),
    recentIngestions: recentIngestions(10),
  });
});

/* --------------------------------- connect -------------------------------- */

/**
 * Build the Microsoft sign-in URL.
 *
 * Returns JSON rather than a 302 because the SPA authenticates with a Bearer
 * token from localStorage — a plain link or a server redirect would arrive
 * unauthenticated. The client assigns `authUrl` to window.location, which is
 * the top-level navigation Microsoft needs.
 */
async function connect(req, res) {
  const config = configState();
  if (!config.configured) {
    return res.status(400).json({
      error: `Microsoft 365 integration is not configured. Set: ${config.missing.join(', ')}.`,
      code: CODES.NOT_CONFIGURED, missing: config.missing,
    });
  }
  try {
    const state = issueState({
      userId: req.user.id,
      sessionToken: req.sessionToken || null,
      redirectUri: microsoftConfig().redirectUri,
    });
    const authUrl = await buildAuthCodeUrl({ state });
    writeAudit(req, {
      action: 'microsoft.connect_started', entityType: 'integration', entityId: 'microsoft',
      newValue: { mailbox: config.mailbox },
    });
    res.json({ authUrl, mailbox: config.mailbox, scopes: config.scopes });
  } catch (e) {
    const error = classify(e);
    console.error(JSON.stringify({ level: 'error', msg: 'microsoft.connect.failed', code: error.code, error: error.message }));
    res.status(502).json({ error: error.message, code: error.code });
  }
}

router.get('/connect', ...adminOnly, connect);
router.post('/connect', ...adminOnly, connect);

/* -------------------------------- callback -------------------------------- */

/**
 * Microsoft redirects the administrator's browser here with `code` and `state`.
 *
 * AUTHORIZATION COMES FROM THE STATE. This is a cross-site top-level navigation,
 * so it cannot carry an Authorization header; the app's session cookie is
 * SameSite=Lax and normally does arrive, and when it does the state must match
 * the session that started the flow. The state itself is 32 random bytes, stored
 * hashed, single-use and valid for ten minutes, issued only to an authenticated
 * System Admin — it is the credential, and consumeState() enforces all of that.
 *
 * Everything here redirects rather than returning JSON: the audience is a
 * browser mid-navigation, not the SPA's fetch client.
 */
router.get('/callback', async (req, res) => {
  const back = (params) => res.redirect(`${SETTINGS_PATH}?${new URLSearchParams(params).toString()}`);

  // Microsoft reports a refused consent on the redirect itself, before any code
  // exists. Say so plainly instead of failing on a missing `code`.
  if (req.query.error) {
    const code = String(req.query.error);
    console.warn(JSON.stringify({ level: 'warn', msg: 'microsoft.callback.provider_error', error: code }));
    return back({
      microsoft: 'error',
      code: /access_denied|consent_required/i.test(code) ? CODES.CONSENT_DENIED : CODES.UNEXPECTED,
    });
  }

  const stateResult = consumeState(req.query.state, {
    sessionToken: req.headers.authorization?.startsWith('Bearer ')
      ? req.headers.authorization.slice(7)
      : req.cookies?.arabtec_token || null,
  });
  if (!stateResult.ok) {
    console.warn(JSON.stringify({ level: 'warn', msg: 'microsoft.callback.bad_state', reason: stateResult.reason }));
    return back({ microsoft: 'error', code: 'invalid-state', reason: stateResult.reason });
  }
  const actorId = stateResult.userId;

  if (!req.query.code) return back({ microsoft: 'error', code: 'missing-code' });

  try {
    // Into a STAGING cache: the account is checked before anything is stored.
    const { account, serializedCache } = await exchangeCodeForAccount({
      code: String(req.query.code), state: String(req.query.state),
    });

    const cfg = microsoftConfig();
    const signedInAs = String(account.username || '').toLowerCase();
    const expected = configuredMailbox();

    // Case-insensitive: a GUID's spelling is, and MSAL returns the tenant id
    // lower-cased while an operator may well paste it from Entra in upper case.
    // A strict compare rejected the CORRECT directory as wrong-tenant.
    const tenantMatches = !cfg.tenantId || !account.tenantId
      || String(account.tenantId).toLowerCase() === String(cfg.tenantId).toLowerCase();
    if (!tenantMatches) {
      auditRejection(req, actorId, 'wrong-tenant', signedInAs);
      return back({ microsoft: 'error', code: CODES.WRONG_TENANT });
    }
    if (signedInAs !== expected) {
      // The staged cache is simply discarded — the wrong account's refresh
      // token was never written anywhere.
      auditRejection(req, actorId, 'wrong-account', signedInAs);
      return back({ microsoft: 'error', code: CODES.WRONG_ACCOUNT, expected });
    }
    if (!serializedCache) {
      return back({ microsoft: 'error', code: CODES.TOKEN_CACHE_MISSING });
    }

    saveConnection({
      mailbox: signedInAs,
      tenantId: account.tenantId || cfg.tenantId,
      homeAccountId: account.homeAccountId,
      serializedCache,
      actorId,
    });

    writeAudit({ user: { id: actorId }, ip: req.ip, headers: req.headers }, {
      action: 'microsoft.connected', entityType: 'integration', entityId: 'microsoft',
      newValue: { mailbox: signedInAs, tenantId: account.tenantId || cfg.tenantId },
    });
    console.log(JSON.stringify({ level: 'info', msg: 'microsoft.connected', mailbox: signedInAs }));
    return back({ microsoft: 'connected' });
  } catch (e) {
    const error = classify(e);
    console.error(JSON.stringify({ level: 'error', msg: 'microsoft.callback.failed', code: error.code, error: error.message }));
    return back({ microsoft: 'error', code: error.code });
  }
});

function auditRejection(req, actorId, code, signedInAs) {
  console.warn(JSON.stringify({ level: 'warn', msg: 'microsoft.callback.rejected', code }));
  try {
    writeAudit({ user: { id: actorId }, ip: req.ip, headers: req.headers }, {
      action: 'microsoft.connect_rejected', entityType: 'integration', entityId: 'microsoft',
      newValue: { reason: code, signedInAs },
    });
  } catch { /* the rejection still stands */ }
}

/* ------------------------------- disconnect ------------------------------- */

router.post('/disconnect', ...adminOnly, (req, res) => {
  const before = connectionStatus();
  const after = clearConnection(req.user.id);
  writeAudit(req, {
    action: 'microsoft.disconnected', entityType: 'integration', entityId: 'microsoft',
    oldValue: { mailbox: before.mailbox, status: before.status }, newValue: { status: after.status },
  });
  res.json({ ...after, message: 'Microsoft 365 has been disconnected. Stored tokens were removed.' });
});

/* ---------------------------------- test ---------------------------------- */

router.post('/test', ...adminOnly, async (req, res) => {
  const config = configState();
  if (!config.configured) {
    return res.status(400).json({
      ok: false, code: CODES.NOT_CONFIGURED,
      error: `Microsoft 365 integration is not configured. Set: ${config.missing.join(', ')}.`,
    });
  }
  const row = connectionRow();
  if (!row || row.status === STATUS.DISCONNECTED || !row.home_account_id) {
    return res.status(400).json({ ok: false, code: CODES.NOT_CONNECTED, error: 'Microsoft 365 is not connected yet.' });
  }
  try {
    // The identity comes from the MSAL account, NOT from Graph /me. The
    // least-privileged permission for /me is User.Read, which this integration
    // deliberately does not request — so calling it would 403 on a correctly
    // configured tenant and this route would report "sign in again" for a
    // connection that is actually healthy. The account on the token already
    // carries the username, and /me/mailFolders/inbox proves Mail.Read reaches
    // this mailbox, which is the thing worth testing.
    const { accessToken, account } = await acquireGraphToken();
    const inbox = await inboxProbe({ accessToken });
    const signedInAs = String(account?.username || '').toLowerCase();
    const expected = configuredMailbox();
    if (signedInAs && signedInAs !== expected) {
      writeAudit(req, {
        action: 'microsoft.test', entityType: 'integration', entityId: 'microsoft',
        comments: `connected account is ${signedInAs}, expected ${expected}`,
      });
      return res.status(409).json({
        ok: false, code: CODES.WRONG_ACCOUNT,
        error: `The connected account is ${signedInAs}, not ${expected}. Disconnect and reconnect as ${expected}.`,
      });
    }
    writeAudit(req, { action: 'microsoft.test', entityType: 'integration', entityId: 'microsoft', comments: 'ok' });
    res.json({
      ok: true,
      message: `Connected to ${signedInAs || expected}. Inbox reachable.`,
      mailbox: signedInAs || expected,
      inbox: { displayName: inbox?.displayName ?? null, totalItemCount: inbox?.totalItemCount ?? null },
    });
  } catch (e) {
    const error = e instanceof MicrosoftAuthError ? e : classify(e);
    writeAudit(req, { action: 'microsoft.test', entityType: 'integration', entityId: 'microsoft', comments: error.code });
    const status = error.code === CODES.RECONNECT_REQUIRED ? 409 : 502;
    res.status(status).json({
      ok: false, code: error.code,
      error: error.code === CODES.RECONNECT_REQUIRED ? RECONNECT_MESSAGE : error.message,
    });
  }
});

/* ---------------------------------- sync ---------------------------------- */

router.post('/sync', ...adminOnly, async (req, res) => {
  if (isSyncRunning()) {
    return res.status(409).json({ ok: false, code: 'already-running', error: 'A mailbox scan is already in progress.' });
  }
  const result = await runMailboxSync({ actor: req.user, req });
  if (!result.ok) {
    const status = result.code === CODES.RECONNECT_REQUIRED ? 409
      : result.code === 'already-running' ? 409
      : result.code === CODES.NOT_CONNECTED ? 400 : 502;
    return res.status(status).json(result);
  }
  res.json(result);
});

export default router;
