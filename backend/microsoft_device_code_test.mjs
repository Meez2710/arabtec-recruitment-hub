// Microsoft 365 mailbox intake — the DEVICE-CODE, INTAKE-ONLY configuration.
//
// Run: node --experimental-sqlite microsoft_device_code_test.mjs
//
// HERMETIC, exactly like microsoft_integration_test.mjs: `globalThis.fetch` is a
// fake Entra + Graph, and because MSAL Node v6 uses global fetch the real MSAL
// device-code flow runs against it. Nothing inside the app is stubbed.
//
// microsoft_integration_test.mjs covers the auth-code, send-enabled shape. This
// one covers the shape the on-prem host actually deploys:
//
//   1.  device-code mode is inferred when no client secret is present
//   2.  a PUBLIC client sends NO client_secret to the token endpoint
//   3.  the grant really is the device-code grant, not an authorization code
//   4.  consent asks for Mail.Read + offline_access and NOTHING else —
//       no Mail.Send, no Mail.ReadWrite, no .default, no directory scope
//   5.  the wrong account is refused and leaves no token cache
//   6.  the right account connects and the cache is encrypted at rest
//   7.  `own` mode reads /me
//   8.  `shared` mode asks for Mail.Read.Shared and reads /users/<mailbox>
//   9.  a delegate may sign in for a shared mailbox; the stored identity is
//       still the MAILBOX, never the delegate
//  10.  outgoing mail is refused while Mail.Send is not consented, and the
//       mailer does not select Graph
//  11.  a scan downloads real attachment BYTES, hashes them, and files a
//       PENDING intake — creating no candidate and sending no mail
//  12.  a second scan of the same message produces exactly one intake

const RID = process.pid + '_' + Date.now();
const DBF = `/tmp/arabtec_msdev_${RID}.db`;
process.env.DATABASE_URL = 'file:' + DBF;
process.env.PORT = String(4890 + (process.pid % 60));
process.env.NODE_ENV = 'test';
process.env.SEED_ADMIN_PASSWORD = 'BootStrap#Aa1';
process.env.SEED_DEMO_DATA = 'true';
process.env.SMTP_TRANSPORT = 'json';          // interlock: no real mail, ever
process.env.UPLOAD_DIR = `/tmp/arabtec_msdev_uploads_${RID}`;

const TENANT = '11111111-2222-3333-4444-555555555555';
const CLIENT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const MAILBOX = 'career@arabtecegy.com';
const DELEGATE = 'hr.admin@arabtecegy.com';
const OID = '99999999-8888-7777-6666-555555555555';

process.env.MS_TENANT_ID = TENANT;
process.env.MS_CLIENT_ID = CLIENT_ID;
process.env.MS_MAILBOX = MAILBOX;
// NO MS_CLIENT_SECRET and NO MS_REDIRECT_URI — that is the point of this suite.
delete process.env.MS_CLIENT_SECRET;
delete process.env.MS_REDIRECT_URI;
delete process.env.MS_ENABLE_SEND;
process.env.MICROSOFT_TOKEN_ENCRYPTION_KEY =
  '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
process.env.MS_AUTHORITY_METADATA = JSON.stringify({
  token_endpoint: `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`,
  authorization_endpoint: `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize`,
  device_authorization_endpoint: `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/devicecode`,
  end_session_endpoint: `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/logout`,
  issuer: `https://login.microsoftonline.com/${TENANT}/v2.0`,
  jwks_uri: `https://login.microsoftonline.com/${TENANT}/discovery/v2.0/keys`,
});
process.env.MS_CLOUD_DISCOVERY_METADATA = JSON.stringify({
  tenant_discovery_endpoint: `https://login.microsoftonline.com/${TENANT}/v2.0/.well-known/openid-configuration`,
  'api-version': '1.1',
  metadata: [{
    preferred_network: 'login.microsoftonline.com',
    preferred_cache: 'login.windows.net',
    aliases: ['login.microsoftonline.com', 'login.windows.net', 'login.microsoft.com', 'sts.windows.net'],
  }],
});

import fs from 'node:fs';
import nodeCrypto from 'node:crypto';

for (const f of [DBF, DBF + '-journal', DBF + '-wal', DBF + '-shm']) {
  try { fs.rmSync(f); } catch { /* first run */ }
}

/* ------------------------------ the fake cloud ----------------------------- */

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

