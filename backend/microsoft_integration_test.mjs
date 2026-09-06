// Microsoft 365 delegated mailbox integration.
//
// Run: node --experimental-sqlite microsoft_integration_test.mjs
//
// HERMETIC. There is no network here and no Microsoft tenant. `globalThis.fetch`
// is replaced with a fake Entra + Graph, which is possible because MSAL Node v6
// itself uses global fetch — so the authorization-code exchange, the silent
// refresh and every Graph call in this suite run through the SAME code paths
// production uses, against canned responses. Nothing is stubbed inside the app.
//
// WHAT IT PROVES
//    1. Connect requires a System Admin.
//    2. The callback rejects an invalid / replayed OAuth state.
//    3. The callback rejects the wrong Microsoft account.
//    4. The MSAL token cache is encrypted at rest (AES-256-GCM).
//    5. The status endpoint never exposes token material.
//    6. Silent token acquisition works after connecting.
//    7. An interaction-required condition becomes RECONNECT_REQUIRED.
//    8. A mailbox scan imports supported CV attachments as PENDING intakes —
//       and creates NO candidate.
//    9. Inline attachments are ignored.
//   10. Unsupported attachment types are ignored.
//   11. Scanning the same message twice produces exactly one intake.
//   12. The first scan after connecting does not import the historic mailbox.
//   13. Graph 429 is retried, honouring Retry-After.
//   14. One failed attachment does not stop the batch.
//   15. No real email leaves the process.

const RID = process.pid + '_' + Date.now();
const DBF = `/tmp/arabtec_msint_${RID}.db`;
process.env.DATABASE_URL = 'file:' + DBF;
process.env.PORT = String(4810 + (process.pid % 80));
process.env.NODE_ENV = 'test';
process.env.SEED_ADMIN_PASSWORD = 'BootStrap#Aa1';
process.env.SEED_DEMO_DATA = 'true';
process.env.SMTP_TRANSPORT = 'json';          // interlock: no real mail, ever
process.env.UPLOAD_DIR = `/tmp/arabtec_msint_uploads_${RID}`;

const TENANT = '11111111-2222-3333-4444-555555555555';
const CLIENT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const MAILBOX = 'career@arabtecegy.com';
const OID = '99999999-8888-7777-6666-555555555555';

process.env.MS_TENANT_ID = TENANT;
process.env.MS_CLIENT_ID = CLIENT_ID;
process.env.MS_CLIENT_SECRET = 'test-client-secret-never-real';
process.env.MS_MAILBOX = MAILBOX;
process.env.MS_REDIRECT_URI = 'https://ats.example.test/api/integrations/microsoft/callback';
// 32 bytes of hex — a TEST key. Production generates its own with openssl.
process.env.MICROSOFT_TOKEN_ENCRYPTION_KEY = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
// Pre-fetched Entra metadata so MSAL builds URLs without discovery traffic.
process.env.MS_AUTHORITY_METADATA = JSON.stringify({
  token_endpoint: `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`,
  authorization_endpoint: `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize`,
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
import crypto from 'node:crypto';

for (const f of [DBF, DBF + '-journal', DBF + '-wal', DBF + '-shm']) {
  try { fs.rmSync(f); } catch { /* first run */ }
}

/* ------------------------------ the fake cloud ----------------------------- */

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

function idToken({ tid = TENANT, oid = OID, username = MAILBOX } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    aud: CLIENT_ID, iss: `https://login.microsoftonline.com/${tid}/v2.0`,
    iat: now, nbf: now, exp: now + 3600, ver: '2.0',
    oid, sub: oid, tid, preferred_username: username, name: 'Arabtec Careers',
  };
  return `${b64url({ alg: 'RS256', typ: 'JWT', kid: 'test' })}.${b64url(payload)}.c2ln`;
}

/** Everything the fake network was asked to do, so tests can assert on it. */
const calls = { token: [], graph: [], other: [] };

/** Per-test control over what the fake cloud answers. */
const cloud = {
  account: { tid: TENANT, oid: OID, username: MAILBOX },
  refreshFails: false,          // -> invalid_grant, the interaction-required case
  messages: [],
  attachments: new Map(),       // messageId -> attachment metadata[]
  bytes: new Map(),             // `${messageId}/${attachmentId}` -> Buffer
  throttleOnce: new Set(),      // request paths that 429 exactly once
  pageSize: 0,                  // >0 makes the inbox listing paginate
  attachPageSize: 0,            // >0 makes the attachment listing paginate
  failDownload: new Set(),      // `${messageId}/${attachmentId}` that fails
  sentMail: [],
};

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', ...headers },
});

