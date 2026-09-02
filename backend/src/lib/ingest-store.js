// Inbound CV ingestion receipts.
//
// WHAT THIS IS FOR. The Outlook/Graph scanner POSTs one CV attachment at a time
// to `POST /api/ingest/cv`. It retries on timeout, it re-runs after a crash, and
// its scan windows overlap at the edges. So the SAME attachment arrives more
// than once, and something has to make the second arrival a no-op instead of a
// second candidate.
//
// THE KEY IS (messageId, attachmentId). That pair is what a retry repeats, so
// that pair is what must be unique. Graph message ids are globally unique, so
// the pair alone identifies the attachment.
//
// SOURCE IS NOT IN THE KEY. The same mailbox is called both 'outlook' and
// 'microsoft_365' depending on who is describing it. If the label were part of
// the identity, relabelling the scanner would silently re-ingest the entire
// mailbox. Source is recorded as provenance and validated against an allow-list,
// but it never participates in identity.
//
// THE CONTENT HASH IS NOT THE KEY EITHER. It is recorded and indexed, but
// deliberately not unique: one applicant legitimately mails the same PDF for two
// different vacancies, and collapsing those would silently lose the second
// application. The hash is a review-time signal.
//
// THE UNIQUENESS IS THE DATABASE'S JOB, NOT THIS FILE'S. `claimIngestion` does
// not check-then-insert; it inserts and lets the unique index decide. A
// check-then-insert is not atomic, so two concurrent submissions of one
// attachment would both pass the check and both write. Under the index, both
// reach the INSERT and exactly one wins — the loser is told it is a duplicate.
//
// A RECEIPT, NOT A CANDIDATE. Nothing here creates or mutates a candidate. The
// record says bytes arrived, what their provenance was, and which
// `candidate_intake` they were routed into. A candidate still appears only when
// a person approves that intake.
//
// THE RECEIPT IS ALSO THE QUEUE. Parsing runs after the response has gone out,
// so the scanner never waits on a model call. There is no job table and no
// in-memory queue: a row in `RECEIVED` IS the pending work item, which is what
// makes the queue survive a restart (`strandedIngestions` re-drives them).

import { all, get, run } from './db.js';

/* --------------------------------- sources -------------------------------- */

/**
 * Accepted `source` labels.
 *
 * Both name the same mailbox. Both are accepted because the scanner and the
 * operating spec disagree about which to send, and rejecting one would break a
 * working integration over a synonym. Neither affects identity — see the header.
 */
export const OUTLOOK = 'outlook';
export const MICROSOFT_365 = 'microsoft_365';
export const DEFAULT_SOURCE = OUTLOOK;
const SOURCES = new Set([OUTLOOK, MICROSOFT_365]);

export function isKnownSource(source) {
  return SOURCES.has(source);
}

export function knownSources() {
  return [...SOURCES];
}

/* -------------------------------- lifecycle -------------------------------- */

