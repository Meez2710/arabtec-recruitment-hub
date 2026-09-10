// Microsoft 365 delegated-mailbox integration — configuration.
//
// ONE MAILBOX, DELEGATED, USER-CONSENTED. This integration replaces the
// app-only (client-credentials) design that lived in deploy/on-prem/mailbox/.
// That design needed tenant-wide Application `Mail.Read`, an Exchange
// application access policy to scope it back down, and PowerShell to install
// that policy. This one needs one human to sign in once and consent for
// themselves. Nothing tenant-wide is granted.
//
// INTAKE ONLY BY DEFAULT. The scopes requested are `Mail.Read` (or
// `Mail.Read.Shared`) plus `offline_access`. No `Mail.Send`, no
// `Mail.ReadWrite`, no `.default`, no directory scope. See authScopes().
//
// Configuration (environment; secrets NEVER in the database and never logged):
//   MS_TENANT_ID    Directory (tenant) ID of the Arabtec Microsoft 365 tenant
//   MS_CLIENT_ID    Application (client) ID of the Entra app registration
//   MS_MAILBOX      career@arabtecegy.com — the ONLY mailbox this may read
//   MICROSOFT_TOKEN_ENCRYPTION_KEY  32 bytes (64 hex chars or base64) — AES-256-GCM
//                   key for the MSAL token cache at rest
//
//   MS_AUTH_MODE        device-code (default without a secret) | auth-code
//   MS_MAILBOX_ACCESS   own (default) | shared      — see mailboxAccess()
//   MS_ENABLE_SEND      false (default) | true      — see sendEnabled()
//
//   MS_CLIENT_SECRET  auth-code mode ONLY. A device-code public client must not
//                     have one, and Entra rejects a secret from a public client.
//   MS_REDIRECT_URI   auth-code mode ONLY.
//
// New names on purpose. The retired connector used MB_* for a different auth
// model with different semantics (`MB_MAILBOX` was a mailbox the app read
// through tenant-wide permission; `MS_MAILBOX` is the mailbox a delegated token
// is allowed to reach). Reusing MB_* would let a half-migrated host silently
// keep the old meaning.

export const MICROSOFT_PROVIDER = 'microsoft';

/** The mailbox this integration exists for, when MS_MAILBOX is unset. */
export const DEFAULT_MAILBOX = 'career@arabtecegy.com';

/**
 * How the one-time sign-in is performed.
 *
 * `device-code`  — MSAL PublicClientApplication + acquireTokenByDeviceCode. The
 *                  operator opens microsoft.com/devicelogin on their own machine
 *                  and types a short code. NO client secret and NO public HTTPS
 *                  callback, which is what makes this installable on an
 *                  internal-only host like 10.20.0.9 with no certificate, no DNS
 *                  name and no reverse-proxy work.
 * `auth-code`    — the original ConfidentialClientApplication browser redirect.
 *                  Needs MS_CLIENT_SECRET and a registered redirect URI.
 *
 * The default is inferred rather than assumed: a client secret is the one thing
 * the confidential flow requires and the public client must NOT have, so its
 * presence is an honest signal of which registration this host was given.
 */
export const AUTH_MODES = Object.freeze({ DEVICE_CODE: 'device-code', AUTH_CODE: 'auth-code' });

export function authMode() {
  const explicit = (process.env.MS_AUTH_MODE || '').trim().toLowerCase();
  if (explicit === AUTH_MODES.DEVICE_CODE || explicit === AUTH_MODES.AUTH_CODE) return explicit;
  return (process.env.MS_CLIENT_SECRET || '').trim() ? AUTH_MODES.AUTH_CODE : AUTH_MODES.DEVICE_CODE;
}

export const isDeviceCodeMode = () => authMode() === AUTH_MODES.DEVICE_CODE;

