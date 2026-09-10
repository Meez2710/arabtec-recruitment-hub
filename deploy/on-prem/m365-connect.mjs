#!/usr/bin/env node
// ============================================================================
// m365-connect.mjs — the ONE interactive step, over a device code.
//
//   node m365-connect.mjs              # sign in and store the grant
//   node m365-connect.mjs --check      # report configuration + connection only
//   node m365-connect.mjs --probe      # prove Mail.Read reaches the mailbox
//
// WHY A DEVICE CODE. The browser-redirect flow needs a client secret and a
// redirect URI that Microsoft can reach; Entra accepts only `https://` (or
// `http://localhost`) there, so on `10.20.0.9:4001` — no DNS name, no
// certificate, no inbound access — it forces a TLS vhost to be built first for
// no other reason. The device-code flow is a PUBLIC client: no secret exists to
// leak, nothing listens on a port, and the operator finishes the sign-in in a
// browser on their own machine. Same delegated grant at the end of it.
//
// WHAT IT ASKS FOR. Exactly the scopes config.js publishes: `Mail.Read` (or
// `Mail.Read.Shared` for a shared mailbox), `offline_access`, and the OIDC
// sign-in scopes. NOT Mail.Send, NOT Mail.ReadWrite, nothing tenant-wide.
//
// WHAT IT WRITES. `microsoft_connection` — the MSAL refresh-token cache,
// AES-256-GCM encrypted with MICROSOFT_TOKEN_ENCRYPTION_KEY, plus the mailbox,
// tenant and a baseline timestamp. Nothing else, and nothing is printed: no
// token, no code fragment, no secret ever reaches stdout or the journal.
//
// Config: /etc/arabtec-ats/ats.env — the SAME file arabtec-ats.service reads.
// ============================================================================
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const APP_ROOT = process.env.ATS_APP_ROOT || '/opt/arabtec-ats';
const BACKEND = path.join(APP_ROOT, 'backend');
const mod = (rel) => pathToFileURL(path.join(BACKEND, rel)).href;

const arg = (name) => process.argv.includes(name);
const CHECK_ONLY = arg('--check');
const PROBE_ONLY = arg('--probe');

const log = (fields) => console.log(JSON.stringify({ t: new Date().toISOString(), ...fields }));
function die(message, detail) {
  console.error(JSON.stringify({ t: new Date().toISOString(), level: 'error', msg: message, detail: detail ?? null }));
  process.exit(1);
}

let cfg; let store; let msal; let graph; let crypto; let db;
try {
  db = await import(mod('src/lib/db.js'));
  cfg = await import(mod('src/lib/microsoft/config.js'));
  crypto = await import(mod('src/lib/microsoft/crypto.js'));
  store = await import(mod('src/lib/microsoft/connection-store.js'));
  msal = await import(mod('src/lib/microsoft/msal-client.js'));
  graph = await import(mod('src/lib/microsoft/graph.js'));
} catch (e) {
  die('could not load the ATS modules — is ATS_APP_ROOT correct and has `npm ci` run?',
    String((e && e.message) || e));
}

// The app creates the tables at boot. Say so plainly rather than failing on SQL.
try { db.get('SELECT 1 FROM microsoft_connection LIMIT 1'); }
catch (e) { die('the microsoft_connection table does not exist — start arabtec-ats.service first', String((e && e.message) || e)); }

/* ------------------------------ configuration ----------------------------- */

const missing = [...cfg.missingConfig()];
if (!crypto.hasEncryptionKey()) missing.push('MICROSOFT_TOKEN_ENCRYPTION_KEY');

// NAMES ONLY, never values — this output is meant to be pasted into a ticket.
const configReport = {
  authMode: cfg.authMode(),
  mailbox: cfg.configuredMailbox(),
  mailboxAccess: cfg.mailboxAccess(),
  graphRoot: cfg.mailboxRoot(),
  scopes: [...cfg.authScopes()],
  sendEnabled: cfg.sendEnabled(),
  missing,
};

if (CHECK_ONLY) {
  log({ msg: 'microsoft.config', ...configReport });
  log({ msg: 'microsoft.status', ...store.connectionStatus() });
  process.exit(missing.length === 0 ? 0 : 1);
}

if (missing.length) {
  die(`Microsoft 365 is not configured. Set these in /etc/arabtec-ats/ats.env: ${missing.join(', ')}`,
    configReport);
}

/* --------------------------------- probe ---------------------------------- */

if (PROBE_ONLY) {
  try {
    const { accessToken, account } = await msal.acquireGraphToken();
    const inbox = await graph.inboxProbe({ accessToken });
    log({
      msg: 'microsoft.probe.ok',
      mailbox: cfg.configuredMailbox(),
      signedInAs: String(account?.username || '').toLowerCase() || null,
      graphRoot: cfg.mailboxRoot(),
      inbox: { displayName: inbox?.displayName ?? null, totalItemCount: inbox?.totalItemCount ?? null },
    });
    process.exit(0);
  } catch (e) {
    const error = msal.classify(e);
    die(`probe failed: ${error.message}`, { code: error.code });
  }
}

/* ------------------------------- the sign-in ------------------------------ */