const realFetch = globalThis.fetch;
globalThis.fetch = async function fakeFetch(input, init = {}) {
  const url = typeof input === 'string' ? input : String(input?.url ?? input);

  /* ---- Entra token endpoint ---- */
  if (url.startsWith('https://login.microsoftonline.com/')) {
    const body = new URLSearchParams(String(init.body || ''));
    const grant = body.get('grant_type');
    calls.token.push({ grant, scope: body.get('scope') });
    if (grant === 'refresh_token' && cloud.refreshFails) {
      return json({
        error: 'invalid_grant',
        error_description: 'AADSTS50173: The provided grant has expired. The user must sign in again.',
      }, 400);
    }
    return json({
      token_type: 'Bearer',
      scope: 'https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/Mail.Send',
      expires_in: 3600, ext_expires_in: 3600,
      access_token: 'FAKE.ACCESS.TOKEN.' + crypto.randomUUID(),
      refresh_token: 'FAKE.REFRESH.TOKEN.' + crypto.randomUUID(),
      id_token: idToken(cloud.account),
      client_info: b64url({ uid: cloud.account.oid, utid: cloud.account.tid }),
    });
  }

  /* ---- Microsoft Graph ---- */
  if (url.startsWith('https://graph.microsoft.com/')) {
    const path = url.slice('https://graph.microsoft.com/v1.0'.length);
    calls.graph.push({ path, method: init.method || 'GET' });

    const bare = path.split('?')[0];
    if (cloud.throttleOnce.has(bare)) {
      cloud.throttleOnce.delete(bare);
      return new Response('{}', { status: 429, headers: { 'retry-after': '1', 'content-type': 'application/json' } });
    }

    if (bare === '/me') {
      return json({
        id: OID, displayName: 'Arabtec Careers',
        mail: cloud.account.username, userPrincipalName: cloud.account.username,
      });
    }
    if (bare === '/me/mailFolders/inbox') {
      return json({ id: 'inbox', displayName: 'Inbox', totalItemCount: cloud.messages.length });
    }
    if (bare === '/me/mailFolders/inbox/messages') {
      // Honour the $filter the way Graph does, so the baseline window is really
      // exercised rather than assumed.
      const u = new URL(url);
      const filter = decodeURIComponent(u.searchParams.get('$filter') || '');
      const since = filter.match(/receivedDateTime ge ([^ ]+)/)?.[1];
      const all = cloud.messages
        .filter((m) => (since ? new Date(m.receivedDateTime) >= new Date(since) : true))
        .filter((m) => m.hasAttachments !== false);
      // Page the way Graph does when there are more results than $top.
      if (cloud.pageSize) {
        const skip = Number(u.searchParams.get('$skip') || 0);
        const value = all.slice(skip, skip + cloud.pageSize);
        const nextSkip = skip + cloud.pageSize;
        const body = { value };
        if (nextSkip < all.length) {
          const nextParams = new URLSearchParams(u.searchParams);
          nextParams.set('$skip', String(nextSkip));   // set, not append
          body['@odata.nextLink'] = `https://graph.microsoft.com/v1.0${bare}?${nextParams.toString()}`;
        }
        return json(body);
      }
      return json({ value: all });
    }
    let m = bare.match(/^\/me\/messages\/([^/]+)\/attachments$/);
    if (m) {
      const list = cloud.attachments.get(decodeURIComponent(m[1])) || [];
      if (cloud.attachPageSize) {
        const u2 = new URL(url);
        const skip = Number(u2.searchParams.get('$skip') || 0);
        const value = list.slice(skip, skip + cloud.attachPageSize);
        const nextSkip = skip + cloud.attachPageSize;
        const body = { value };
        if (nextSkip < list.length) {
          const np = new URLSearchParams(u2.searchParams);
          np.set('$skip', String(nextSkip));
          body['@odata.nextLink'] = `https://graph.microsoft.com/v1.0${bare}?${np.toString()}`;
        }
        return json(body);
      }
      return json({ value: list });
    }

    m = bare.match(/^\/me\/messages\/([^/]+)\/attachments\/([^/]+)\/\$value$/);
    if (m) {
      const key = `${decodeURIComponent(m[1])}/${decodeURIComponent(m[2])}`;
      if (cloud.failDownload.has(key)) return json({ error: { code: 'ErrorInvalidAttachment' } }, 400);
      const bytes = cloud.bytes.get(key);
      if (!bytes) return json({ error: { code: 'ErrorItemNotFound' } }, 404);
      return new Response(bytes, { status: 200, headers: { 'content-type': 'application/octet-stream' } });
    }
    if (bare === '/me/sendMail') {
      cloud.sentMail.push(JSON.parse(String(init.body || '{}')));
      // Graph really does answer 202 Accepted with a zero-length body here.
      return new Response('', { status: 202, headers: { 'content-type': 'application/json' } });
    }
    return json({ error: { code: 'UnknownRoute', message: bare } }, 404);
  }

  // The suite's own HTTP calls into the server under test.
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:|\/)/.test(url)) return realFetch(input, init);

  // Anything else: this suite must not reach the real internet.
  calls.other.push(url);
  throw new Error(`fakeFetch: unexpected outbound request to ${url}`);
};

/* --------------------------------- harness -------------------------------- */

await import('./prisma/seed.js');
await import('./src/server.js');
const { waitForReady } = await import('./test-support/wait-ready.mjs');
const B = 'http://localhost:' + process.env.PORT;
await waitForReady(B);

let pass = 0; let fail = 0;
const c = (name, ok, extra = '') => {
  console.log((ok ? '  PASS ' : '  FAIL ') + name + (extra ? ' -- ' + extra : ''));
  if (ok) pass += 1; else fail += 1;
};

