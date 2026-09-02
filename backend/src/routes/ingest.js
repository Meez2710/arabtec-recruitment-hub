// Inbound CV ingestion from the Outlook/Graph mailbox scanner.
//
// POST /api/ingest/cv — one CV attachment, with the provenance the mailbox
// reported for it. This is the single controlled entry point for Outlook CV
// ingestion.
//
// WHY THIS IS A SEPARATE ROUTE AND NOT A FLAG ON /candidates/parse-cv.
// `parse-cv` serves a HUMAN at a browser: it answers with a parse preview, a
// per-field import report and the raw text a reviewer is about to judge. That
// response is exactly what an automated scanner must NOT receive — it would
// ship CV contents to a caller that has no screen and no need for them. This
// route answers with a receipt: identifiers and a status, no document text.
// Same storage, same parser, same intake queue underneath.
//
// WHAT IT DOES NOT DO. It never creates or updates a candidate, and never
// creates an application. It stages a `candidate_intake` exactly as `parse-cv`
// does, and a person approving that intake is still the only thing in this
// system that creates a candidate. There is no shortcut here and deliberately
// no flag to add one.
//
// IDEMPOTENCY IS THE POINT. The scanner retries. The identity
// (messageId, attachmentId) is claimed against a UNIQUE index BEFORE anything
// is parsed, so a duplicate costs one rejected INSERT — not a second model call
// and not a second review item.
//
// THE SCANNER NEVER WAITS ON A PARSE. Claim, answer 201, parse afterwards. See
// ingest-parser.js for why the receipt row is the queue.

import { Router } from 'express';
import crypto from 'node:crypto';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { writeAudit } from '../lib/audit.js';
import { SystemSettings } from '../lib/models.js';
import { multipart, readBlob, deleteBlob, MAX_UPLOAD_BYTES } from '../lib/upload.js';
import { scheduleParse } from '../lib/ingest-parser.js';
import {
  claimIngestion, ingestionById, isKnownSource, isRetryable, knownSources,
  priorIngestionsWithHash, reopenFailedIngestion, DEFAULT_SOURCE,
} from '../lib/ingest-store.js';

const router = Router();
router.use(requireAuth);

/**
 * CV document types only.
 *
 * The shared upload middleware also accepts images and .txt because other
 * routes need them. A mailbox scanner must not widen this: an inbox is full of
 * signatures, logos, scanned certificates and spreadsheets, and every one of
 * them that reached the parser would cost a model call and produce a junk
 * review item. Anything outside this set is rejected before it is parsed.
 */
