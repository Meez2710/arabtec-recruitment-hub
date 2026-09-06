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
    if (m) return json({ value: cloud.attachments.get(decodeURIComponent(m[1])) || [] });

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
  const cache = JSON.parse(decrypt(store.connectionRow().token_cache));
  const stale = String(Math.floor(Date.now() / 1000) - 600);
  for (const key of Object.keys(cache.AccessToken || {})) {
    cache.AccessToken[key].expires_on = stale;
    cache.AccessToken[key].extended_expires_on = stale;
  }
  store.saveTokenCache(JSON.stringify(cache));
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
