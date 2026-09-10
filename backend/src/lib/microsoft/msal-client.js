// MSAL Node — the whole of the OAuth mechanics for the delegated mailbox.
//
// WHY MSAL AND NOT HAND-ROLLED HTTP. The retired connector posted
// `grant_type=client_credentials` to the token endpoint with `fetch` and cached
// the access token in a module variable. That is fine for an app-only token
// with no refresh token and no user. The delegated flow is not: it has an
// authorization code exchange, a refresh token with its own rotation rules, and
// an interaction-required condition that must be distinguished from an outage.
// MSAL owns all three. Nothing in this file implements refresh-token handling.
//
// TWO WAYS TO SIGN IN ONCE, ONE WAY TO STAY SIGNED IN:
//   buildAuthCodeUrl() + exchangeCodeForAccount()  — the browser redirect flow,
//       a ConfidentialClientApplication. Needs a client secret and a registered
//       HTTPS redirect URI.
//   acquireByDeviceCode()  — a PublicClientApplication. The operator types a
//       short code at microsoft.com/devicelogin on their own machine. NO secret
//       and NO callback URL, so an internal-only host with no certificate and no
//       DNS name can be connected. This is the preferred flow on-prem.
//   acquireGraphToken()  — every subsequent scan, silently, from the stored
//       cache. Identical for both, because both end in the same refresh token.
//
// Both sign-in paths exchange into a STAGING cache and persist nothing until the
// caller has verified who signed in.

import { ConfidentialClientApplication, PublicClientApplication, InteractionRequiredAuthError } from '@azure/msal-node';
import {
  authScopes, graphScopes, microsoftConfig, isConfigured, missingConfig,
  isDeviceCodeMode, authMode,
} from './config.js';
import { loadTokenCache, saveTokenCache, connectionRow, markReconnectRequired } from './connection-store.js';

/** A failure an administrator can act on. `code` decides the UI message. */
export class MicrosoftAuthError extends Error {
  constructor(message, code, detail = null) {
    super(message);
    this.name = 'MicrosoftAuthError';
    this.code = code; // see CODES below
    this.detail = detail;
  }
}

export const CODES = Object.freeze({
  NOT_CONFIGURED: 'not-configured',
  NOT_CONNECTED: 'not-connected',
  TOKEN_CACHE_MISSING: 'token-cache-missing',
  RECONNECT_REQUIRED: 'reconnect-required',
  CONSENT_DENIED: 'consent-denied',
  WRONG_ACCOUNT: 'wrong-account',
  WRONG_TENANT: 'wrong-tenant',
  GRAPH_THROTTLED: 'graph-throttled',
  GRAPH_UNAVAILABLE: 'graph-unavailable',
  UNEXPECTED: 'unexpected',
});

/** The one message the spec requires an administrator to see verbatim. */
export const RECONNECT_MESSAGE = 'Microsoft 365 connection requires sign-in again.';

function requireConfigured() {
  if (isConfigured()) return microsoftConfig();
  throw new MicrosoftAuthError(
    `Microsoft 365 integration is not configured. Missing: ${missingConfig().join(', ') || 'MS_MAILBOX'}.`,
    CODES.NOT_CONFIGURED, { missing: missingConfig() },
  );
}

function baseConfig(cfg, cachePlugin) {
  const auth = {
    clientId: cfg.clientId,
    authority: cfg.authority,
    clientSecret: cfg.clientSecret,
  };
  // Supplying pre-fetched Entra metadata lets MSAL build the authorize URL with
  // no network round trip. Set in tests; optional in production.
  if (cfg.authorityMetadata) auth.authorityMetadata = cfg.authorityMetadata;
  if (cfg.cloudDiscoveryMetadata) auth.cloudDiscoveryMetadata = cfg.cloudDiscoveryMetadata;
  return {
    auth,
    // No MSAL logging by default. MSAL's Verbose level prints token material,
    // and an integration whose whole point is a protected refresh token must
    // not have a switch that writes it to the journal.
    cache: cachePlugin ? { cachePlugin } : undefined,
  };
}

/* ------------------------------ cache plugins ------------------------------ */