async function call(path, { method = 'GET', body, token, redirect = 'manual' } = {}) {
  const res = await fetch(B + path, {
    method,
    redirect,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let j = null; try { j = await res.json(); } catch { /* redirect / empty */ }
  return { status: res.status, j, location: res.headers.get('location') };
}

const { adminToken } = await import('./test-support/admin-session.mjs');
const admin = await adminToken(B, { bootstrap: 'BootStrap#Aa1' });
const recruiter = (await call('/api/auth/login', {
  method: 'POST', body: { email: 'recruiter@arabtec.com', password: 'Arabtec@123' },
})).j.token;

const db = await import('./src/lib/db.js');
const store = await import('./src/lib/microsoft/connection-store.js');
const { decrypt } = await import('./src/lib/microsoft/crypto.js');
const { resetClient } = await import('./src/lib/microsoft/msal-client.js');
const { runMailboxSync, classifyAttachment, syncWindowStart } = await import('./src/lib/microsoft/mailbox-sync.js');

const countCandidates = () => db.get('SELECT COUNT(*) AS c FROM candidate').c;
const countIntakes = () => db.get('SELECT COUNT(*) AS c FROM candidate_intake').c;

/** A parse result shaped exactly like pipeline-provider.parseDocument returns. */
const fakeParse = (fields) => async () => ({
  ok: true, fields, preview: [], documentId: 'doc-' + crypto.randomUUID(),
  generation: { modelId: 'test-reader', promptVersion: '1' }, parsed: null,
});
const NAME_FIELD = (value) => [{
  field: 'fullName', value, confidence: 0.9, evidence: value,
  evidenceRef: { page: 1, blockId: 'b1' },
}];

/* Drive the real OAuth code flow through the fake cloud. */
async function connectAs({ username = MAILBOX, tid = TENANT } = {}) {
  cloud.account = { tid, oid: OID, username };
  resetClient();
  const started = await call('/api/integrations/microsoft/connect', { token: admin });
  const state = new URL(started.j.authUrl).searchParams.get('state');
  return call(`/api/integrations/microsoft/callback?code=fake-auth-code&state=${encodeURIComponent(state)}`);
}

const PDF_BYTES = Buffer.from('%PDF-1.4\n% arabtec test cv\n%%EOF\n');
function seedMessage({ id, internetMessageId, receivedDateTime, attachments }) {
  cloud.messages.push({
    id, internetMessageId, receivedDateTime, subject: 'Application', hasAttachments: true,
    from: { emailAddress: { address: 'someone@example.test' } },
  });
  cloud.attachments.set(id, attachments.map((a) => ({
    '@odata.type': a.odataType ?? '#microsoft.graph.fileAttachment',
    id: a.id, name: a.name, contentType: a.contentType ?? 'application/pdf',
    size: a.size ?? PDF_BYTES.length, isInline: a.isInline ?? false,
  })));
  for (const a of attachments) cloud.bytes.set(`${id}/${a.id}`, a.bytes ?? PDF_BYTES);
}

console.log('\nMicrosoft 365 delegated mailbox integration\n');

/* ------------------------------- 1. RBAC ---------------------------------- */
console.log('- RBAC -');
for (const [path, method] of [['/status', 'GET'], ['/connect', 'GET'], ['/connect', 'POST'],
  ['/disconnect', 'POST'], ['/test', 'POST'], ['/sync', 'POST']]) {
  const anon = await call('/api/integrations/microsoft' + path, { method });
  const rec = await call('/api/integrations/microsoft' + path, { method, token: recruiter });
  c(`${method} ${path}: 401 unauthenticated, 403 for a recruiter`,
    anon.status === 401 && rec.status === 403, `got ${anon.status}/${rec.status}`);
}

/* ------------------------- 2. state validation ---------------------------- */
console.log('\n- OAuth state -');
const badState = await call('/api/integrations/microsoft/callback?code=x&state=not-a-real-state');
c('callback rejects an unknown state',
  badState.status === 302 && /code=invalid-state/.test(badState.location || ''),
  `${badState.status} ${badState.location}`);
const noState = await call('/api/integrations/microsoft/callback?code=x');
c('callback rejects a missing state',
  noState.status === 302 && /code=invalid-state/.test(noState.location || ''));

const forScopes = await call('/api/integrations/microsoft/connect', { token: admin });
c('connect returns a Microsoft authorize URL with exactly the five delegated scopes', (() => {
  const scope = new URL(forScopes.j.authUrl).searchParams.get('scope') || '';
  const asked = scope.split(' ').filter(Boolean).sort();
  const expected = ['https://graph.microsoft.com/Mail.Read', 'https://graph.microsoft.com/Mail.Send',
    'offline_access', 'openid', 'profile'].sort();
  return JSON.stringify(asked) === JSON.stringify(expected) && !/\.default|Mail\.ReadWrite/.test(scope);
})(), forScopes.j?.authUrl?.slice(0, 60));

/* ---------------------- 3. wrong account / tenant ------------------------- */
console.log('\n- Mailbox restriction -');
const wrongAccount = await connectAs({ username: 'someone.else@arabtecegy.com' });
c('callback rejects the wrong Microsoft account',
  wrongAccount.status === 302 && /code=wrong-account/.test(wrongAccount.location || ''),
  wrongAccount.location);
c('a rejected account leaves NO token cache behind',
  store.connectionRow() === null || !store.connectionRow().token_cache);

const wrongTenant = await connectAs({ username: MAILBOX, tid: '00000000-0000-0000-0000-000000000000' });
c('callback rejects an account from another tenant',
  wrongTenant.status === 302 && /code=wrong-tenant/.test(wrongTenant.location || ''), wrongTenant.location);

/* ------------------------------ 4. connect -------------------------------- */
console.log('\n- Connect -');
cloud.account = { tid: TENANT, oid: OID, username: MAILBOX };
resetClient();
const started = await call('/api/integrations/microsoft/connect', { token: admin });
const usedState = new URL(started.j.authUrl).searchParams.get('state');
const connected = await call(
  `/api/integrations/microsoft/callback?code=fake-auth-code&state=${encodeURIComponent(usedState)}`);
c('the careers mailbox connects',
  connected.status === 302 && /microsoft=connected/.test(connected.location || ''), connected.location);

const replayed = await call(
  `/api/integrations/microsoft/callback?code=x&state=${encodeURIComponent(usedState)}`);
c('a consumed state cannot be replayed',
  replayed.status === 302 && /reason=already-used/.test(replayed.location || ''), replayed.location);

const row = store.connectionRow();
c('connection is CONNECTED, for the right mailbox', row.status === 'CONNECTED' && row.mailbox === MAILBOX);
c('a baseline timestamp was stamped at connect', !!row.baseline_at);

/* ---------------------- 5. encryption at rest ----------------------------- */
console.log('\n- Token cache at rest -');
c('the stored cache is an AES-256-GCM envelope, not plaintext',
  /^v1\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$/.test(row.token_cache));
c('the stored cache contains no readable token material',
  !/RefreshToken|refresh_token|FAKE\.|accessToken/i.test(row.token_cache));
const plain = decrypt(row.token_cache);
c('it decrypts back to a real MSAL cache', (() => {
  const parsed = JSON.parse(plain);
  return !!parsed.RefreshToken && Object.keys(parsed.RefreshToken).length > 0;
})());
c('the wrong key cannot read it', (() => {
  const good = process.env.MICROSOFT_TOKEN_ENCRYPTION_KEY;
  process.env.MICROSOFT_TOKEN_ENCRYPTION_KEY = 'ff'.repeat(32);
  let threw = false;
  try { decrypt(row.token_cache); } catch { threw = true; }
  process.env.MICROSOFT_TOKEN_ENCRYPTION_KEY = good;
  return threw;
})());

/* ----------------------- 6. status leaks nothing -------------------------- */
console.log('\n- Status endpoint -');
const status = await call('/api/integrations/microsoft/status', { token: admin });
const statusText = JSON.stringify(status.j);
c('status reports connected', status.j.connected === true && status.j.status === 'CONNECTED');
c('status never returns token material or the client secret',
  !statusText.includes(process.env.MS_CLIENT_SECRET)
  && !statusText.includes(process.env.MICROSOFT_TOKEN_ENCRYPTION_KEY)
  && !statusText.includes(row.token_cache.slice(10, 50))
  && !statusText.includes(plain.slice(0, 40))
  && !/FAKE\./.test(statusText));
c('status reports only variable NAMES for anything missing',
  Array.isArray(status.j.missing) && status.j.missing.every((n) => /^[A-Z_]+$/.test(n)));

/* --------------------- 7. silent acquisition works ------------------------ */
console.log('\n- Silent token acquisition -');
calls.token.length = 0;
const tested = await call('/api/integrations/microsoft/test', { method: 'POST', token: admin });
c('test connection succeeds against the delegated mailbox',
  tested.status === 200 && tested.j.ok === true && tested.j.mailbox === MAILBOX,
  JSON.stringify(tested.j).slice(0, 140));
c('no client_credentials grant is ever requested',
  calls.token.every((t) => t.grant !== 'client_credentials'));
c('every Graph call used a delegated /me route, never /users/{mailbox}',
  calls.graph.every((g) => g.path.startsWith('/me')));

/* ----------------------- 12. baseline: no backfill ------------------------ */
console.log('\n- First scan does not import the historic mailbox -');
const HOUR = 3600 * 1000;
const baselineAt = new Date(store.connectionRow().baseline_at);
seedMessage({
  id: 'msg-historic', internetMessageId: '<historic@example.test>',
  receivedDateTime: new Date(baselineAt.getTime() - 30 * 24 * HOUR).toISOString(),
  attachments: [{ id: 'att-historic', name: 'old-cv.pdf' }],
});
c('syncWindowStart is the baseline before any successful sync',
  syncWindowStart({ baseline_at: baselineAt.toISOString(), last_successful_sync_at: null })
    === baselineAt.toISOString());
c('syncWindowStart never reaches back past the baseline',
  syncWindowStart({
    baseline_at: baselineAt.toISOString(),
    last_successful_sync_at: new Date(baselineAt.getTime() + 60 * 1000).toISOString(),
  }) === baselineAt.toISOString());

const intakesBefore = countIntakes();
const firstScan = await runMailboxSync({ parse: fakeParse(NAME_FIELD('Historic Person')) });
c('the first scan reads nothing from before the baseline',
  firstScan.ok === true && firstScan.messages === 0 && countIntakes() === intakesBefore,
  JSON.stringify({ ok: firstScan.ok, messages: firstScan.messages }));

/* -------------------- 8/9/10/11/14. the scan itself ----------------------- */
console.log('\n- Mailbox scan -');
const recent = new Date(baselineAt.getTime() + 60 * 1000).toISOString();
seedMessage({
  id: 'msg-good', internetMessageId: '<good@example.test>', receivedDateTime: recent,
  attachments: [
    { id: 'att-cv', name: 'Ahmed Hassan CV.pdf' },
    { id: 'att-logo', name: 'signature-logo.png', contentType: 'image/png', isInline: true },
    { id: 'att-inline-pdf', name: 'inline.pdf', isInline: true },
    { id: 'att-sheet', name: 'salary.xlsx', contentType: 'application/vnd.ms-excel' },
    { id: 'att-ref', name: 'reference.txt', contentType: 'text/plain' },
    { id: 'att-item', name: 'forwarded.eml', odataType: '#microsoft.graph.itemAttachment' },
  ],
});
seedMessage({
  id: 'msg-broken', internetMessageId: '<broken@example.test>', receivedDateTime: recent,
  attachments: [{
    id: 'att-broken', name: 'unreadable.docx',
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  }],
});
seedMessage({
  id: 'msg-after-broken', internetMessageId: '<after@example.test>', receivedDateTime: recent,
  attachments: [{ id: 'att-cv2', name: 'Second Candidate.docx', bytes: Buffer.from('PK fake docx bytes') }],
});
cloud.failDownload.add('msg-broken/att-broken');

const candidatesBefore = countCandidates();
const scan = await runMailboxSync({ parse: fakeParse(NAME_FIELD('Ahmed Hassan')) });

c('the scan imports the supported CV attachments',
  scan.ok === true && scan.imported === 2,
  JSON.stringify({ imported: scan.imported, skipped: scan.skipped, failed: scan.failed, err: scan.error }));
c('one failed attachment does not stop the batch', scan.failed === 1 && scan.imported === 2);
c('inline attachments are ignored', (() => {
  const rows = db.all("SELECT status, reason FROM mailbox_ingestion WHERE attachment_name IN ('signature-logo.png','inline.pdf')");
  return rows.length === 2 && rows.every((r) => r.status === 'SKIPPED' && /inline/.test(r.reason || ''));
})());
c('unsupported file types are ignored', (() => {
  const rows = db.all("SELECT status FROM mailbox_ingestion WHERE attachment_name IN ('salary.xlsx','reference.txt','forwarded.eml')");
  return rows.length === 3 && rows.every((r) => r.status === 'SKIPPED');
})());
c('classifyAttachment refuses inline, non-file, unsupported and oversized attachments',
  classifyAttachment({ isInline: true, name: 'a.pdf', '@odata.type': '#microsoft.graph.fileAttachment' }).accept === false
  && classifyAttachment({ name: 'a.pdf', '@odata.type': '#microsoft.graph.itemAttachment' }).accept === false
  && classifyAttachment({ name: 'a.exe', '@odata.type': '#microsoft.graph.fileAttachment' }).accept === false
  && classifyAttachment({ name: 'a.pdf', size: 21 * 1024 * 1024, '@odata.type': '#microsoft.graph.fileAttachment' }).accept === false
  && classifyAttachment({ name: 'a.pdf', size: 1024, '@odata.type': '#microsoft.graph.fileAttachment' }).accept === true);

/* --------------- the intake seam: no candidate is created ----------------- */
console.log('\n- The reviewed intake flow is still the only way in -');
c('the scan created PENDING intakes, not candidates',
  countCandidates() === candidatesBefore && countIntakes() === intakesBefore + 2,
  `candidates ${candidatesBefore}->${countCandidates()}, intakes ${intakesBefore}->${countIntakes()}`);
c('the intakes are PENDING and carry the mailbox origin', (() => {
  const rows = db.all('SELECT status, origin, file_hash, stored_name FROM candidate_intake ORDER BY id DESC LIMIT 2');
  return rows.length === 2 && rows.every((r) => r.status === 'PENDING' && r.origin === 'mailbox.microsoft'
    && r.file_hash && r.stored_name);
})());
const pendingList = await call('/api/candidates/intakes', { token: admin });
c('mailbox intakes appear on the existing review queue',
  pendingList.status === 200 && pendingList.j.intakes.some((i) => i.origin === 'mailbox.microsoft'));

/* ------------------------- 11. strong idempotency ------------------------- */
console.log('\n- Idempotency -');
const rescan = await runMailboxSync({ parse: fakeParse(NAME_FIELD('Ahmed Hassan')) });
c('re-scanning the same mail imports nothing new',
  rescan.ok === true && rescan.imported === 0 && countIntakes() === intakesBefore + 2,
  JSON.stringify({ imported: rescan.imported, skipped: rescan.skipped }));
c('the overlap window re-read the three recent messages and still excluded the historic one',
  rescan.messages === 3, `messages seen: ${rescan.messages}`);
c('one ledger row per attachment, unique by dedup_key', (() => {
  const total = db.get('SELECT COUNT(*) AS c FROM mailbox_ingestion').c;
  const distinct = db.get('SELECT COUNT(DISTINCT dedup_key) AS c FROM mailbox_ingestion').c;
  return total === distinct && total > 0;
})());
const [runA, runB] = await Promise.all([
  runMailboxSync({ parse: fakeParse(NAME_FIELD('Ahmed Hassan')) }),
  runMailboxSync({ parse: fakeParse(NAME_FIELD('Ahmed Hassan')) }),
]);
c('exactly one of two concurrent scans runs',
  (runA.code === 'already-running') !== (runB.code === 'already-running'),
  `${runA.code} / ${runB.code}`);
c('concurrent scans still produced no extra intake', countIntakes() === intakesBefore + 2);

console.log('\n- Manual scan through the admin route -');
const routeScan = await call('/api/integrations/microsoft/sync', { method: 'POST', token: admin });
c('POST /sync runs a scan and reports a result',
  routeScan.status === 200 && routeScan.j.ok === true && routeScan.j.imported === 0,
  JSON.stringify(routeScan.j).slice(0, 140));
c('a manual scan through the route creates no extra intake', countIntakes() === intakesBefore + 2);

/* ------------------------- 13. Graph throttling --------------------------- */
console.log('\n- Graph throttling -');
cloud.throttleOnce.add('/me/mailFolders/inbox/messages');
const listCallsBefore = calls.graph.filter((g) => g.path.startsWith('/me/mailFolders/inbox/messages')).length;
const throttled = await runMailboxSync({ parse: fakeParse(NAME_FIELD('Ahmed Hassan')) });
const listCallsAfter = calls.graph.filter((g) => g.path.startsWith('/me/mailFolders/inbox/messages')).length;
c('a 429 with Retry-After is retried, and the scan still completes',
  throttled.ok === true && listCallsAfter - listCallsBefore >= 2,
  JSON.stringify({ ok: throttled.ok, listCalls: listCallsAfter - listCallsBefore, err: throttled.error }));

/* --------------------- 7. interaction-required ---------------------------- */
console.log('\n- Reconnect required -');
// Force MSAL to re-acquire from the refresh token by expiring the cached access
// token, then make the refresh fail the way Entra does after a revoked grant.
(() => {
  const row = store.connectionRow();
  const cache = JSON.parse(decrypt(row.token_cache));
  const stale = String(Math.floor(Date.now() / 1000) - 600);
  for (const key of Object.keys(cache.AccessToken || {})) {
    cache.AccessToken[key].expires_on = stale;
    cache.AccessToken[key].extended_expires_on = stale;
  }
  // saveTokenCache is generation-bound now: pass the generation this cache was
  // read at, exactly as the MSAL plugin does.
  const wrote = store.saveTokenCache(JSON.stringify(cache), Number(row.generation ?? 0));
  c('the test can expire the cached access token', wrote === true);
})();
cloud.refreshFails = true;
resetClient();

const reconnect = await call('/api/integrations/microsoft/test', { method: 'POST', token: admin });
c('an interaction-required condition is reported, not crashed',
  reconnect.status === 409 && reconnect.j.code === 'reconnect-required', JSON.stringify(reconnect.j));
c('the message is the one the admin must see',
  reconnect.j.error === 'Microsoft 365 connection requires sign-in again.', reconnect.j.error);
c('the connection is marked RECONNECT_REQUIRED', store.connectionRow().status === 'RECONNECT_REQUIRED');
const reconnectStatus = await call('/api/integrations/microsoft/status', { token: admin });
c('status surfaces reconnectRequired to the admin panel',
  reconnectStatus.j.reconnectRequired === true && reconnectStatus.j.connected === false);
const syncWhileBroken = await call('/api/integrations/microsoft/sync', { method: 'POST', token: admin });
c('a sync fails cleanly rather than taking the app down',
  syncWhileBroken.status === 409 && syncWhileBroken.j.code === 'reconnect-required',
  JSON.stringify(syncWhileBroken.j).slice(0, 120));
c('the app is still serving', (await call('/api/health')).status === 200);

cloud.refreshFails = false;
resetClient();

/* ---------------------------- 15. no real mail ---------------------------- */
console.log('\n- Email -');
const mailer = await import('./src/lib/mailer.js');
c('the dry-run transport wins over every provider, so no mail leaves the process',
  mailer.activeProvider() === 'dry-run');
const sendResult = await mailer.sendMail({ to: 'nobody@example.test', subject: 'Test', html: '<p>hi</p>' });
c('a send builds a message without contacting Microsoft or SMTP',
  sendResult.ok === true && sendResult.provider === 'dry-run' && cloud.sentMail.length === 0);
c('no outbound request reached anything but the fake Microsoft cloud',
  calls.other.length === 0, calls.other.join(', '));

/* ------------------- regressions from the PR #10 review -------------------- */
console.log('\n- Review regressions -');

// F8 — Graph answers POST /me/sendMail with 202 and an EMPTY body. Parsing that
// reported failure for mail Microsoft had already accepted, and in `auto` mode
// it then fell through to SMTP and sent the message twice.
const { sendMailAs } = await import('./src/lib/microsoft/graph.js');
await connectAs();
cloud.sentMail.length = 0;
let sendThrew = null;
try { await sendMailAs({ to: 'someone@example.test', subject: 'Probe', html: '<p>x</p>' }); }
catch (e) { sendThrew = e.message; }
c('a 202 with an empty body is success, not a parse failure', sendThrew === null, String(sendThrew));
c('the message really reached Graph', cloud.sentMail.length === 1);

// F2 — more messages than one page. Dropping @odata.nextLink lost every message
// past the first page, permanently, because the watermark still advanced.
cloud.messages.length = 0; cloud.attachments.clear(); cloud.bytes.clear();
const lastSync = store.connectionRow().last_successful_sync_at;
const pageBase = (lastSync ? new Date(lastSync).getTime() : Date.now()) + 60_000;
for (let i = 1; i <= 7; i++) {
  seedMessage({
    id: `pg-${i}`, internetMessageId: `<pg${i}@example.test>`,
    receivedDateTime: new Date(pageBase + i * 1000).toISOString(),
    // Unique bytes per attachment: identical bytes are correctly collapsed by
    // the content-hash dedup, which would mask whether paging worked at all.
    attachments: [{ id: `pg-att-${i}`, name: `Paged Candidate ${i}.pdf`,
      bytes: Buffer.from(`%PDF-1.4\n% paged cv ${i}\n%%EOF\n`) }],
  });
}
cloud.pageSize = 2;                       // 7 messages over 4 pages
const intakesBeforePaging = countIntakes();
const paged = await runMailboxSync({ parse: fakeParse(NAME_FIELD('Paged Person')) });
c('the scan follows @odata.nextLink across every page',
  paged.ok === true && paged.messages === 7,
  JSON.stringify({ messages: paged.messages, imported: paged.imported }));
c('every paged message was imported, not just the first page',
  countIntakes() === intakesBeforePaging + 7,
  `intakes ${intakesBeforePaging} -> ${countIntakes()}`);
cloud.pageSize = 0;

// F3 — reconnecting must not stamp a new baseline over the outage window.
const baselineBeforeReconnect = store.connectionRow().baseline_at;
await connectAs();
c('a reconnect preserves the original baseline',
  store.connectionRow().baseline_at === baselineBeforeReconnect,
  `${baselineBeforeReconnect} -> ${store.connectionRow().baseline_at}`);

// F6 — a token refresh landing after a disconnect must not resurrect tokens.
store.clearConnection(1);
const resurrect = store.saveTokenCache(JSON.stringify({ RefreshToken: { leaked: { secret: 'x' } } }));
c('a cache write after disconnect is refused', resurrect === false);
c('the disconnected row still holds no token material', !store.connectionRow().token_cache);

// F7 — the 08:00 timer runs with no actor and no request; it was the ONE scan
// that never wrote an audit entry.
await connectAs();
db.run("DELETE FROM audit_log WHERE action='microsoft.sync'");
await runMailboxSync({ parse: fakeParse(NAME_FIELD('Scheduled Person')) });
const scheduled = db.get("SELECT COUNT(*) AS c FROM audit_log WHERE action='microsoft.sync'");
c('a scheduled scan (no actor, no req) is audited', scheduled.c === 1, `rows=${scheduled.c}`);

// F5 — /me needs User.Read, which this integration does not request.
calls.graph.length = 0;
const testedAgain = await call('/api/integrations/microsoft/test', { method: 'POST', token: admin });
c('test connection still succeeds', testedAgain.status === 200 && testedAgain.j.ok === true,
  JSON.stringify(testedAgain.j).slice(0, 120));
c('test connection never calls Graph /me',
  !calls.graph.some((g) => g.path === '/me' || g.path.startsWith('/me?')),
  calls.graph.map((g) => g.path.split('?')[0]).join(' '));

/* ---------------- regressions from the SECOND PR #10 review ---------------- */
console.log('\n- Second review regressions -');
await connectAs();

// Generation binding: a refresh that finishes after disconnect+reconnect must
// not overwrite the NEW grant with the stale cache it was holding. A status
// check alone could not see this — the row is CONNECTED with the same account.
const genBefore = Number(store.connectionRow().generation ?? 0);
store.clearConnection(1);
await connectAs();
const genAfter = Number(store.connectionRow().generation ?? 0);
c('connect and disconnect each bump the generation', genAfter >= genBefore + 2,
  `${genBefore} -> ${genAfter}`);
const staleWrite = store.saveTokenCache(JSON.stringify({ RefreshToken: { stale: {} } }), genBefore);
c('a cache write from an older generation is refused', staleWrite === false);
c('the current grant survived the stale write',
  JSON.parse(decrypt(store.connectionRow().token_cache)).RefreshToken.stale === undefined);

// Cross-process lease: the in-process flag cannot serialise the timer against
// the web API, so the lease has to live in the database.
const leaseA = store.acquireSyncLease('probe-A');
const leaseB = store.acquireSyncLease('probe-B');
c('a second process cannot take a held scan lease', leaseA.acquired === true && leaseB.acquired === false,
  JSON.stringify({ a: leaseA.acquired, b: leaseB.acquired }));
store.releaseSyncLease('probe-A');
c('the lease is retakeable once released', store.acquireSyncLease('probe-C').acquired === true);
store.releaseSyncLease('probe-C');

// A retryable parse (no CV reader configured) must NOT be recorded as handled,
// and the watermark must not move past it — otherwise wiring the reader up
// later could never recover that CV.
cloud.messages.length = 0; cloud.attachments.clear(); cloud.bytes.clear();
const retryAt = new Date(Date.now() + 5000).toISOString();
seedMessage({
  id: 'msg-noreader', internetMessageId: '<noreader@example.test>', receivedDateTime: retryAt,
  attachments: [{ id: 'att-noreader', name: 'Unreadable For Now.pdf', bytes: Buffer.from('%PDF-1.4 retry me') }],
});
const noReader = async () => ({ ok: false, permanent: false, reason: 'No CV reader is configured.', fields: [], preview: [] });
const beforeRetry = countIntakes();
const retryScan = await runMailboxSync({ parse: noReader });
c('a retryable parse is not counted as skipped', retryScan.retryable === 1 && retryScan.imported === 0,
  JSON.stringify({ retryable: retryScan.retryable, skipped: retryScan.skipped }));
c('no ledger row claims it was handled',
  db.get("SELECT COUNT(*) AS c FROM mailbox_ingestion WHERE attachment_name='Unreadable For Now.pdf'").c === 0);
c('the watermark did not advance past the unfinished message',
  retryScan.watermark <= retryAt, `watermark=${retryScan.watermark} msg=${retryAt}`);

// ...and once a reader exists, the very same message imports.
const recovered = await runMailboxSync({ parse: fakeParse(NAME_FIELD('Recovered Person')) });
c('the same CV imports once the reader is available',
  recovered.imported === 1 && countIntakes() === beforeRetry + 1,
  JSON.stringify({ imported: recovered.imported }));

// An undecryptable cache is a reconnect, not an endless ERROR retry.
const { classify: classifyErr, CODES: ERRCODES } = await import('./src/lib/microsoft/msal-client.js');
const corrupt = Object.assign(new Error('bad envelope'), { name: 'TokenEncryptionError', code: 'corrupt' });
c('a corrupt token cache classifies as reconnect-required',
  classifyErr(corrupt).code === ERRCODES.RECONNECT_REQUIRED, classifyErr(corrupt).code);
const noKey = Object.assign(new Error('no key'), { name: 'TokenEncryptionError', code: 'missing-key' });
c('a missing encryption key classifies as not-configured',
  classifyErr(noKey).code === ERRCODES.NOT_CONFIGURED, classifyErr(noKey).code);

// A mid-scan 401 is an expired access token, not a revoked grant.
calls.token.length = 0;
let served401 = false;
const realFetch401 = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const u = typeof input === 'string' ? input : String(input?.url ?? input);
  if (!served401 && u.includes('/me/mailFolders/inbox?')) {
    served401 = true;
    return new Response(JSON.stringify({ error: { code: 'InvalidAuthenticationToken' } }),
      { status: 401, headers: { 'content-type': 'application/json' } });
  }
  return realFetch401(input, init);
};
const probe401 = await call('/api/integrations/microsoft/test', { method: 'POST', token: admin });
globalThis.fetch = realFetch401;
c('a mid-scan 401 renews the token instead of demanding a new sign-in',
  served401 === true && probe401.status === 200 && probe401.j.ok === true,
  JSON.stringify(probe401.j).slice(0, 110));

// A Graph send that fails AFTER dispatch must not fall back to SMTP.
process.env.MAIL_PROVIDER = 'auto';
process.env.SMTP_USER = 'x@y.test'; process.env.SMTP_PASS = 'p';
delete process.env.SMTP_TRANSPORT;                       // let provider selection run
const mailerMod = await import('./src/lib/mailer.js');
const realFetchMail = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const u = typeof input === 'string' ? input : String(input?.url ?? input);
  if (u.includes('/me/sendMail')) throw new Error('socket hang up after POST');
  return realFetchMail(input, init);
};
const ambiguous = await mailerMod.sendMail({ to: 'candidate@example.test', subject: 'Ambiguous', html: '<p>x</p>' });
globalThis.fetch = realFetchMail;
process.env.SMTP_TRANSPORT = 'json';
delete process.env.SMTP_USER; delete process.env.SMTP_PASS;
c('a post-dispatch Graph failure does NOT fall back to SMTP',
  ambiguous.ok === false && ambiguous.ambiguous === true && ambiguous.provider === 'graph',
  JSON.stringify(ambiguous).slice(0, 110));

