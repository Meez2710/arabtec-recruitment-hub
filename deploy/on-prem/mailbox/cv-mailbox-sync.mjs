#!/usr/bin/env node
// ============================================================================
// cv-mailbox-sync.mjs — pull CV attachments from the careers mailbox into the
// ATS CV inbox folder, so the folder watcher (or the 08:00 inbox-scan) imports
// them.
//
// Microsoft 365 via Microsoft Graph, client-credentials flow. Zero npm deps —
// uses global fetch (Node >= 18). Runs one pass and exits; a systemd timer
// repeats it.
//
//   node cv-mailbox-sync.mjs            # one sync pass
//   node cv-mailbox-sync.mjs --dry-run  # list what it would fetch, download nothing
//   node cv-mailbox-sync.mjs --once     # same as default (explicit)
//
// Config: environment (see mailbox.env.template). Secrets ONLY in the env file.
//   MB_TENANT_ID, MB_CLIENT_ID, MB_CLIENT_SECRET   Azure AD app (Mail.Read + Mail.ReadWrite application)
//   MB_MAILBOX            careers@arabtecegy.com  (the shared mailbox to read)
//   CV_INBOX             /var/lib/arabtec-ats/cv_inbox  (where the ATS watcher looks)
//   MB_SOURCE_FOLDER     Inbox            (well-known name or displayName)
//   MB_PROCESSED_FOLDER  "Processed-ATS"  (created if missing; blank = don't move)
//   MB_MARK_READ         true             (also mark handled mail read)
//   MB_EXT               .pdf,.docx,.doc
//   MB_MAX_MB            20               (skip larger attachments — app cap is 20)
//   MB_BATCH            50               (messages per pass)
//   MB_TRIGGER_SCAN_URL / MB_SCAN_EMAIL / MB_SCAN_PASSWORD   optional: kick
//                        POST /api/candidates/inbox-scan right after, so new CVs
//                        import in minutes instead of waiting for the watcher.
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const DRY = process.argv.includes('--dry-run');
const GRAPH = 'https://graph.microsoft.com/v1.0';

const env = (k, d) => (process.env[k] ?? d);
const need = (k) => { const v = process.env[k]; if (!v) { fail(`missing required env ${k}`); } return v; };
const log = (o) => console.log(JSON.stringify({ t: new Date().toISOString(), ...o }));
function fail(msg) { console.error(JSON.stringify({ t: new Date().toISOString(), level: 'error', msg })); process.exit(1); }

const TENANT = need('MB_TENANT_ID');
const CLIENT_ID = need('MB_CLIENT_ID');
const CLIENT_SECRET = need('MB_CLIENT_SECRET');
const MAILBOX = need('MB_MAILBOX');
const CV_INBOX = need('CV_INBOX');
const SRC_FOLDER = env('MB_SOURCE_FOLDER', 'Inbox');
const DONE_FOLDER = env('MB_PROCESSED_FOLDER', 'Processed-ATS');
const MARK_READ = env('MB_MARK_READ', 'true') === 'true';
const EXT = env('MB_EXT', '.pdf,.docx,.doc').split(',').map((s) => s.trim().toLowerCase());
const MAX_BYTES = Math.round(parseFloat(env('MB_MAX_MB', '20')) * 1024 * 1024);
const BATCH = Math.max(1, Math.min(parseInt(env('MB_BATCH', '50'), 10) || 50, 200));

if (!fs.existsSync(CV_INBOX)) fail(`CV_INBOX does not exist: ${CV_INBOX}`);

// ---- Graph helpers --------------------------------------------------------
let token = null;
async function getToken() {
  if (token) return token;
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type: 'client_credentials',
    scope: 'https://graph.microsoft.com/.default',
  });
  const r = await fetch(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body,
  });
  if (!r.ok) fail(`token request failed: HTTP ${r.status} ${(await r.text()).slice(0, 300)}`);
  token = (await r.json()).access_token;
  if (!token) fail('token response had no access_token');
  return token;
}

async function g(method, urlPath, { json, raw } = {}, attempt = 0) {
  const t = await getToken();
  const r = await fetch(urlPath.startsWith('http') ? urlPath : GRAPH + urlPath, {
    method,
    headers: { authorization: `Bearer ${t}`, ...(json ? { 'content-type': 'application/json' } : {}) },
    body: json ? JSON.stringify(json) : undefined,
  });
  if (r.status === 429 && attempt < 4) {
    const wait = (parseInt(r.headers.get('retry-after') || '5', 10) || 5) * 1000;
    await new Promise((res) => setTimeout(res, wait));
    return g(method, urlPath, { json, raw }, attempt + 1);
  }
  if (r.status === 401 && attempt < 1) { token = null; return g(method, urlPath, { json, raw }, attempt + 1); }
  if (!r.ok) fail(`${method} ${urlPath} -> HTTP ${r.status} ${(await r.text()).slice(0, 400)}`);
  if (raw) return Buffer.from(await r.arrayBuffer());
  if (r.status === 204) return null;
  return r.json();
}