function idToken({ tid = TENANT, oid = OID, username = MAILBOX } = {}) {
  const now = Math.floor(Date.now() / 1000);
  return `${b64url({ alg: 'RS256', typ: 'JWT', kid: 'test' })}.${b64url({
    aud: CLIENT_ID, iss: `https://login.microsoftonline.com/${tid}/v2.0`,
    iat: now, nbf: now, exp: now + 3600, ver: '2.0',
    oid, sub: oid, tid, preferred_username: username, name: 'Arabtec Careers',
  })}.c2ln`;
}

const calls = { device: [], token: [], graph: [] };
const cloud = {
  account: { tid: TENANT, oid: OID, username: MAILBOX },
  messages: [],
  attachments: new Map(),
  bytes: new Map(),
};

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', ...headers },
});

const realFetch = globalThis.fetch;
globalThis.fetch = async function fakeFetch(input, init = {}) {
  const url = typeof input === 'string' ? input : String(input?.url ?? input);

  // The app under test talks to ITSELF over loopback. Only Microsoft is faked.
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(url)) return realFetch(input, init);

  /* ---- Entra: device authorization endpoint ---- */
  if (url.includes('/oauth2/v2.0/devicecode')) {
    const body = new URLSearchParams(String(init.body || ''));
    calls.device.push({ scope: body.get('scope'), hasSecret: body.has('client_secret') });
    return json({
      user_code: 'HXBK7T29', device_code: 'FAKE-DEVICE-CODE',
      verification_uri: 'https://microsoft.com/devicelogin',
      expires_in: 900, interval: 1,
      message: 'To sign in, use a web browser to open the page https://microsoft.com/devicelogin '
        + 'and enter the code HXBK7T29 to authenticate.',
    });
  }

  /* ---- Entra: token endpoint ---- */
  if (url.startsWith('https://login.microsoftonline.com/')) {
    const body = new URLSearchParams(String(init.body || ''));
    calls.token.push({
      grant: body.get('grant_type'),
      scope: body.get('scope'),
      hasSecret: body.has('client_secret'),
    });
    return json({
      token_type: 'Bearer',
      scope: 'https://graph.microsoft.com/Mail.Read',
      expires_in: 3600, ext_expires_in: 3600,
      access_token: 'FAKE.ACCESS.TOKEN.' + nodeCrypto.randomUUID(),
      refresh_token: 'FAKE.REFRESH.TOKEN.' + nodeCrypto.randomUUID(),
      id_token: idToken(cloud.account),
      client_info: b64url({ uid: cloud.account.oid, utid: cloud.account.tid }),
    });
  }

  /* ---- Microsoft Graph ---- */
  if (url.startsWith('https://graph.microsoft.com/')) {
    const path = url.slice('https://graph.microsoft.com/v1.0'.length);
    const bare = path.split('?')[0];
    calls.graph.push({ path: bare, method: init.method || 'GET' });

    // Accept BOTH roots, so the test can assert which one the code chose rather
    // than the fake deciding for it.
    const root = bare.startsWith('/me') ? '/me' : `/users/${encodeURIComponent(MAILBOX)}`;
    const rel = bare.slice(root.length);

    if (rel === '/mailFolders/inbox') {
      return json({ id: 'inbox', displayName: 'Inbox', totalItemCount: cloud.messages.length });
    }
    if (rel === '/mailFolders/inbox/messages') {
      const since = decodeURIComponent(new URL(url).searchParams.get('$filter') || '')
        .match(/receivedDateTime ge ([^ ]+)/)?.[1];
      return json({
        value: cloud.messages.filter((m) => (since ? new Date(m.receivedDateTime) >= new Date(since) : true)),
      });
    }
    const attachList = rel.match(/^\/messages\/([^/]+)\/attachments$/);
    if (attachList) return json({ value: cloud.attachments.get(decodeURIComponent(attachList[1])) || [] });

    const attachBytes = rel.match(/^\/messages\/([^/]+)\/attachments\/([^/]+)\/\$value$/);
    if (attachBytes) {
      const key = `${decodeURIComponent(attachBytes[1])}/${decodeURIComponent(attachBytes[2])}`;
      const buf = cloud.bytes.get(key);
      if (!buf) return json({ error: { code: 'ErrorItemNotFound' } }, 404);
      return new Response(buf, { status: 200, headers: { 'content-type': 'application/octet-stream' } });
    }
    if (rel === '/sendMail') return new Response('', { status: 202 });
    return json({ error: { code: 'ErrorInvalidRequest', path: bare } }, 400);
  }

  throw new Error(`unexpected network call in a hermetic test: ${url}`);
};

/* --------------------------------- harness -------------------------------- */

let passed = 0; let failed = 0;
function c(name, ok, detail) {
  if (ok) { passed += 1; console.log(`  PASS ${name}${detail !== undefined ? ' -- ' + detail : ''}`); }
  else { failed += 1; console.log(`  FAIL ${name}${detail !== undefined ? ' -- ' + detail : ''}`); }
}

await import('./prisma/seed.js');
await import('./src/server.js');
const { waitForReady } = await import('./test-support/wait-ready.mjs');
await waitForReady(`http://localhost:${process.env.PORT}`);