/* ---------------- regressions from the THIRD PR #10 review ----------------- */
console.log('\n- Third review regressions -');
await connectAs();

// The schema columns must exist on a FRESH install, not only after a migration
// that ran too early to see the table.
c('microsoft_connection has generation and lease columns', (() => {
  const cols = db.all('PRAGMA table_info(microsoft_connection)').map((r) => r.name);
  return ['generation', 'sync_lease_owner', 'sync_lease_until'].every((n) => cols.includes(n));
})());

// A scan that finishes after a disconnect must not flip the row back.
const genNow = Number(store.connectionRow().generation ?? 0);
store.clearConnection(1);
store.markSyncSuccess({ imported: 99 }, new Date().toISOString(), genNow);
c('a scan completing after disconnect cannot restore CONNECTED',
  store.connectionRow().status === 'DISCONNECTED', store.connectionRow().status);
store.markError('stale failure', genNow);
c('a failed scan cannot resurrect a disconnected connection',
  store.connectionRow().status === 'DISCONNECTED', store.connectionRow().status);

// Graph mail must survive a transient scan error.
await connectAs();
const mailerMod2 = await import('./src/lib/mailer.js');
store.markError('throttled', Number(store.connectionRow().generation ?? 0));
c('the connection is in ERROR after a transient scan failure',
  store.connectionRow().status === 'ERROR');