/**
 * Whose mailbox the signed-in account is reading.
 *
 * `own`     — the account that signs in IS career@arabtecegy.com. Graph reads
 *             `/me`, and delegated `Mail.Read` reaches exactly one mailbox: its
 *             own. This is the tightest arrangement available.
 * `shared`  — career@arabtecegy.com is a shared mailbox that cannot sign in, so
 *             an already-authorized human signs in as THEMSELVES and Graph reads
 *             `/users/career@arabtecegy.com`. That crossing of an account
 *             boundary is exactly what `Mail.Read.Shared` governs, and it is the
 *             only reason to request the wider scope.
 *
 * READ THE SCOPE HONESTLY. Neither scope is "one mailbox" by itself:
 * delegated `Mail.Read` means "mail in the signed-in user's mailbox", and
 * `Mail.Read.Shared` additionally means "and any mailbox that user has been
 * granted access to". A single-tenant app registration restricts WHICH
 * DIRECTORY may sign in — it says nothing at all about how many mailboxes the
 * resulting token can reach. The confinement to career@arabtecegy.com is
 * enforced here, by this application: `mailboxRoot()` names one mailbox and
 * `assertMailbox()` refuses a token issued for any other account.
 */
export function mailboxAccess() {
  return (process.env.MS_MAILBOX_ACCESS || '').trim().toLowerCase() === 'shared' ? 'shared' : 'own';
}

/**
 * Outgoing mail is OFF unless explicitly enabled.
 *
 * This integration exists to pull CVs in. `Mail.Send` is not needed for that,
 * so it is not requested, and consenting to a permission an intake job never
 * uses is a standing risk with no matching benefit. Set MS_ENABLE_SEND=true
 * only when the ATS is also meant to send recruitment mail as this mailbox —
 * and note that mailer.js refuses to select Graph while this is false, so a
 * read-only grant cannot produce a 403 on every notification.
 */
export const sendEnabled = () => (process.env.MS_ENABLE_SEND || '').trim().toLowerCase() === 'true';

/** `Mail.Read` for one's own mailbox; `Mail.Read.Shared` to cross into another. */
export function mailReadScope() {
  return mailboxAccess() === 'shared'
    ? 'https://graph.microsoft.com/Mail.Read.Shared'
    : 'https://graph.microsoft.com/Mail.Read';
}

/**
 * Scopes sent to Microsoft at consent time.
 *
 * DELEGATED ONLY, and deliberately short. There is no `.default`, no
 * `Mail.ReadWrite`, and no directory scope: the ATS never marks a message read,
 * never moves one and never creates a folder, so it never asks for the right
 * to. De-duplication is the ATS database's job instead (mailbox_ingestion).
 *
 * `openid` and `profile` are OIDC sign-in scopes, not Graph mail permissions.
 * They are requested because MSAL needs an account identity to return, and that
 * identity is precisely what lets this code prove the right mailbox signed in.
 */
export function authScopes() {
  const scopes = ['openid', 'profile', 'offline_access', mailReadScope()];
  if (sendEnabled()) scopes.push('https://graph.microsoft.com/Mail.Send');
  return Object.freeze(scopes);
}

/**
 * Resource scopes for silent acquisition. MSAL adds the OIDC scopes itself; a
 * silent request matches on the resource scopes actually needed for the call.
 */
export function graphScopes() {
  const scopes = [mailReadScope()];
  if (sendEnabled()) scopes.push('https://graph.microsoft.com/Mail.Send');
  return Object.freeze(scopes);
}

const trimmed = (name) => {
  const value = process.env[name];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : '';
};

/** The configured mailbox, lower-cased for comparison. Never empty. */
export function configuredMailbox() {
  return (trimmed('MS_MAILBOX') || DEFAULT_MAILBOX).toLowerCase();
}

/**
 * The OAuth redirect URI Microsoft calls back on.
 *
 * MS_REDIRECT_URI wins. Otherwise it is derived from the first CORS_ORIGINS
 * entry, which the on-prem deployment already sets to "the exact URL staff
 * type" (deploy/on-prem/ats.env.template) — so a correctly deployed host does
 * not need a second copy of its own hostname. Never a hardcoded domain and
 * never localhost in production.
 */
export function redirectUri() {
  const explicit = trimmed('MS_REDIRECT_URI');
  if (explicit) return explicit;
  const origin = (process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean)[0];
  if (!origin) return '';
  return `${origin.replace(/\/+$/, '')}/api/integrations/microsoft/callback`;
}