const CV_EXTENSIONS = new Set(['.pdf', '.doc', '.docx']);
const MIME_BY_EXT = {
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

/** Provenance the receipt cannot be written without. */
const REQUIRED_FIELDS = [
  'source', 'messageId', 'attachmentId', 'filename', 'senderEmail', 'receivedAt',
];

// The project's existing convention (routes/candidates.js). Deliberately loose:
// this is a provenance field recording who sent the mail, not a login.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// A zero-byte or near-empty attachment is not a CV. Catching it here keeps a
// pointless model call off the bill and a junk receipt out of the review queue.
const MIN_FILE_BYTES = 64;

const str = (v) => (typeof v === 'string' ? v.trim() : '');

/**
 * Reject with a machine-readable code.
 *
 * The scanner branches on `code`, never on the sentence, so the codes are part
 * of this endpoint's contract and the sentences are not.
 */
const reject = (res, status, code, message, extra = {}) =>
  res.status(status).json({ status: 'rejected', code, error: message, ...extra });

/**
 * The receipt shape returned on every non-rejection path.
 *
 * DELIBERATELY CARRIES NO DOCUMENT TEXT — no parsed fields, no preview, no
 * extracted values. A scanner needs to know what happened to the file, not what
 * the file said. The review screen reads the intake directly.
 */
const receipt = (record, extra = {}) => ({
  ingestionId: record.id,
  status: record.status,
  source: record.source,
  messageId: record.messageId,
  attachmentId: record.attachmentId,
  filename: record.filename,
  contentHash: record.contentHash,
  intakeId: record.intakeId,
  receivedAt: record.receivedAt,
  parseAttempts: record.parseAttempts,
  ...extra,
});

router.post('/cv', requirePermission('candidate.add'), multipart, async (req, res) => {
  const f = req.uploadedFile;
  const fields = req.fields || {};

  // ---------------------------------------------------------------- validate
  if (!f) return reject(res, 400, 'file-missing', 'A CV file attachment is required.');

  const cleanup = () => { try { deleteBlob(f.storedName); } catch { /* best effort */ } };

  const missing = REQUIRED_FIELDS.filter((k) => str(fields[k]) === '');
  if (missing.length > 0) {
    // Nothing is kept for a request that could never have been identified —
    // an unclaimable blob is unreachable storage that nothing will ever clean.
    cleanup();
    return reject(res, 400, 'provenance-missing',
      'Required provenance fields are missing.', { missing });
  }

  const source = str(fields.source);
  if (!isKnownSource(source)) {
    cleanup();
    return reject(res, 400, 'source-unknown',
      'Unrecognised ingestion source.', { source, accepted: knownSources() });
  }

  const senderEmail = str(fields.senderEmail);
  if (!EMAIL_RE.test(senderEmail)) {
    cleanup();
    return reject(res, 400, 'sender-email-invalid',
      'senderEmail is not a valid email address.', { senderEmail });
  }

  // The extension is taken from the STORED file, not from the `filename` field:
  // the field is caller-supplied text and the two can disagree.
  if (!CV_EXTENSIONS.has(f.ext)) {
    cleanup();
    return reject(res, 400, 'unsupported-file-type',
      'Only PDF, DOC and DOCX CV files are accepted.',
      { extension: f.ext || null, accepted: [...CV_EXTENSIONS] });
  }

  const receivedAtRaw = str(fields.receivedAt);
  const parsedDate = new Date(receivedAtRaw);
  if (Number.isNaN(parsedDate.getTime())) {
    cleanup();
    return reject(res, 400, 'received-at-invalid',
      'receivedAt must be a parseable ISO-8601 timestamp.', { receivedAt: receivedAtRaw });
  }
  const receivedAt = parsedDate.toISOString();

  // ------------------------------------------------------------------- hash
  // SHA-256 over the bytes AS STORED. A client-supplied hash is never read,
  // even if one is posted: a hash the server did not compute is a claim, not a
  // checksum, and this value decides what counts as the same document.
  const stored = readBlob(f.storedName);
  if (!stored || !stored.data) {
    return reject(res, 500, 'storage-unavailable',
      'The uploaded file could not be stored or read back.');
  }
  if (stored.data.length < MIN_FILE_BYTES) {
    cleanup();
    return reject(res, 400, 'file-too-small',
      'The attachment is too small to be a CV.',
      { sizeBytes: stored.data.length, minimumBytes: MIN_FILE_BYTES });
  }
  if (stored.data.length > MAX_UPLOAD_BYTES) {
    // The middleware caps the stream, so this is belt-and-braces for a stored
    // file that somehow exceeded it.
    cleanup();
    return reject(res, 413, 'file-too-large',
      'The attachment exceeds the maximum upload size.',
      { sizeBytes: stored.data.length, maximumBytes: MAX_UPLOAD_BYTES });
  }
  const contentHash = crypto.createHash('sha256').update(stored.data).digest('hex');

  // ------------------------------------------------------------------ claim
  // Before parsing, so a duplicate is one rejected INSERT instead of a second
  // model call and a second review item.
  let claim;
  try {
    claim = claimIngestion({
      source,
      messageId: str(fields.messageId),
      attachmentId: str(fields.attachmentId),
      senderEmail,
      senderName: str(fields.senderName) || null,
      subject: str(fields.subject) || null,
      receivedAt,
      filename: str(fields.filename),
      mimeType: MIME_BY_EXT[f.ext] ?? null,
      sizeBytes: stored.data.length,
      contentHash,
      storedName: f.storedName,
      createdBy: req.user.id,
    });
  } catch (e) {
    console.error(JSON.stringify({
      level: 'error', msg: 'ingest.claim_failed', requestId: req.requestId,
      source, messageId: str(fields.messageId), attachmentId: str(fields.attachmentId),
      error: e.message,
    }));
    return reject(res, 500, 'storage-failure',
      'The ingestion record could not be written.');
  }

  let record = claim.record;

  // --------------------------------------------------------------- duplicate
  if (!claim.claimed) {
    // A FAILED receipt is the one case worth another attempt; everything else
    // is answered as a duplicate WITHOUT re-parsing, without a second receipt,
    // and without any candidate or application being created.
    const reopened = isRetryable(record) ? reopenFailedIngestion(record.id) : null;
    if (!reopened) {
      cleanup(); // this request's bytes are redundant; the winner's copy stands
      console.log(JSON.stringify({
        level: 'info', msg: 'ingest.duplicate', requestId: req.requestId,
        ingestionId: record.id, source, originalStatus: record.status,
      }));
      return res.status(200).json({
        ...receipt(record),
        status: 'duplicate',
        code: 'duplicate',
        duplicateOf: record.id,
        originalStatus: record.status,
        message: 'This attachment was already ingested. No candidate was created.',
      });
    }
    record = reopened;
  }

  // --------------------------------------------------------- accept + enqueue
  // The scanner is answered NOW. Parsing runs after this response is flushed;
  // the receipt row is the durable queue entry, so a restart mid-parse is
  // recoverable (see ingest-parser.js) rather than lost.
  writeAudit(req, {
    action: 'cv.ingest_accepted', entityType: 'cv_ingestion', entityId: record.id,
    newValue: {
      source, messageId: record.messageId, attachmentId: record.attachmentId,
      filename: record.filename, sizeBytes: record.sizeBytes,
    },
  });

  console.log(JSON.stringify({
    level: 'info', msg: 'ingest.accepted', requestId: req.requestId,
    ingestionId: record.id, source, sizeBytes: record.sizeBytes,
  }));

  scheduleParse(record);

  return res.status(201).json({
    ...receipt(record),
    code: 'accepted',
    queued: true,
    // Advisory only: same bytes seen before, under a different message.
    priorHashMatches: priorIngestionsWithHash(contentHash, record.id).map((r) => r.id),
    message: 'Ingested and queued for parsing. No candidate was created.',
    statusUrl: `/api/ingest/cv/${record.id}`,
  });
});

/**
 * GET /api/ingest/cv/:id — one receipt.
 *
 * Two jobs. It is how the scanner polls an asynchronous parse to a terminal
 * status, and it is how it reconciles a request whose response it never saw — a
 * timeout that actually succeeded — WITHOUT re-POSTing the file. Returns the
 * receipt only: still no document text.
 */
router.get('/cv/:id', requirePermission('candidate.add'), (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return reject(res, 400, 'invalid-id', 'Ingestion id must be a positive integer.');
  }
  const record = ingestionById(id);
  if (!record) return reject(res, 404, 'not-found', 'Ingestion record not found.');
  return res.json(receipt(record, { reason: record.reason }));
});

