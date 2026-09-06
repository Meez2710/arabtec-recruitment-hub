// Microsoft 365 delegated-mailbox integration — configuration.
//
// ONE MAILBOX, DELEGATED, USER-CONSENTED. This integration replaces the
// app-only (client-credentials) design that lived in deploy/on-prem/mailbox/.
// That design needed tenant-wide Application `Mail.Read`, an Exchange
// application access policy to scope it back down, and PowerShell to install
// that policy. This one needs a System Admin to sign in once as the careers
// mailbox and consent to two delegated Graph scopes. Nothing tenant-wide is
// granted, and the app can only ever see the mailbox that signed in.
//
// Configuration (environment; secrets NEVER in the database and never logged):
//   MS_TENANT_ID    Directory (tenant) ID of the Arabtec Microsoft 365 tenant
//   MS_CLIENT_ID    Application (client) ID of the Entra app registration
//   MS_CLIENT_SECRET  Client secret VALUE (backend only; never returned by an API)
//   MS_REDIRECT_URI https://<ATS public host>/api/integrations/microsoft/callback
//   MS_MAILBOX      career@arabtecegy.com — the ONLY account allowed to connect
//   MICROSOFT_TOKEN_ENCRYPTION_KEY  32 bytes (64 hex chars or base64) — AES-256-GCM
//                   key for the MSAL token cache at rest
//
// New names on purpose. The retired connector used MB_* for a different auth
// model with different semantics (`MB_MAILBOX` was a mailbox the app read
// through tenant-wide permission; `MS_MAILBOX` is the account that signs in).
// Reusing MB_* would let a half-migrated host silently keep the old meaning.

export const MICROSOFT_PROVIDER = 'microsoft';

/** The mailbox this integration exists for, when MS_MAILBOX is unset. */
export const DEFAULT_MAILBOX = 'career@arabtecegy.com';

/**
 * Scopes sent to Microsoft at consent time.
 *
 * DELEGATED ONLY, and deliberately short. There is no `.default`, no
 * `Mail.ReadWrite`, and no directory scope: the ATS never marks a message read,
 * never moves one and never creates a folder, so it never asks for the right
 * to. De-duplication is the ATS database's job instead (mailbox_ingestion).
 */
export const AUTH_SCOPES = Object.freeze([
  'openid',
  'profile',
  'offline_access',
  'https://graph.microsoft.com/Mail.Read',
  'https://graph.microsoft.com/Mail.Send',
]);

/**
 * Resource scopes for silent acquisition. MSAL adds the OIDC scopes itself; a
 * silent request matches on the resource scopes actually needed for the call.
 */
export const GRAPH_SCOPES = Object.freeze([
  'https://graph.microsoft.com/Mail.Read',
  'https://graph.microsoft.com/Mail.Send',
]);

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
 */
export function isConfigured() {
  const c = microsoftConfig();
  return !!(c.tenantId && c.clientId && c.clientSecret && c.redirectUri && c.mailbox);
}

/** Which required variables are missing. Names only — never values. */
export function missingConfig() {
  const c = microsoftConfig();
  const missing = [];
  if (!c.tenantId) missing.push('MS_TENANT_ID');
  if (!c.clientId) missing.push('MS_CLIENT_ID');
  if (!c.clientSecret) missing.push('MS_CLIENT_SECRET');
  if (!c.redirectUri) missing.push('MS_REDIRECT_URI');
  return missing;
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