const box = encodeURIComponent(MAILBOX);

async function folderId(nameOrWellKnown) {
  const wk = nameOrWellKnown.toLowerCase();
  if (['inbox', 'archive', 'drafts', 'sentitems', 'deleteditems', 'junkemail'].includes(wk)) return wk;
  const res = await g('GET', `/users/${box}/mailFolders?$top=200&$select=id,displayName`);
  const hit = (res.value || []).find((f) => f.displayName.toLowerCase() === wk);
  return hit ? hit.id : null;
}

async function ensureFolder(name) {
  if (!name) return null;
  const existing = await folderId(name);
  if (existing) return existing;
  if (DRY) { log({ msg: 'would create folder', name }); return null; }
  const made = await g('POST', `/users/${box}/mailFolders`, { json: { displayName: name } });
  return made.id;
}

// ---- main ---------------------------------------------------------------
const sanitize = (s) => String(s || '').replace(/[^\w.\-]+/g, '_').replace(/_{2,}/g, '_').slice(0, 120);

async function run() {
  const srcId = await folderId(SRC_FOLDER);
  if (!srcId) fail(`source folder not found: ${SRC_FOLDER}`);
  const doneId = await ensureFolder(DONE_FOLDER);

  // Only unread mail with attachments — marking read (or moving) is what stops
  // a message being handled twice.
  const q = `/users/${box}/mailFolders/${encodeURIComponent(srcId)}/messages`
    + `?$filter=${encodeURIComponent('hasAttachments eq true and isRead eq false')}`
    + `&$select=id,subject,receivedDateTime,from&$orderby=receivedDateTime asc&$top=${BATCH}`;
  const msgs = (await g('GET', q)).value || [];
  log({ msg: 'messages to consider', count: msgs.length, mailbox: MAILBOX, folder: SRC_FOLDER, dryRun: DRY });

  let saved = 0; let handled = 0; let skipped = 0;
  for (const m of msgs) {
    const atts = (await g('GET', `/users/${box}/messages/${m.id}/attachments?$select=id,name,contentType,size,isInline,@odata.type`)).value || [];
    const wanted = atts.filter((a) => a['@odata.type'] === '#microsoft.graph.fileAttachment'
      && !a.isInline
      && EXT.includes(path.extname(a.name || '').toLowerCase()));
    if (!wanted.length) { skipped++; continue; }

    let gotOne = false;
    for (const a of wanted) {
      if (a.size > MAX_BYTES) { log({ msg: 'attachment too large — skipped', name: a.name, size: a.size }); continue; }
      const stamp = sanitize((m.receivedDateTime || '').replace(/[:T]/g, '').slice(0, 15));
      const dest = path.join(CV_INBOX, `${stamp}__${sanitize(a.name)}`);
      if (fs.existsSync(dest) && fs.statSync(dest).size === a.size) { gotOne = true; continue; }
      if (DRY) { log({ msg: 'would save', from: m.from?.emailAddress?.address, subject: m.subject, file: path.basename(dest), size: a.size }); gotOne = true; continue; }
      const bytes = await g('GET', `/users/${box}/messages/${m.id}/attachments/${a.id}/$value`, { raw: true });
      fs.writeFileSync(dest, bytes, { mode: 0o640 });
      saved++; gotOne = true;
      log({ msg: 'saved', file: path.basename(dest), size: bytes.length });
    }

    if (gotOne && !DRY) {
      if (MARK_READ) await g('PATCH', `/users/${box}/messages/${m.id}`, { json: { isRead: true } });
      if (doneId) await g('POST', `/users/${box}/messages/${m.id}/move`, { json: { destinationId: doneId } });
      handled++;
    }
  }
  log({ msg: 'sync complete', saved, messagesHandled: handled, messagesSkipped: skipped, dryRun: DRY });

  // Optional: trigger an immediate import instead of waiting for the watcher.
  const scanUrl = process.env.MB_TRIGGER_SCAN_URL;
  if (!DRY && saved > 0 && scanUrl && process.env.MB_SCAN_EMAIL && process.env.MB_SCAN_PASSWORD) {
    try {
      const lr = await fetch(`${scanUrl}/api/auth/login`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: process.env.MB_SCAN_EMAIL, password: process.env.MB_SCAN_PASSWORD }),
      });
      const tok = lr.ok ? (await lr.json()).token : null;
      if (tok) {
        const sr = await fetch(`${scanUrl}/api/candidates/inbox-scan`, {
          method: 'POST', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: '{}',
        });
        log({ msg: 'inbox-scan triggered', status: sr.status, body: (await sr.text()).slice(0, 300) });
      } else {
        log({ level: 'warn', msg: 'inbox-scan not triggered — scanner login failed' });
      }
    } catch (e) {
      log({ level: 'warn', msg: 'inbox-scan trigger error', error: String(e.message || e) });
    }
  }
}

run().catch((e) => fail(String(e && e.stack || e)));