/* ------------------------------- scan state -------------------------------- */

//
// The scanner's watermark: the instant of the last scan that completed with
// nothing left unprocessed. It lives HERE, in the ATS, rather than in the
// scanner, because the scanner is stateless between runs and a watermark held
// only in its memory is lost on every restart — which would mean either
// rescanning the whole mailbox or silently skipping a day.
//
// THE WATERMARK IS NOT THE DUPLICATE GUARD. Ingestion is already idempotent on
// (messageId, attachmentId), so an over-wide scan window costs redundant POSTs
// and nothing worse. That is the intended safety margin: it is always better to
// rescan than to skip, and this endpoint never has to be exactly right.
//

// ONE key for every source label. 'outlook' and 'microsoft_365' are the same
// mailbox, and a per-label watermark would silently reset to the first-run floor
// the day someone renamed the source — rescanning ~11k historical messages.
const SCAN_STATE_KEY = 'ingest.scan_state.mailbox';

// FIRST-RUN FLOOR. There is no earlier watermark to resume from, and the mailbox
// holds ~11k historical messages that were never meant to be ingested. Starting
// at the beginning of the first operating day bounds the first run to that day's
// applications instead of the entire history.
const FIRST_RUN_WATERMARK = '2026-09-01T00:00:00.000Z';

const readScanState = (source) => {
  const stored = SystemSettings.get(SCAN_STATE_KEY);
  return {
    source,
    lastSuccessfulScanAt: stored ?? FIRST_RUN_WATERMARK,
    isFirstRun: stored === undefined,
  };
};

router.get('/scan-state', requirePermission('candidate.add'), (req, res) => {
  const source = str(req.query.source) || DEFAULT_SOURCE;
  if (!isKnownSource(source)) {
    return reject(res, 400, 'source-unknown', 'Unrecognised ingestion source.',
      { source, accepted: knownSources() });
  }
  return res.json(readScanState(source));
});

/**
 * Advance the watermark after a scan that left nothing unprocessed.
 *
 * MOVES FORWARD ONLY by default. A backwards write is refused rather than
 * applied, because the ways it happens in practice — a clock skew, a partially
 * failed run reporting its start time, a replayed request — all silently widen
 * the next window or, worse, look like success. Deliberate reprocessing is still
 * available with `force: true`, and is safe precisely because ingestion is
 * idempotent.
 */
router.put('/scan-state', requirePermission('candidate.add'), (req, res) => {
  const source = str(req.body?.source) || DEFAULT_SOURCE;
  if (!isKnownSource(source)) {
    return reject(res, 400, 'source-unknown', 'Unrecognised ingestion source.',
      { source, accepted: knownSources() });
  }

  const raw = str(req.body?.lastSuccessfulScanAt);
  if (raw === '') {
    return reject(res, 400, 'scan-state-missing', 'lastSuccessfulScanAt is required.');
  }
  const next = new Date(raw);
  if (Number.isNaN(next.getTime())) {
    return reject(res, 400, 'scan-state-invalid',
      'lastSuccessfulScanAt must be an ISO-8601 timestamp.', { lastSuccessfulScanAt: raw });
  }

  const current = readScanState(source);
  const previous = new Date(current.lastSuccessfulScanAt);
  const force = req.body?.force === true;
  if (!force && next.getTime() < previous.getTime()) {
    return reject(res, 409, 'scan-state-regression',
      'Refusing to move the scan watermark backwards.', {
        current: current.lastSuccessfulScanAt,
        requested: next.toISOString(),
        hint: 'Send force: true to deliberately reprocess an earlier window.',
      });
  }

  SystemSettings.upsert(SCAN_STATE_KEY, next.toISOString());
  writeAudit(req, {
    action: 'cv.scan_state_advanced', entityType: 'ingest_scan_state', entityId: source,
    oldValue: { lastSuccessfulScanAt: current.lastSuccessfulScanAt },
    newValue: { lastSuccessfulScanAt: next.toISOString(), forced: force },
  });

  return res.json({
    source,
    lastSuccessfulScanAt: next.toISOString(),
    previous: current.lastSuccessfulScanAt,
    forced: force,
  });
});

export default router;