/** Lifecycle of one receipt. `RECEIVED` is the claim; the rest are terminal. */
export const INGEST_STATUS = {
  RECEIVED: 'RECEIVED',   // claimed; parse queued or in flight
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
    parseAttempts: row.parse_attempts ?? 0,
    parseStartedAt: row.parse_started_at ?? null,
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
export function ingestionByIdentity(messageId, attachmentId) {
  return toIngestion(get(
    'SELECT * FROM cv_ingestion WHERE message_id=? AND attachment_id=?',
    [messageId, attachmentId],
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
  if (m.includes('ux_cv_ingestion_message_attachment')) return true;   // postgres + modern sqlite
  if (String(err?.code) === '23505') return true;                      // postgres unique_violation
  return /UNIQUE constraint failed/i.test(m)                           // sqlite fallback
    && /cv_ingestion\.(message_id|attachment_id)/i.test(m);
}

/**
 * Claim an attachment identity.
 *
 * Returns `{ claimed: true, record }` for the winner, or
 * `{ claimed: false, record }` when this identity was already taken — including
 * the case where a concurrent request won the race a microsecond earlier. The
 * caller must treat `claimed: false` as a duplicate and do no further work: no
 * parse, no intake, no candidate.
 *
 * NOT wrapped in tx(): this is a single statement, and the index is what
 * provides atomicity. Wrapping it would buy nothing.
 */
export function claimIngestion(input) {
  const now = new Date().toISOString();
  try {
    run(
      `INSERT INTO cv_ingestion
        (tenant_id, source, message_id, attachment_id, sender_email, sender_name,
         subject, received_at, filename, mime_type, size_bytes, content_hash,
         stored_name, status, parse_attempts, created_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        1, input.source, input.messageId, input.attachmentId,
        input.senderEmail ?? null, input.senderName ?? null,
        input.subject ?? null, input.receivedAt ?? null,
        input.filename, input.mimeType ?? null, input.sizeBytes ?? null,
        input.contentHash, input.storedName ?? null,
        INGEST_STATUS.RECEIVED, 0, input.createdBy ?? null, now, now,
      ],
    );
  } catch (e) {
    if (isIngestionIdentityViolation(e)) {
      // The row the winner wrote. Re-read rather than trusting anything local:
      // the winner may have already advanced it past RECEIVED.
      const existing = ingestionByIdentity(input.messageId, input.attachmentId);
      if (existing) return { claimed: false, record: existing };
    }
    throw e;
  }
  return {
    claimed: true,
    record: ingestionByIdentity(input.messageId, input.attachmentId),
  };
}

/* ------------------------------ parse tracking ----------------------------- */

/**
 * Record that a parse is STARTING for this receipt.
 *
 * `parse_attempts` is the honest answer to "did a duplicate submission cost us a
 * second model call?" — a duplicate returns before reaching here, so the counter
 * stays at 1 no matter how many times the scanner retries. It is also the
 * restart-recovery guard: a row that has burned its attempts is left alone
 * rather than re-driven forever.
 */
export function beginParse(id) {
  run(
    'UPDATE cv_ingestion SET parse_attempts = parse_attempts + 1, parse_started_at=?, updated_at=? WHERE id=?',
    [new Date().toISOString(), new Date().toISOString(), Number(id)],
  );
  return ingestionById(id);
}

/** Settle a claimed receipt. */
function settle(id, status, { intakeId = null, reason = null } = {}) {
  run(
    'UPDATE cv_ingestion SET status=?, intake_id=?, reason=?, parse_started_at=NULL, updated_at=? WHERE id=?',
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
 * re-open path the scanner uses when it wants one more attempt.
 */
export function markFailed(id, reason) {
  return settle(id, INGEST_STATUS.FAILED, { reason: reason ?? null });
}

/* --------------------------------- retries --------------------------------- */

/**
 * Is a settled receipt one the scanner may retry?
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

/* ---------------------------- restart recovery ----------------------------- */

/**
 * Receipts stranded mid-parse by a restart.
 *
 * THIS IS WHY THERE IS NO JOB TABLE. Parsing runs after the response, so a
 * process that dies mid-parse leaves a row in RECEIVED that nothing will ever
 * finish. Because the row itself is the work item, recovery is a query rather
 * than a replayed queue — and unlike the in-memory job map used by
 * `/parse-cv-async`, nothing is lost when the server restarts.
 *
 * `maxAttempts` stops a document that reliably crashes the parser from being
 * re-driven on every boot forever.
 */
export function strandedIngestions({ olderThanMs = 10 * 60 * 1000, maxAttempts = 3, limit = 50 } = {}) {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  return all(
    `SELECT * FROM cv_ingestion
      WHERE status=? AND parse_attempts < ?
        AND (parse_started_at IS NULL OR parse_started_at < ?)
        AND created_at < ?
      ORDER BY id ASC
      LIMIT ?`,
    [INGEST_STATUS.RECEIVED, Number(maxAttempts), cutoff, cutoff, Number(limit)],
  ).map(toIngestion);
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