/**
 * The persistent plugin: MSAL's in-memory cache is loaded from (and saved back
 * to) the encrypted `microsoft_connection.token_cache` column.
 *
 * Re-reading on EVERY access, rather than once at construction, is what makes a
 * long-lived server correct: the 08:00 scan and an admin's "Test connection"
 * both see whatever the other last wrote, and a process restart loses nothing.
 */
function persistentCachePlugin() {
  // The generation read alongside the blob. The write is conditional on it, so
  // a refresh that completes after a disconnect — or after a disconnect and a
  // fresh reconnect — cannot overwrite the newer grant with this stale one.
  let loadedGeneration = null;
  return {
    async beforeCacheAccess(cacheContext) {
      const loaded = loadTokenCache();
      if (loaded) {
        loadedGeneration = loaded.generation;
        cacheContext.tokenCache.deserialize(loaded.blob);
      }
    },
    async afterCacheAccess(cacheContext) {
      if (cacheContext.cacheHasChanged && loadedGeneration !== null) {
        saveTokenCache(cacheContext.tokenCache.serialize(), loadedGeneration);
      }
    },
  };
}

/**
 * The staging plugin: holds the cache in memory only.
 *
 * Used for the authorization-code exchange, and the reason is the mailbox
 * restriction. `acquireTokenByCode` writes whoever signed in into the cache
 * BEFORE this code can check who that was. With the persistent plugin, a
 * personal account that reached the consent screen by mistake would have its
 * refresh token durably written to the ATS database and then deleted. Staging
 * means the wrong account's tokens never touch disk at all: the blob is only
 * persisted after the account has been verified.
 */
function stagingCachePlugin(holder) {
  return {
    async beforeCacheAccess() { /* always starts empty */ },
    async afterCacheAccess(cacheContext) {
      if (cacheContext.cacheHasChanged) holder.serialized = cacheContext.tokenCache.serialize();
    },
  };
}

/* -------------------------------- clients --------------------------------- */

/**
 * Build the right MSAL client for the configured mode.
 *
 * THE SECRET IS DELETED, NOT MERELY OMITTED, for a public client. A host that
 * still has MS_CLIENT_SECRET left in its env from an earlier auth-code attempt
 * would otherwise have MSAL attach it to a device-code token request, and Entra
 * rejects a client_secret presented by an app registered as a public client —
 * with an error about the credential, not about the flow, which is a miserable
 * thing to debug at 08:00.
 */
function newClient(cfg, cachePlugin) {
  const config = baseConfig(cfg, cachePlugin);
  if (isDeviceCodeMode()) {
    delete config.auth.clientSecret;
    return new PublicClientApplication(config);
  }
  return new ConfidentialClientApplication(config);
}

let persistentClient = null;
let persistentKey = '';

/** The long-lived client bound to the encrypted store. Rebuilt if config changes. */
function getPersistentClient() {
  const cfg = requireConfigured();
  // The mode belongs in the key. A public and a confidential client for the same
  // tenant/clientId are different objects with different token requests, so a
  // memoized client from before a mode change must not be reused.
  const key = `${authMode()}|${cfg.tenantId}|${cfg.clientId}|${cfg.authority}`;
  if (persistentClient === null || persistentKey !== key) {
    persistentClient = newClient(cfg, persistentCachePlugin());
    persistentKey = key;
  }
  return persistentClient;
}

/** Test-only: drop the memoized client so the next call re-reads the environment. */
export function resetClient() { persistentClient = null; persistentKey = ''; }

/* ------------------------------- the flow --------------------------------- */

/** Where to send the administrator's browser to sign in as the careers mailbox. */
export async function buildAuthCodeUrl({ state }) {
  const cfg = requireConfigured();
  const client = getPersistentClient();
  try {
    return await client.getAuthCodeUrl({
      scopes: [...authScopes()],
      redirectUri: cfg.redirectUri,
      state,
      // Ask for the mailbox by name so Microsoft pre-fills it and an
      // administrator already signed in as themselves is not silently
      // connected as the wrong account.
      loginHint: cfg.mailbox,
      prompt: 'select_account',
    });
  } catch (e) {
    throw classify(e);
  }
}

