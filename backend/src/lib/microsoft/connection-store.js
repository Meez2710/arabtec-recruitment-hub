// Persistence for the Microsoft 365 mailbox connection and its ingestion ledger.
//
// This file is the ONLY place that reads or writes microsoft_connection and
// mailbox_ingestion, so "never return a token to a caller" is enforced in one
// place rather than remembered at every route.

import crypto from 'node:crypto';
import { get, all, run, tx } from '../db.js';
import { MICROSOFT_PROVIDER } from './config.js';
import { decrypt, encrypt, isEncryptedEnvelope } from './crypto.js';

/** Connection lifecycle states. Distinct so an admin is told what to DO. */
export const STATUS = Object.freeze({
  DISCONNECTED: 'DISCONNECTED',
  CONNECTED: 'CONNECTED',
  RECONNECT_REQUIRED: 'RECONNECT_REQUIRED',
  ERROR: 'ERROR',
});

const nowISO = () => new Date().toISOString();

/* ----------------------------- the connection ----------------------------- */

/** The raw row, token cache included. Internal use only — never serialize it. */
export function connectionRow() {
  try {
    return get('SELECT * FROM microsoft_connection WHERE provider=?', [MICROSOFT_PROVIDER]) || null;
  } catch {
    return null; // table not created yet (first boot mid-DDL)
  }
}

function ensureRow() {
  const existing = connectionRow();
  if (existing) return existing;
  run(`INSERT INTO microsoft_connection (provider, status, created_at, updated_at)
       VALUES (?,?,?,?)`, [MICROSOFT_PROVIDER, STATUS.DISCONNECTED, nowISO(), nowISO()]);
  return connectionRow();
}

/**
 * The connection as an API-safe object.
 *
 * NO TOKEN MATERIAL. `token_cache` is reduced to the boolean `hasTokenCache`
 * and nothing else from that column ever leaves this function — not a prefix,
 * not a length, not a hash.
 */
export function connectionStatus() {
  const row = connectionRow();
  if (!row) {
    return {
      connected: false, status: STATUS.DISCONNECTED, mailbox: null, tenantConnected: false,
      hasTokenCache: false, connectedAt: null, baselineAt: null,
      lastSuccessfulSyncAt: null, lastAttemptAt: null, lastError: null, lastResult: null,
      reconnectRequired: false,
    };
  }
  let lastResult = null;
  if (row.last_result) {
    try { lastResult = typeof row.last_result === 'string' ? JSON.parse(row.last_result) : row.last_result; }
    catch { lastResult = null; }
  }
  return {
    connected: row.status === STATUS.CONNECTED,
    status: row.status,
    mailbox: row.mailbox ?? null,
    tenantConnected: !!row.tenant_id,
    hasTokenCache: !!row.token_cache,
    connectedAt: row.connected_at ?? null,
    baselineAt: row.baseline_at ?? null,
    lastSuccessfulSyncAt: row.last_successful_sync_at ?? null,
    lastAttemptAt: row.last_attempt_at ?? null,
    lastError: row.last_error ?? null,
    lastResult,
    reconnectRequired: row.status === STATUS.RECONNECT_REQUIRED,
  };
}

/** Establish (or replace) the connection after a validated OAuth callback. */
export function saveConnection({ mailbox, tenantId, homeAccountId, serializedCache, actorId = null }) {
  const at = nowISO();
  return tx(() => {
    ensureRow();
    run(`UPDATE microsoft_connection
            SET mailbox=?, tenant_id=?, home_account_id=?, token_cache=?, status=?,
                baseline_at=?, connected_at=?, last_error=NULL, last_attempt_at=?,
                updated_by=?, updated_at=?,
                created_by=COALESCE(created_by, ?)
          WHERE provider=?`,
    [String(mailbox).toLowerCase(), tenantId, homeAccountId, encrypt(serializedCache),
      STATUS.CONNECTED, at, at, at, actorId, at, actorId, MICROSOFT_PROVIDER]);
    return connectionStatus();
  });
}