const savedTransport = process.env.SMTP_TRANSPORT;
delete process.env.SMTP_TRANSPORT;
c('Graph mail is still the provider while status is ERROR',
  mailerMod2.activeProvider() === 'graph', mailerMod2.activeProvider());
process.env.SMTP_TRANSPORT = savedTransport;

// A retryable parse must not leave a new blob + disk copy behind on every run.
await connectAs();
cloud.messages.length = 0; cloud.attachments.clear(); cloud.bytes.clear();
seedMessage({
  id: 'msg-leak', internetMessageId: '<leak@example.test>',
  receivedDateTime: new Date(Date.now() + 5000).toISOString(),
  attachments: [{ id: 'att-leak', name: 'Leaky.pdf', bytes: Buffer.from('%PDF-1.4 leak test') }],
});
const noReader2 = async () => ({ ok: false, permanent: false, reason: 'No CV reader.', fields: [], preview: [] });
const blobsBefore = db.get('SELECT COUNT(*) AS c FROM file_blob').c;
await runMailboxSync({ parse: noReader2 });
await runMailboxSync({ parse: noReader2 });
await runMailboxSync({ parse: noReader2 });
c('three retryable passes leak no stored files',
  db.get('SELECT COUNT(*) AS c FROM file_blob').c === blobsBefore,
  `blobs ${blobsBefore} -> ${db.get('SELECT COUNT(*) AS c FROM file_blob').c}`);