/**
 * Exchange the authorization code, into a staging cache.
 *
 * Returns { account, serializedCache } and persists NOTHING — the caller
 * validates the account first (see routes/integrations-microsoft.js).
 */
export async function exchangeCodeForAccount({ code, state }) {
  const cfg = requireConfigured();
  const holder = { serialized: null };
  const staging = newClient(cfg, stagingCachePlugin(holder));
  let result;
  try {
    result = await staging.acquireTokenByCode({
      code,
      scopes: [...authScopes()],
      redirectUri: cfg.redirectUri,
      state,
    });
  } catch (e) {
    throw classify(e);
  }
  if (!result || !result.account) {
    throw new MicrosoftAuthError('Microsoft returned no account for this sign-in.', CODES.UNEXPECTED);
  }
  return { account: result.account, serializedCache: holder.serialized };
}

/**
 * The device-code sign-in. The only interactive step, and it needs no callback.
 *
 * MSAL calls `onCode` once with { userCode, verificationUri, message, expiresIn }
 * and then long-polls Entra until the operator finishes signing in on whatever
 * machine they like. Nothing listens on a port here, so this works on a host
 * that has no public hostname, no TLS certificate and no inbound access at all —
 * which is the entire reason it is the preferred on-prem flow.
 *
 * Like the code exchange, it stages the cache in memory and persists NOTHING.
 * The caller checks who signed in first; a person who reached the prompt by
 * mistake never has a refresh token written to the ATS database.
 *
 * `cancel` is a mutable { cancel: boolean } MSAL polls, so a caller can abandon
 * a sign-in nobody is going to complete instead of holding the process open for
 * the full 15-minute code lifetime.
 */
export async function acquireByDeviceCode({ onCode, cancel } = {}) {
  const cfg = requireConfigured();
  if (!isDeviceCodeMode()) {
    throw new MicrosoftAuthError(
      'This host is configured for the authorization-code flow. Set MS_AUTH_MODE=device-code '
      + '(and remove MS_CLIENT_SECRET) to sign in with a device code.',
      CODES.NOT_CONFIGURED,
    );
  }
  const holder = { serialized: null };
  const client = newClient(cfg, stagingCachePlugin(holder));

  let result;
  try {
    result = await client.acquireTokenByDeviceCode({
      scopes: [...authScopes()],
      // MSAL's own `message` is the one Microsoft wants shown verbatim; the
      // fields are passed through as well so a caller can format its own.
      deviceCodeCallback: (response) => { try { onCode?.(response); } catch { /* display only */ } },
      ...(cancel ? { cancel } : {}),
    });
  } catch (e) {
    throw classify(e);
  }

  if (!result || !result.account) {
    throw new MicrosoftAuthError('Microsoft returned no account for this sign-in.', CODES.UNEXPECTED);
  }
  return { account: result.account, serializedCache: holder.serialized };
}

/**
 * A Graph access token for the connected mailbox, renewed silently.
 *
 * An interaction-required condition sets the connection to RECONNECT_REQUIRED
 * and throws — it never crashes a scheduled scan and never silently returns a
 * token that is not there.
 */
export async function acquireGraphToken({ scopes = null, forceRefresh = false } = {}) {
  const wanted = scopes ?? graphScopes();
  requireConfigured();
  const row = connectionRow();
  if (!row || row.status === 'DISCONNECTED' || !row.home_account_id) {
    throw new MicrosoftAuthError('Microsoft 365 is not connected yet.', CODES.NOT_CONNECTED);
  }
  const opGeneration = Number(row.generation ?? 0);
  if (!row.token_cache) {
    markReconnectRequired(RECONNECT_MESSAGE, opGeneration);
    throw new MicrosoftAuthError(RECONNECT_MESSAGE, CODES.TOKEN_CACHE_MISSING);
  }

  const client = getPersistentClient();
  let account;
  try {
    account = await client.getTokenCache().getAccountByHomeId(row.home_account_id);
  } catch (e) {
    throw classify(e);
  }
  if (!account) {
    markReconnectRequired(RECONNECT_MESSAGE, opGeneration);
    throw new MicrosoftAuthError(RECONNECT_MESSAGE, CODES.RECONNECT_REQUIRED);
  }

  try {
    // forceRefresh bypasses the cached access token. Used after Graph answers
    // 401: the cache would hand back the very token Graph just rejected, so
    // asking for "a token" is not enough — we need a NEW one.
    const result = await client.acquireTokenSilent({ account, scopes: [...wanted], forceRefresh });
    if (!result || !result.accessToken) {
      markReconnectRequired(RECONNECT_MESSAGE, opGeneration);
      throw new MicrosoftAuthError(RECONNECT_MESSAGE, CODES.RECONNECT_REQUIRED);
    }
    return { accessToken: result.accessToken, account: result.account ?? account, expiresOn: result.expiresOn ?? null };
  } catch (e) {
    const error = classify(e);
    if (error.code === CODES.RECONNECT_REQUIRED) markReconnectRequired(RECONNECT_MESSAGE, opGeneration);
    throw error;
  }
}

