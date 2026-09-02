// Inbound CV ingestion receipts.
//
// WHAT THIS IS FOR. An external mailbox orchestrator (today: Microsoft 365)
// POSTs one CV attachment at a time to `POST /api/ingest/cv`. It retries on
// timeout, it re-runs after a crash, and its scan windows overlap at the edges.
// So the SAME attachment arrives more than once, and something has to make the
// second arrival a no-op instead of a second candidate.
//
// THE KEY IS THE ATTACHMENT'S ORIGIN IDENTITY: (source, messageId, attachmentId).
// That triple is what a retry repeats, so that triple is what must be unique.
// The content hash is recorded alongside it and is deliberately NOT unique —
// one applicant legitimately mails the same PDF for two different vacancies,
// and collapsing those would silently lose the second application. The hash is
// a review-time signal, not the idempotency key.
//
// THE UNIQUENESS IS THE DATABASE'S JOB, NOT THIS FILE'S. `claimIngestion` does
// not check-then-insert; it just inserts and lets the unique index decide. A
// check-then-insert is not atomic, so two concurrent submissions of one
// attachment would both pass the check and both write. Under the index, both
// reach the INSERT and exactly one wins — the loser is told it is a duplicate.
//
// A RECEIPT, NOT A CANDIDATE. Nothing here creates or mutates a candidate. The
// record says bytes arrived, what their provenance was, and which
// `candidate_intake` they were routed into. A candidate still appears only when
// a person approves that intake.

import { all, get, run } from './db.js';

/** The only ingestion source this endpoint currently serves. */
export const MICROSOFT_365 = 'microsoft_365';
const SOURCES = new Set([MICROSOFT_365]);

export function isKnownSource(source) {
  return SOURCES.has(source);
}

/** Lifecycle of one receipt. `RECEIVED` is the claim; the rest are terminal. */
export const INGEST_STATUS = {
  RECEIVED: 'RECEIVED',   // claimed, parse not finished
  PARSED: 'PARSED',       // routed into a candidate_intake awaiting review
  NO_FIELDS: 'NO_FIELDS', // read successfully, nothing proposable came out
  FAILED: 'FAILED',       // parse or storage failed; safe to retry
};

function toIngestion(row) {
  if (!row) return null;
  return {
    id: row.id,
    source: row.source,
    messageId: row.message_id,
    attachmentId: row.attachment_id,
    senderEmail: row.sender_email ?? null,
    senderName: row.sender_name ?? null,
    subject: row.subject ?? null,
    receivedAt: row.received_at ?? null,
    filename: row.filename,
    mimeType: row.mime_type ?? null,
    sizeBytes: row.size_bytes ?? null,
    contentHash: row.content_hash,
    storedName: row.stored_name ?? null,
    status: row.status,
    intakeId: row.intake_id ?? null,
    reason: row.reason ?? null,
    createdBy: row.created_by ?? null,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
  };
}

/**
 * The receipt for one attachment identity, or null.
 *
 * Safe to call after a lost race: the identity is unique, so this resolves to
 * the winner's row without a scan.
 */
export function ingestionByIdentity(source, messageId, attachmentId) {
  return toIngestion(get(
    'SELECT * FROM cv_ingestion WHERE source=? AND message_id=? AND attachment_id=?',
    [source, messageId, attachmentId],
  ));
}

export function ingestionById(id) {
  return toIngestion(get('SELECT * FROM cv_ingestion WHERE id=?', [Number(id)]));
}

/**
 * Does this error mean the identity index rejected the row?
 *
 * Matched by INDEX NAME first, which both engines report and which is exact.
 * The SQLite column-list form is a fallback for builds that name the columns
 * instead. Nothing from the driver's message ever reaches a client — callers
 * translate a `true` here into the fixed duplicate response.
 */
export function isIngestionIdentityViolation(err) {
  const m = String(err?.message || '');
  if (m.includes('ux_cv_ingestion_identity')) return true;            // postgres + modern sqlite
  if (String(err?.code) === '23505') return true;                     // postgres unique_violation
  return /UNIQUE constraint failed/i.test(m)                          // sqlite fallback
    && /cv_ingestion\.(source|message_id|attachment_id)/i.test(m);
}

/**
 * Claim an attachment identity.
 *
 * Returns `{ claimed: true, record }` for the winner, or
 * `{ claimed: false, record }` when this identity was already taken — including
 * the case where a concurrent request won the race a microsecond earlier. The
 * caller must treat `claimed: false` as a duplicate and do no further work.
 *
 * NOT wrapped in tx(): this is a single statement, and the index is what
 * provides atomicity. Wrapping it would buy nothing and would forbid the caller
 * from awaiting the parse afterwards (tx() rejects async callbacks by design).
 */