// A message failing BEFORE any claim must still hold the watermark.
cloud.messages.length = 0; cloud.attachments.clear(); cloud.bytes.clear();
const failAt = new Date(Date.now() + 6000).toISOString();
seedMessage({
  id: 'msg-listfail', internetMessageId: '<listfail@example.test>', receivedDateTime: failAt,
  attachments: [{ id: 'att-x', name: 'Never Listed.pdf' }],
});
const realFetchList = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const u = typeof input === 'string' ? input : String(input?.url ?? input);
  if (u.includes('/me/messages/msg-listfail/attachments')) {
    return new Response(JSON.stringify({ error: { code: 'ErrorInternalServerError' } }),
      { status: 400, headers: { 'content-type': 'application/json' } });
  }
  return realFetchList(input, init);
};
const listFail = await runMailboxSync({ parse: fakeParse(NAME_FIELD('Never')) });
globalThis.fetch = realFetchList;
c('a message that fails before any claim holds the watermark',
  listFail.failed === 1 && listFail.watermark <= failAt,
  JSON.stringify({ failed: listFail.failed, watermark: listFail.watermark, msg: failAt }));

// Tenant GUIDs are case-insensitive.
const upperTenant = TENANT.toUpperCase();
process.env.MS_TENANT_ID = upperTenant;
resetClient();
const mixedCase = await connectAs({ username: MAILBOX, tid: TENANT });
c('an upper-case MS_TENANT_ID still matches the lower-case token tenant',
  mixedCase.status === 302 && /microsoft=connected/.test(mixedCase.location || ''), mixedCase.location);