if (cfg.authMode() !== 'device-code') {
  die('MS_AUTH_MODE is not device-code. Connect from Configuration > Microsoft 365 in the ATS instead, '
    + 'or set MS_AUTH_MODE=device-code and remove MS_CLIENT_SECRET to use this tool.', configReport);
}

log({ msg: 'microsoft.connect.begin', ...configReport });

if (cfg.mailboxAccess() === 'shared') {
  console.error('\n  Sign in as a user who already has delegate access to '
    + `${cfg.configuredMailbox()} — NOT as the mailbox itself.\n`);
} else {
  console.error(`\n  Sign in as ${cfg.configuredMailbox()}.\n`);
}

let signIn;
try {
  signIn = await msal.acquireByDeviceCode({
    onCode: (response) => {
      // Microsoft asks that its own message be shown verbatim; the fields are
      // repeated so this is still legible in a journal that strips formatting.
      console.error('\n' + '='.repeat(72));
      console.error(response?.message || '');
      console.error('='.repeat(72));
      console.error(`  URL:  ${response?.verificationUri || 'https://microsoft.com/devicelogin'}`);
      console.error(`  CODE: ${response?.userCode || '(none returned)'}`);
      console.error(`  This code expires in about ${Math.round((response?.expiresIn ?? 900) / 60)} minutes.`);
      console.error('='.repeat(72) + '\n');
      // The user code is a one-time, short-lived pairing code, not a credential
      // that grants anything on its own — but it is still not written to the
      // structured log, which is what gets shipped and retained.
    },
  });
} catch (e) {
  const error = msal.classify(e);
  // THE PRECISE ERROR, not a summary. A refused registration, a tenant that
  // requires admin consent, or a device-code flow disabled by Conditional Access
  // all surface here, and the operator needs the actual code to act on.
  die(`sign-in failed: ${error.message}`, {
    code: error.code,
    entraErrorCode: error.detail?.errorCode ?? null,
    hint: 'If this says consent is required, an administrator must grant it for this app '
      + 'registration — do not change tenant policy to work around it.',
  });
}

const account = signIn.account;
const signedInAs = String(account?.username || '').toLowerCase();
const expectedMailbox = cfg.configuredMailbox();
const configuredTenant = cfg.microsoftConfig().tenantId;

// Tenant first. Case-insensitive: MSAL lower-cases the GUID and an operator
// pastes it from Entra in whatever case Entra showed.
const tenantMatches = !configuredTenant || !account?.tenantId
  || String(account.tenantId).toLowerCase() === String(configuredTenant).toLowerCase();
if (!tenantMatches) {
  die(`signed in against tenant ${account.tenantId}, but MS_TENANT_ID is a different directory. `
    + 'Nothing was stored.', { code: 'wrong-tenant' });
}

// Then the account. In `own` mode the signer must BE the mailbox; in `shared`
// mode the signer is deliberately a delegate and is not compared.
if (!cfg.assertMailbox(signedInAs)) {
  die(`signed in as ${signedInAs}, but this deployment reads ${expectedMailbox}. Nothing was stored. `
    + `Sign in as ${expectedMailbox}, or set MS_MAILBOX_ACCESS=shared if ${expectedMailbox} is a shared `
    + 'mailbox reached through a delegate.', { code: 'wrong-account' });
}

if (!signIn.serializedCache) {
  die('Microsoft returned no token cache for this sign-in. Nothing was stored.', { code: 'token-cache-missing' });
}

/* ---------------------- prove it before believing it ---------------------- */

// PERSIST FIRST, because acquireGraphToken() reads the STORED cache — that is
// the whole point of the check that follows. If the probe then fails, the
// connection is cleared again, so a grant that cannot actually read the mailbox
// is never left behind looking healthy.
store.saveConnection({
  mailbox: expectedMailbox,          // the mailbox READ, never the delegate's own address
  tenantId: account?.tenantId || configuredTenant,
  homeAccountId: account?.homeAccountId,
  serializedCache: signIn.serializedCache,
  actorId: null,
});

let inbox;
try {
  const { accessToken } = await msal.acquireGraphToken();
  inbox = await graph.inboxProbe({ accessToken });
} catch (e) {
  const error = msal.classify(e);
  store.clearConnection(null);
  die(`signed in, but ${cfg.mailboxRoot()} could not be read, so the connection was discarded: ${error.message}`, {
    code: error.code,
    hint: cfg.mailboxAccess() === 'shared'
      ? `Confirm ${signedInAs} really has delegate access to ${expectedMailbox}, and that Mail.Read.Shared was consented.`
      : 'Confirm Mail.Read was consented for this account.',
  });
}

log({
  msg: 'microsoft.connected',
  mailbox: expectedMailbox,
  signedInAs,
  mailboxAccess: cfg.mailboxAccess(),
  graphRoot: cfg.mailboxRoot(),
  scopes: [...cfg.authScopes()],
  inbox: { displayName: inbox?.displayName ?? null, totalItemCount: inbox?.totalItemCount ?? null },
  baselineAt: store.connectionStatus().baselineAt,
});

console.error('\n  Connected. No mail before this moment will be imported.\n'
  + '  Next: node m365-sync.mjs --status, then a first scan.\n');
process.exit(0);