/**
 * Replace the stored cache after MSAL renewed a token.
 *
 * Only ever called from the MSAL cache plugin, and only when MSAL reports the
 * in-memory cache actually changed.
 */
export function saveTokenCache(serializedCache) {
  const row = connectionRow();
  if (!row) return false;
  run('UPDATE microsoft_connection SET token_cache=?, updated_at=? WHERE provider=?',
    [encrypt(serializedCache), nowISO(), MICROSOFT_PROVIDER]);
  return true;
}

/**
 * The decrypted MSAL cache, or null when there is nothing to load.
 *
 * A blob that will not decrypt (rotated key, altered row) is reported as a
 * reconnect condition rather than crashing a scheduled scan.
 */
export function loadTokenCache() {
  const row = connectionRow();
  if (!row || !row.token_cache) return null;
  if (!isEncryptedEnvelope(row.token_cache)) {
    // Defence in depth: a plaintext cache is never written by this codebase, so
    // finding one means the row was tampered with. Refuse to use it.
    throw Object.assign(new Error('The stored Microsoft token cache is not encrypted. Reconnect Microsoft 365.'),
      { code: 'cache-not-encrypted' });
  }
  return decrypt(row.token_cache);
}

/** Mark the connection as needing an interactive sign-in again. */
export function markReconnectRequired(message) {
  const row = connectionRow();
  if (!row) return connectionStatus();
  run(`UPDATE microsoft_connection SET status=?, last_error=?, last_attempt_at=?, updated_at=?
       WHERE provider=?`,
  [STATUS.RECONNECT_REQUIRED, message || 'Microsoft 365 connection requires sign-in again.',
    nowISO(), nowISO(), MICROSOFT_PROVIDER]);
  return connectionStatus();
}

/** Record a failure that is NOT a reconnect condition (throttling, outage…). */
export function markError(message) {
  const row = connectionRow();
  if (!row) return connectionStatus();
  // A transient failure must not downgrade a RECONNECT_REQUIRED connection back
  // to a generic error — the admin action needed is different.
  const status = row.status === STATUS.RECONNECT_REQUIRED ? STATUS.RECONNECT_REQUIRED : STATUS.ERROR;
  run(`UPDATE microsoft_connection SET status=?, last_error=?, last_attempt_at=?, updated_at=?
       WHERE provider=?`, [status, message || null, nowISO(), nowISO(), MICROSOFT_PROVIDER]);
  return connectionStatus();
}

/** Note that a scan started, without changing the connection's health. */
export function markAttempt() {
  if (!connectionRow()) return;
  run('UPDATE microsoft_connection SET last_attempt_at=?, updated_at=? WHERE provider=?',
    [nowISO(), nowISO(), MICROSOFT_PROVIDER]);
}

/** A scan finished cleanly: clears the error and moves the sync watermark. */
export function markSyncSuccess(result, syncedThrough) {
  if (!connectionRow()) return connectionStatus();
  run(`UPDATE microsoft_connection
          SET status=?, last_successful_sync_at=?, last_result=?, last_error=NULL, updated_at=?
        WHERE provider=?`,
  [STATUS.CONNECTED, syncedThrough || nowISO(), JSON.stringify(result ?? {}), nowISO(), MICROSOFT_PROVIDER]);
  return connectionStatus();
}

/**
 * Forget the Microsoft connection.
 *
 * Removes the token material and resets the connection's own columns. Touches
 * NOTHING else: the ingestion ledger is deliberately kept, so reconnecting the
 * same mailbox does not re-import mail the ATS has already reviewed.
 */