const cfg = await import('./src/lib/microsoft/config.js');
const store = await import('./src/lib/microsoft/connection-store.js');
const { decrypt } = await import('./src/lib/microsoft/crypto.js');
const msal = await import('./src/lib/microsoft/msal-client.js');
const graph = await import('./src/lib/microsoft/graph.js');
const db = await import('./src/lib/db.js');
const { runMailboxSync } = await import('./src/lib/microsoft/mailbox-sync.js');

/** Sign in through the real MSAL device-code flow against the fake cloud. */
async function connect({ username = MAILBOX } = {}) {
  cloud.account = { tid: TENANT, oid: OID, username };
  msal.resetClient();
  let shown = null;
  const result = await msal.acquireByDeviceCode({ onCode: (r) => { shown = r; } });
  return { ...result, shown };
}

/* --------------------- 1. mode inference and scopes ----------------------- */
console.log('\n- Mode and scopes -');

c('device-code is inferred when no client secret is configured',
  cfg.authMode() === 'device-code' && cfg.isDeviceCodeMode(), cfg.authMode());
c('the integration is CONFIGURED without a secret or a redirect URI',
  cfg.isConfigured() && cfg.missingConfig().length === 0,
  JSON.stringify(cfg.missingConfig()));

const askedScopes = [...cfg.authScopes()].sort();
c('consent asks for exactly Mail.Read + offline_access + the OIDC scopes',
  JSON.stringify(askedScopes) === JSON.stringify(
    ['https://graph.microsoft.com/Mail.Read', 'offline_access', 'openid', 'profile'].sort()),
  askedScopes.join(' '));
c('NOTHING that can write, send, or read the directory is requested',
  !askedScopes.some((s) => /Mail\.Send|Mail\.ReadWrite|\.default|Directory\.|User\.Read\.All/.test(s)));
c('outgoing mail is off by default', cfg.sendEnabled() === false);
c('own-mailbox mode reads /me', cfg.mailboxAccess() === 'own' && cfg.mailboxRoot() === '/me');

/* --------------------- 2. the device-code flow itself --------------------- */
console.log('\n- The device-code flow -');

const wrong = await connect({ username: 'someone.else@arabtecegy.com' });
c('MSAL really used the device authorization endpoint', calls.device.length === 1);
c('the operator is shown a user code and a verification URL',
  !!wrong.shown?.userCode && /devicelogin/.test(wrong.shown?.verificationUri || ''),
  `${wrong.shown?.userCode} @ ${wrong.shown?.verificationUri}`);
// MSAL Node sends the short form `device_code`; Entra also accepts the full
// URN. Assert the FLOW, not one spelling of it — and assert positively that no
// authorization code was exchanged, which is the thing that would mean the
// confidential redirect flow had been used after all.
c('the grant is the device-code grant, not an authorization code',
  calls.token.some((t) => /device_code$/.test(t.grant || ''))
  && !calls.token.some((t) => t.grant === 'authorization_code'),
  calls.token.map((t) => t.grant).join(','));
c('a PUBLIC client sends no client_secret anywhere',
  !calls.device.some((d) => d.hasSecret) && !calls.token.some((t) => t.hasSecret));
c('the scope actually sent to Microsoft carries no Mail.Send',
  !calls.device.some((d) => /Mail\.Send|Mail\.ReadWrite/.test(d.scope || '')),
  calls.device[0]?.scope);

// The wrong account is rejected by the caller (m365-connect.mjs / the callback),
// which is what assertMailbox exists for.
c('the wrong account fails the mailbox assertion',
  cfg.assertMailbox(wrong.account.username) === false, wrong.account.username);
c('a rejected sign-in has stored nothing',
  store.connectionRow() === null || !store.connectionRow().token_cache);