/* ----------------------------- classification ----------------------------- */

/**
 * Turn any failure into one an administrator can act on.
 *
 * The distinctions matter operationally: "sign in again" is a person's job,
 * "Graph is throttling" is a retry, and "consent was denied" means the sign-in
 * never completed at all. Collapsing them into "Microsoft error" is what makes
 * an integration unmaintainable.
 */
export function classify(error) {
  if (error instanceof MicrosoftAuthError) return error;

  // A token cache that will not decrypt is a DEAD GRANT, not a transient fault.
  // Left as UNEXPECTED it became ERROR, and the daily timer then retried a cache
  // it can never read, forever, while the admin panel said nothing actionable.
  // A rotated MICROSOFT_TOKEN_ENCRYPTION_KEY is the common cause and the only
  // cure is a new sign-in.
  if (error?.name === 'TokenEncryptionError' || error?.code === 'cache-not-encrypted') {
    if (error.code === 'missing-key' || error.code === 'invalid-key') {
      return new MicrosoftAuthError(
        'MICROSOFT_TOKEN_ENCRYPTION_KEY is missing or malformed, so the stored Microsoft '
        + 'token cache cannot be read. Fix the variable and restart.',
        CODES.NOT_CONFIGURED, { errorCode: error.code },
      );
    }
    return new MicrosoftAuthError(RECONNECT_MESSAGE, CODES.RECONNECT_REQUIRED,
      { errorCode: error.code || 'corrupt' });
  }

  const code = String(error?.errorCode || '');
  const message = String(error?.errorMessage || error?.message || error || '');
  const haystack = `${code} ${message}`.toLowerCase();

  if (error instanceof InteractionRequiredAuthError
    || /interaction_required|invalid_grant|no_tokens_found|no_account_found|token_expired|consent_required|login_required/.test(haystack)) {
    return new MicrosoftAuthError(RECONNECT_MESSAGE, CODES.RECONNECT_REQUIRED, { errorCode: code || null });
  }
  if (/access_denied|consent.*denied|user_cancelled/.test(haystack)) {
    return new MicrosoftAuthError(
      'Consent was not granted. Sign in as the careers mailbox and accept the requested permissions.',
      CODES.CONSENT_DENIED, { errorCode: code || null },
    );
  }
  if (/429|throttl|too many requests/.test(haystack)) {
    return new MicrosoftAuthError('Microsoft is throttling requests. The next scheduled scan will retry.',
      CODES.GRAPH_THROTTLED, { errorCode: code || null });
  }
  if (/network|econnrefused|enotfound|etimedout|socket|fetch failed|503|502|504|service_unavailable/.test(haystack)) {
    return new MicrosoftAuthError('Microsoft 365 could not be reached. Check outbound HTTPS to login.microsoftonline.com and graph.microsoft.com.',
      CODES.GRAPH_UNAVAILABLE, { errorCode: code || null });
  }
  // Deliberately generic: an unclassified provider message can carry request
  // ids and account fragments that do not belong on an admin screen.
  return new MicrosoftAuthError('The Microsoft 365 request failed. See the server log for details.',
    CODES.UNEXPECTED, { errorCode: code || null });
}