process.env.MS_TENANT_ID = TENANT;
resetClient();

/* ---------------- regressions from the FOURTH PR #10 review ---------------- */
console.log('\n- Fourth review regressions -');
await connectAs();

// Attachment collections paginate too — reading page 1 only silently completed
// the message and let the watermark move past the CVs on later pages.
cloud.messages.length = 0; cloud.attachments.clear(); cloud.bytes.clear();
seedMessage({
  id: 'msg-manyatt', internetMessageId: '<manyatt@example.test>',
  receivedDateTime: new Date(Date.now() + 4000).toISOString(),
  attachments: [1, 2, 3, 4, 5].map((i) => ({
    id: `ma-${i}`, name: `Attachment CV ${i}.pdf`, bytes: Buffer.from(`%PDF-1.4 att ${i}`),
  })),
});
cloud.attachPageSize = 2;                       // 5 attachments over 3 pages
const attIntakesBefore = countIntakes();
const attScan = await runMailboxSync({ parse: fakeParse(NAME_FIELD('Attachment Person')) });
c('every attachment page is followed',
  attScan.imported === 5 && countIntakes() === attIntakesBefore + 5,
  JSON.stringify({ imported: attScan.imported, attachments: attScan.attachments }));
cloud.attachPageSize = 0;

// markReconnectRequired must be fenced like the other two writers.
const genR = Number(store.connectionRow().generation ?? 0);
store.clearConnection(1);
await connectAs();
store.markReconnectRequired('stale token failure', genR);
c('a stale reconnect verdict cannot mark the NEW connection broken',
  store.connectionRow().status === 'CONNECTED', store.connectionRow().status);