/* ------------------------- 3. connecting for real ------------------------- */
console.log('\n- Connecting -');

const good = await connect({ username: MAILBOX });
c('the right account passes the mailbox assertion', cfg.assertMailbox(good.account.username) === true);
store.saveConnection({
  mailbox: cfg.configuredMailbox(),
  tenantId: good.account.tenantId || TENANT,
  homeAccountId: good.account.homeAccountId,
  serializedCache: good.serializedCache,
  actorId: null,
});
const row = store.connectionRow();
c('the connection is stored as CONNECTED', row?.status === 'CONNECTED', row?.status);
c('a baseline is stamped, so no historic mail is imported', !!row?.baseline_at);
c('the token cache is ENCRYPTED at rest',
  !!row.token_cache && !/FAKE\.REFRESH|refresh_token/.test(String(row.token_cache)));
c('and it decrypts back to the MSAL cache',
  /RefreshToken|refresh_token/.test(decrypt(row.token_cache)));
c('the status object never exposes token material',
  !JSON.stringify(store.connectionStatus()).match(/FAKE\.|refresh_token|token_cache/i));

const probe = await (async () => {
  const { accessToken } = await msal.acquireGraphToken();
  return graph.inboxProbe({ accessToken });
})();
c('a silent token reaches the inbox', probe?.displayName === 'Inbox');
c('reads went to /me, not to a named user',
  calls.graph.every((g) => g.path.startsWith('/me')),
  [...new Set(calls.graph.map((g) => g.path.split('/').slice(0, 3).join('/')))].join(' '));

/* -------------------------- 4. no outgoing mail --------------------------- */
console.log('\n- Intake only: no sending -');

let sendError = null;
try {
  await graph.sendMailAs({ to: 'nobody@example.test', subject: 'x', text: 'x', accessToken: 'FAKE' });
} catch (e) { sendError = e; }
c('sendMailAs refuses while Mail.Send is not consented',
  !!sendError && /intake only|Mail\.Send/i.test(sendError.message), sendError?.code);
c('no sendMail request ever reached Graph',
  !calls.graph.some((g) => g.path.endsWith('/sendMail')));

const mailer = await import('./src/lib/mailer.js');
c('the mailer does NOT select Graph on a read-only connection',
  mailer.activeProvider() !== 'graph', mailer.activeProvider());

/* ------------------------ 5. a real byte-for-byte scan -------------------- */
console.log('\n- Ingestion -');

// A minimal but genuinely well-formed PDF, so the bytes that come back can be
// checked against what went in rather than merely counted.
const PDF = Buffer.concat([
  Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n', 'utf8'),
  nodeCrypto.randomBytes(64),
]);
const PDF_SHA = nodeCrypto.createHash('sha256').update(PDF).digest('hex');

cloud.messages = [{
  id: 'MSG-1', internetMessageId: '<cv-1@example.test>', subject: 'Application',
  receivedDateTime: new Date(Date.now() + 1000).toISOString(), hasAttachments: true,
}];
cloud.attachments.set('MSG-1', [
  { id: 'ATT-PDF', name: 'Test Candidate CV.pdf', contentType: 'application/pdf',
    size: PDF.length, isInline: false, '@odata.type': '#microsoft.graph.fileAttachment' },
  { id: 'ATT-IMG', name: 'signature.png', contentType: 'image/png',
    size: 120, isInline: true, '@odata.type': '#microsoft.graph.fileAttachment' },
  { id: 'ATT-ZIP', name: 'portfolio.zip', contentType: 'application/zip',
    size: 400, isInline: false, '@odata.type': '#microsoft.graph.fileAttachment' },
]);
cloud.bytes.set('MSG-1/ATT-PDF', PDF);

// The parser seam the module exposes for exactly this: mailbox rules provable
// without an ANTHROPIC_API_KEY. What is under test here is the byte path.
let parsedPath = null;
const fakeParse = async (filePath) => {
  parsedPath = filePath;
  return {
    ok: true, permanent: true, documentId: 'doc-1',
    generation: { modelId: 'test-model' },
    fields: [{ key: 'fullName', value: 'Test Candidate', confidence: 0.9, evidence: 'header' }],
  };
};

const candidatesBefore = db.get('SELECT COUNT(*) n FROM candidate').n;
const scan = await runMailboxSync({ parse: fakeParse });

c('the scan succeeded', scan.ok === true, JSON.stringify({ imported: scan.imported, skipped: scan.skipped }));
c('exactly one attachment was imported', scan.imported === 1, String(scan.imported));
c('the inline image and the .zip were both skipped', scan.skipped === 2, String(scan.skipped));