export function authority() {
  const tenant = trimmed('MS_TENANT_ID');
  return tenant ? `https://login.microsoftonline.com/${tenant}` : '';
}

/** Everything the integration needs, resolved once per call (env may change in tests). */
export function microsoftConfig() {
  return {
    tenantId: trimmed('MS_TENANT_ID'),
    clientId: trimmed('MS_CLIENT_ID'),
    clientSecret: trimmed('MS_CLIENT_SECRET'),
    redirectUri: redirectUri(),
    mailbox: configuredMailbox(),
    authority: authority(),
    // Optional pre-fetched Entra metadata. Supplying it lets MSAL build an
    // authorize URL without a network round trip — used by the tests, and a
    // legitimate production optimisation on a slow-egress host.
    authorityMetadata: trimmed('MS_AUTHORITY_METADATA'),
    cloudDiscoveryMetadata: trimmed('MS_CLOUD_DISCOVERY_METADATA'),
  };
}

/**
 * Is the integration wired at all?
 *
 * "Configured" is about the ENVIRONMENT, not about whether anyone has signed in
 * yet — the difference between "not configured" and "disconnected" is exactly
 * what an administrator needs to be told, so the two are never merged.
 *
 * Device-code mode requires strictly less: a public client has no secret to
 * hold and no callback to be reached on. Demanding either would report a
 * correctly-configured device-code host as broken.
 */
export function isConfigured() {
  const c = microsoftConfig();
  if (!c.tenantId || !c.clientId || !c.mailbox) return false;
  if (isDeviceCodeMode()) return true;
  return !!(c.clientSecret && c.redirectUri);
}

/** Which required variables are missing. Names only — never values. */
export function missingConfig() {
  const c = microsoftConfig();
  const missing = [];
  if (!c.tenantId) missing.push('MS_TENANT_ID');
  if (!c.clientId) missing.push('MS_CLIENT_ID');
  if (isDeviceCodeMode()) return missing;
  if (!c.clientSecret) missing.push('MS_CLIENT_SECRET');
  if (!c.redirectUri) missing.push('MS_REDIRECT_URI');
  return missing;
}

/* ----------------------------- mailbox pinning ---------------------------- */

/**
 * The Graph path prefix every mail read goes through.
 *
 * This is the enforcement point for "one mailbox". In `own` mode it is `/me`,
 * which the token itself confines. In `shared` mode it NAMES the mailbox, so
 * even a token that could reach several mailboxes reaches exactly this one
 * through this application.
 */
export function mailboxRoot() {
  return mailboxAccess() === 'shared'
    ? `/users/${encodeURIComponent(configuredMailbox())}`
    : '/me';
}

/**
 * Refuse a sign-in that is not entitled to the configured mailbox.
 *
 * `own` mode: the account that signed in must BE the mailbox. Anyone else's
 * refresh token would read the wrong inbox, so it is never persisted.
 *
 * `shared` mode: the signer is deliberately somebody else — a human with
 * delegate access — so their username is not compared against the mailbox.
 * What still must hold is the tenant, and that the mailbox is reachable; the
 * latter is proved by an actual inbox probe at connect time rather than
 * asserted here.
 */
export function assertMailbox(username) {
  if (mailboxAccess() === 'shared') return true;
  return String(username || '').trim().toLowerCase() === configuredMailbox();
}

/** How far back a scan reaches beyond the last success, to cover clock skew. */
export function overlapMinutes() {
  const n = Number.parseInt(process.env.MS_SYNC_OVERLAP_MIN ?? '', 10);
  return Number.isFinite(n) && n >= 0 && n <= 1440 ? n : 10;
}

/** Messages examined in one pass. */
export function syncBatchSize() {
  const n = Number.parseInt(process.env.MS_SYNC_BATCH ?? '', 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 200) : 50;
}

/** CV attachment types the existing intake flow accepts. */
export const CV_EXTENSIONS = Object.freeze(['.pdf', '.docx', '.doc']);