export function clearConnection(actorId = null) {
  const row = connectionRow();
  if (!row) return connectionStatus();
  run(`UPDATE microsoft_connection
          SET token_cache=NULL, home_account_id=NULL, status=?, connected_at=NULL,
              baseline_at=NULL, last_error=NULL, last_result=NULL,
              updated_by=?, updated_at=?
        WHERE provider=?`,
  [STATUS.DISCONNECTED, actorId, nowISO(), MICROSOFT_PROVIDER]);
  return connectionStatus();
}

/* --------------------------- the ingestion ledger -------------------------- */

/** Stable identity for one attachment on one message in one mailbox. */
export function dedupKey({ mailbox, messageKey, attachmentKey }) {
  return crypto.createHash('sha256')
    .update(`${MICROSOFT_PROVIDER}|${String(mailbox).toLowerCase()}|${messageKey}|${attachmentKey}`)
    .digest('hex');
}

/** A PROCESSING row older than this is assumed abandoned by a crashed scan. */
const STALE_PROCESSING_MS = 60 * 60 * 1000;

/**
 * Claim an attachment for processing, or report that it is already handled.
 *
 * INSERT FIRST, work second. The unique index on dedup_key is what makes the
 * claim atomic: a second scan (or a second process) attempting the same
 * attachment loses the insert and is told `claimed: false`. Nothing downstream
 * has to reason about ordering.
 *
 * A row left PROCESSING by a crash is re-claimable after STALE_PROCESSING_MS —
 * otherwise one interrupted scan would block that attachment forever.
 */
export function claimAttachment(record) {
  const key = dedupKey(record);
  const at = nowISO();
  const existing = get('SELECT * FROM mailbox_ingestion WHERE dedup_key=?', [key]);
  if (existing) {
    if (existing.status !== 'PROCESSING') {
      return { claimed: false, key, reason: 'already-processed', row: existing };
    }
    const age = Date.now() - new Date(existing.updated_at || existing.created_at || 0).getTime();
    if (!(age > STALE_PROCESSING_MS)) {
      return { claimed: false, key, reason: 'in-progress', row: existing };
    }
    run('UPDATE mailbox_ingestion SET updated_at=?, reason=? WHERE dedup_key=? AND status=?',
      [at, 'retried after an interrupted scan', key, 'PROCESSING']);
    return { claimed: true, key, retried: true };
  }
  try {
    run(`INSERT INTO mailbox_ingestion
          (provider, mailbox, dedup_key, message_id, internet_message_id, attachment_id,
           attachment_name, received_at, status, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [MICROSOFT_PROVIDER, String(record.mailbox).toLowerCase(), key, record.messageId ?? null,
      record.internetMessageId ?? null, record.attachmentId ?? null, record.attachmentName ?? null,
      record.receivedAt ?? null, 'PROCESSING', at, at]);
    return { claimed: true, key };
  } catch (e) {
    // Lost the race to a concurrent claim — the constraint did its job.
    if (/unique|duplicate/i.test(String(e && e.message))) {
      return { claimed: false, key, reason: 'already-processed' };
    }
    throw e;
  }
}

export function completeAttachment(key, { status, reason = null, intakeId = null, storedName = null, contentHash = null }) {
  run(`UPDATE mailbox_ingestion
          SET status=?, reason=?, intake_id=?, stored_name=?, content_hash=?, updated_at=?
        WHERE dedup_key=?`,
  [status, reason, intakeId, storedName, contentHash, nowISO(), key]);
}

/** Release a claim so the next scan retries it (used when nothing was written). */
export function releaseAttachment(key) {
  run('DELETE FROM mailbox_ingestion WHERE dedup_key=? AND status=?', [key, 'PROCESSING']);
}

/** Recent ledger entries, newest first. For the admin panel and diagnostics. */
export function recentIngestions(limit = 20) {
  const n = Math.max(1, Math.min(Number(limit) || 20, 100));
  return all(`SELECT dedup_key, attachment_name, status, reason, intake_id, received_at, created_at
                FROM mailbox_ingestion ORDER BY id DESC LIMIT ${n}`);
}