export function claimIngestion(input) {
  const now = new Date().toISOString();
  try {
    run(
      `INSERT INTO cv_ingestion
        (tenant_id, source, message_id, attachment_id, sender_email, sender_name,
         subject, received_at, filename, mime_type, size_bytes, content_hash,
         stored_name, status, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        1, input.source, input.messageId, input.attachmentId,
        input.senderEmail ?? null, input.senderName ?? null,
        input.subject ?? null, input.receivedAt ?? null,
        input.filename, input.mimeType ?? null, input.sizeBytes ?? null,
        input.contentHash, input.storedName ?? null,
        INGEST_STATUS.RECEIVED, input.createdBy ?? null, now, now,
      ],
    );
  } catch (e) {
    if (isIngestionIdentityViolation(e)) {
      // The row the winner wrote. Re-read rather than trusting anything local:
      // the winner may have already advanced it past RECEIVED.
      const existing = ingestionByIdentity(input.source, input.messageId, input.attachmentId);
      if (existing) return { claimed: false, record: existing };
    }
    throw e;
  }
  return {
    claimed: true,
    record: ingestionByIdentity(input.source, input.messageId, input.attachmentId),
  };
}

/** Settle a claimed receipt. Terminal states only; `RECEIVED` is not settleable. */
function settle(id, status, { intakeId = null, reason = null } = {}) {
  run(
    'UPDATE cv_ingestion SET status=?, intake_id=?, reason=?, updated_at=? WHERE id=?',
    [status, intakeId, reason, new Date().toISOString(), Number(id)],
  );
  return ingestionById(id);
}

/** The CV was read and staged for review as `intakeId`. */
export function markParsed(id, intakeId) {
  return settle(id, INGEST_STATUS.PARSED, { intakeId: Number(intakeId) });
}

/**
 * The document was read but proposed nothing worth a review screen.
 *
 * Still a SUCCESS for ingestion purposes: the bytes are stored, the provenance
 * is recorded, and re-sending them would produce the same nothing. Retrying it
 * is waste, so the identity stays claimed.
 */
export function markNoFields(id, reason) {
  return settle(id, INGEST_STATUS.NO_FIELDS, { reason: reason ?? null });
}

/**
 * Parsing or storage failed for a reason that may not recur.
 *
 * The receipt is KEPT — deleting it would let a retry storm re-parse the same
 * attachment endlessly — but see `reopenFailedIngestion` for the deliberate
 * re-open path the orchestrator uses when it wants one more attempt.
 */
export function markFailed(id, reason) {
  return settle(id, INGEST_STATUS.FAILED, { reason: reason ?? null });
}

/**
 * Is a settled receipt one the orchestrator may retry?
 *
 * Only FAILED. A PARSED receipt already has an intake awaiting review, and a
 * NO_FIELDS receipt would read to the same nothing — re-submitting either is
 * how duplicate candidates get made.
 */
export function isRetryable(record) {
  return record?.status === INGEST_STATUS.FAILED;
}

/**
 * Hand a FAILED receipt back for another attempt, in place.
 *
 * Reuses the SAME row rather than inserting a new one, so the identity stays
 * unique and the attempt history is not multiplied. Returns null when the
 * record is not retryable, which the route reports as an ordinary duplicate.
 */
export function reopenFailedIngestion(id) {
  const current = ingestionById(id);
  if (!isRetryable(current)) return null;
  run(
    'UPDATE cv_ingestion SET status=?, reason=NULL, updated_at=? WHERE id=? AND status=?',
    [INGEST_STATUS.RECEIVED, new Date().toISOString(), Number(id), INGEST_STATUS.FAILED],
  );
  return ingestionById(id);
}

/**
 * Other receipts carrying these exact bytes.
 *
 * Advisory only — surfaced to a reviewer and in the ingestion response, never
 * used to reject an ingestion. See the header: identical bytes are not the same
 * application, so this informs a human rather than deciding anything.
 */
export function priorIngestionsWithHash(contentHash, exceptId = null) {
  if (!contentHash) return [];
  const rows = exceptId === null
    ? all('SELECT * FROM cv_ingestion WHERE content_hash=? ORDER BY id ASC', [contentHash])
    : all('SELECT * FROM cv_ingestion WHERE content_hash=? AND id<>? ORDER BY id ASC',
      [contentHash, Number(exceptId)]);
  return rows.map(toIngestion);
}