// A renewed token must reach the rest of the scan, not just the request that
// triggered the renewal.
cloud.messages.length = 0; cloud.attachments.clear(); cloud.bytes.clear();
for (let i = 1; i <= 3; i++) {
  seedMessage({
    id: `tok-${i}`, internetMessageId: `<tok${i}@example.test>`,
    receivedDateTime: new Date(Date.now() + 7000 + i).toISOString(),
    attachments: [{ id: `tok-att-${i}`, name: `Token CV ${i}.pdf`, bytes: Buffer.from(`%PDF tok ${i}`) }],
  });
}
let four01s = 0;
let firstToken = null;
const realFetchTok = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const u = typeof input === 'string' ? input : String(input?.url ?? input);
  const auth = (init.headers && (init.headers.authorization || init.headers.Authorization)) || '';
  if (u.startsWith('https://graph.microsoft.com/') && auth) {
    if (firstToken === null) firstToken = auth;
    // The originally-issued token is now rejected; anything newer is accepted.
    if (auth === firstToken && !u.includes('/mailFolders/inbox?')) {
      four01s += 1;
      return new Response(JSON.stringify({ error: { code: 'InvalidAuthenticationToken' } }),
        { status: 401, headers: { 'content-type': 'application/json' } });
    }
  }
  return realFetchTok(input, init);
};
const tokScan = await runMailboxSync({ parse: fakeParse(NAME_FIELD('Token Person')) });
globalThis.fetch = realFetchTok;
c('the scan completes after one mid-scan renewal',
  tokScan.ok === true && tokScan.imported === 3, JSON.stringify({ imported: tokScan.imported }));
c('the renewed token is reused, not re-derived per request',
  four01s === 1, `401s served: ${four01s} (one renewal expected, not one per request)`);

/* ------------------------------ disconnect -------------------------------- */
console.log('\n- Disconnect -');
await connectAs();
c('reconnecting restores CONNECTED', store.connectionRow().status === 'CONNECTED');
const intakesBeforeDisconnect = countIntakes();
const disconnected = await call('/api/integrations/microsoft/disconnect', { method: 'POST', token: admin });
c('disconnect succeeds', disconnected.status === 200 && disconnected.j.status === 'DISCONNECTED');
c('disconnect removes the token cache',
  !store.connectionRow().token_cache && !store.connectionRow().home_account_id);
c('disconnect leaves the ingestion ledger and the intakes alone',
  db.get('SELECT COUNT(*) AS c FROM mailbox_ingestion').c > 0
  && countIntakes() === intakesBeforeDisconnect,
  `intakes ${intakesBeforeDisconnect} -> ${countIntakes()}`);
c('disconnect creates no candidates', countCandidates() === candidatesBefore);
const afterDisconnect = await call('/api/integrations/microsoft/sync', { method: 'POST', token: admin });
c('a sync after disconnect is refused',
  afterDisconnect.status === 400 && afterDisconnect.j.code === 'not-connected');

/* -------------------------------- audit ----------------------------------- */
console.log('\n- Audit -');
const actions = db.all("SELECT DISTINCT action FROM audit_log WHERE action LIKE 'microsoft.%'").map((r) => r.action);
for (const expected of ['microsoft.connect_started', 'microsoft.connected', 'microsoft.connect_rejected',
  'microsoft.test', 'microsoft.disconnected', 'microsoft.sync']) {
  c(`audit records ${expected}`, actions.includes(expected), actions.join(', '));
}

globalThis.fetch = realFetch;
console.log(`\n=== MICROSOFT INTEGRATION: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