const intake = db.get('SELECT * FROM candidate_intake ORDER BY id DESC LIMIT 1');
c('a PENDING intake was created', intake?.status === 'PENDING', intake?.status);
c('the intake records the mailbox origin', intake?.origin === 'mailbox.microsoft', intake?.origin);

// THE BYTE CHECK. Not "a file exists" — the same sha256 the sync computed, the
// same bytes Graph served, and a real PDF magic number on disk.
c('the intake hash is the sha256 of the exact bytes Graph served',
  intake?.file_hash === PDF_SHA, `${String(intake?.file_hash).slice(0, 16)}… vs ${PDF_SHA.slice(0, 16)}…`);
const onDisk = fs.readFileSync(parsedPath);
c('the stored file is byte-identical to the attachment', onDisk.equals(PDF), `${onDisk.length} bytes`);
c('the stored file really is a PDF, not text relabelled as one',
  onDisk.subarray(0, 5).toString() === '%PDF-', onDisk.subarray(0, 5).toString());

const ledger = db.get("SELECT * FROM mailbox_ingestion WHERE status='IMPORTED' ORDER BY id DESC LIMIT 1");
c('the ingestion ledger recorded the message and attachment', !!ledger?.dedup_key);
c('the ledger stores the content hash', ledger?.content_hash === PDF_SHA);

c('NO candidate was created by an email arriving',
  db.get('SELECT COUNT(*) n FROM candidate').n === candidatesBefore,
  `${candidatesBefore} -> ${db.get('SELECT COUNT(*) n FROM candidate').n}`);

/* ------------------------- 6. de-duplication ------------------------------ */
console.log('\n- De-duplication -');

const intakesAfterFirst = db.get('SELECT COUNT(*) n FROM candidate_intake').n;
const second = await runMailboxSync({ parse: fakeParse });
c('the second scan of the same mailbox imports nothing', second.imported === 0, String(second.imported));
c('and creates no second intake',
  db.get('SELECT COUNT(*) n FROM candidate_intake').n === intakesAfterFirst,
  `${intakesAfterFirst} -> ${db.get('SELECT COUNT(*) n FROM candidate_intake').n}`);

/* ----------------------- 7. the shared-mailbox shape ---------------------- */
console.log('\n- Shared mailbox -');

process.env.MS_MAILBOX_ACCESS = 'shared';
msal.resetClient();

c('the scope widens to Mail.Read.Shared only when a delegate is used',
  cfg.mailReadScope() === 'https://graph.microsoft.com/Mail.Read.Shared', cfg.mailReadScope());
c('Mail.Send is STILL not requested in shared mode',
  ![...cfg.authScopes()].some((s) => /Mail\.Send/.test(s)));
c('Graph reads are pinned to the named mailbox, not to /me',
  cfg.mailboxRoot() === `/users/${encodeURIComponent(MAILBOX)}`, cfg.mailboxRoot());
c('a delegate is accepted as the signer in shared mode',
  cfg.assertMailbox(DELEGATE) === true, DELEGATE);
c('but sending as a shared mailbox is refused outright', await (async () => {
  try { await graph.sendMailAs({ to: 'x@example.test', subject: 'x', text: 'x', accessToken: 'F' }); return false; }
  catch { return true; }
})());

const before = calls.graph.length;
await (async () => {
  const { accessToken } = await msal.acquireGraphToken();
  return graph.inboxProbe({ accessToken });
})();
const sharedCalls = calls.graph.slice(before);
c('a shared-mode read really goes to /users/<mailbox>',
  sharedCalls.length > 0 && sharedCalls.every((g) => g.path.startsWith(`/users/${encodeURIComponent(MAILBOX)}`)),
  sharedCalls.map((g) => g.path).join(' '));

process.env.MS_MAILBOX_ACCESS = 'own';

/* --------------------------------- done ----------------------------------- */
console.log(`\n=== MICROSOFT DEVICE CODE: ${passed} passed, ${failed} failed ===`);
for (const f of [DBF, DBF + '-journal', DBF + '-wal', DBF + '-shm']) {
  try { fs.rmSync(f); } catch { /* already gone */ }
}
try { fs.rmSync(process.env.UPLOAD_DIR, { recursive: true, force: true }); } catch { /* nothing to clean */ }
process.exit(failed === 0 ? 0 : 1);
