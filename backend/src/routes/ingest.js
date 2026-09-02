// Inbound CV ingestion from an external mailbox.
//
// POST /api/ingest/cv — one CV attachment, with the provenance the mailbox
// reported for it. Used by the daily Microsoft 365 scan.
//
// WHY THIS IS A SEPARATE ROUTE AND NOT A FLAG ON /candidates/parse-cv.
// `parse-cv` serves a HUMAN at a browser: it answers with a parse preview, a
// per-field import report and the raw text a reviewer is about to judge. That
// response is exactly what an automated mailbox connector must NOT receive —
// it would ship CV contents to a caller that has no screen and no need for
// them. This route answers with a receipt: identifiers and a status, no
// document text. Same storage, same parser, same intake queue underneath.
//
// WHAT IT DOES NOT DO. It never creates or updates a candidate. It stages a
// `candidate_intake` exactly as `parse-cv` does, and a person approving that
// intake is still the only thing in this system that creates a candidate. There
// is no shortcut here and there is deliberately no flag to add one.
//
// IDEMPOTENCY IS THE POINT. The orchestrator retries. See ingest-store.js: the
// identity is claimed against a unique index BEFORE the CV is parsed, so a
// retry costs one rejected INSERT rather than a second parse and a second
// review item.

import { Router } from 'express';
import crypto from 'node:crypto';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { writeAudit } from '../lib/audit.js';
import { SystemSettings } from '../lib/models.js';
import { multipart, readBlob, uploadPath, deleteBlob } from '../lib/upload.js';
import { parseDocument } from '../lib/parsing/pipeline-provider.js';
import { createIntake } from '../lib/intake-store.js';
import {
  claimIngestion, ingestionById, isKnownSource, isRetryable, markFailed,
  markNoFields, markParsed, priorIngestionsWithHash, reopenFailedIngestion,
  INGEST_STATUS, MICROSOFT_365 as MICROSOFT_365_DEFAULT,
} from '../lib/ingest-store.js';

const router = Router();
router.use(requireAuth);

/**
 * CV document types only.
 *
 * The shared upload middleware also accepts images and .txt because other
 * routes need them. A mailbox connector must not widen this: an inbox is full
 * of signatures, logos, scanned certificates and spreadsheets, and every one of
 * them that reaches the parser costs a model call and produces a junk review
 * item. Anything outside this set is rejected before it is parsed.
 */
const CV_EXTENSIONS = new Set(['.pdf', '.doc', '.docx']);
const MIME_BY_EXT = {
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

/** Provenance the receipt cannot be written without. */
const REQUIRED_FIELDS = ['source', 'messageId', 'attachmentId', 'filename'];

const str = (v) => (typeof v === 'string' ? v.trim() : '');

/**
 * Reject with a machine-readable code.
 *
 * The orchestrator branches on `code`, never on the sentence, so the codes are
 * part of this endpoint's contract and the sentences are not.
 */
const reject = (res, status, code, message, extra = {}) =>
  res.status(status).json({ status: 'rejected', code, error: message, ...extra });

/**
 * The receipt shape returned on every non-rejection path.
 *
 * DELIBERATELY CARRIES NO DOCUMENT TEXT — no parsed fields, no preview, no
 * extracted values. A connector needs to know what happened to the file, not
 * what the file said. The review screen reads the intake directly.
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
      'Unrecognised ingestion source.', { source });
  }

  // The extension is taken from the STORED file, not from the `filename` field:
  // the field is caller-supplied text and the two can disagree.
  if (!CV_EXTENSIONS.has(f.ext)) {
    cleanup();
    return reject(res, 400, 'unsupported-file-type',
      'Only PDF, DOC and DOCX CV files are accepted.',
      { extension: f.ext || null, accepted: [...CV_EXTENSIONS] });
  }

  // `receivedAt` is provenance, so a malformed one is a defect in the caller
  // worth surfacing rather than silently storing. Absent is allowed; wrong is not.
  const receivedAtRaw = str(fields.receivedAt);
  let receivedAt = null;
  if (receivedAtRaw !== '') {
    const d = new Date(receivedAtRaw);
    if (Number.isNaN(d.getTime())) {
      cleanup();
      return reject(res, 400, 'received-at-invalid',
        'receivedAt must be an ISO-8601 timestamp.', { receivedAt: receivedAtRaw });
    }
    receivedAt = d.toISOString();
  }

  // ------------------------------------------------------------------- hash
  // SHA-256 over the bytes AS STORED. A client-supplied hash is never read,
  // even if one is posted: a hash the server did not compute is a claim, not a
  // checksum, and this value decides what counts as the same document.
  const stored = readBlob(f.storedName);
  if (!stored || !stored.data) {
    return reject(res, 500, 'storage-unavailable',
      'The uploaded file could not be stored or read back.');
  }
  const contentHash = crypto.createHash('sha256').update(stored.data).digest('hex');

  // ------------------------------------------------------------------ claim
  // Before parsing, so a retry is one rejected INSERT instead of a second model
  // call and a second review item.
  let claim;
  try {
    claim = claimIngestion({
      source,
      messageId: str(fields.messageId),
      attachmentId: str(fields.attachmentId),
      senderEmail: str(fields.senderEmail) || null,
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

  if (!claim.claimed) {
    // Already ingested. A FAILED receipt is the one case worth another attempt;
    // everything else is answered as a duplicate without re-parsing.
    const reopened = isRetryable(record) ? reopenFailedIngestion(record.id) : null;
    if (!reopened) {
      cleanup(); // this request's bytes are redundant; the winner's copy stands
      console.log(JSON.stringify({
        level: 'info', msg: 'ingest.duplicate', requestId: req.requestId,
        ingestionId: record.id, source, status: record.status,
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

  // ------------------------------------------------------- parse + stage
  // Outside any transaction: parsing is async and tx() forbids async callbacks
  // (see db.js). The claim above is what makes that safe — the identity is
  // already held, so nothing else can start a second parse for it.
  try {
    const parsed = await parseDocument(uploadPath(f.storedName));

    if (!parsed.ok || !parsed.fields || parsed.fields.length === 0) {
      const reason = parsed.reason
        || 'No candidate field could be supported by the document.';
      const settled = markNoFields(record.id, reason);
      writeAudit(req, {
        action: 'cv.ingested_no_fields', entityType: 'cv_ingestion',
        entityId: record.id,
        newValue: { source, filename: record.filename, reason },
      });
      // 201, not an error: the attachment WAS ingested and its receipt is
      // durable. Re-sending it would read to the same nothing.
      return res.status(201).json({
        ...receipt(settled),
        code: 'no-fields',
        reason,
        message: 'Ingested. The document produced no reviewable candidate fields.',
      });
    }

    const intake = createIntake({
      storedName: f.storedName,
      fileName: record.filename,
      mimeType: record.mimeType,
      fileHash: contentHash,
      // Distinguishes a mailbox ingestion from a recruiter's own upload
      // everywhere downstream, without a second intake model.
      origin: 'mailbox.ingest',
      modelId: parsed.generation?.modelId ?? '',
      documentId: parsed.documentId,
      generation: parsed.generation,
      fields: parsed.fields,
      createdBy: req.user.id,
    });

    if (!intake) {
      const reason = 'Parse produced no reviewable fields.';
      const settled = markNoFields(record.id, reason);
      return res.status(201).json({
        ...receipt(settled), code: 'no-fields', reason,
        message: 'Ingested. The document produced no reviewable candidate fields.',
      });
    }

    const settled = markParsed(record.id, intake.id);

    writeAudit(req, {
      action: 'cv.ingested', entityType: 'cv_ingestion', entityId: record.id,
      newValue: {
        source, messageId: settled.messageId, attachmentId: settled.attachmentId,
        filename: settled.filename, intakeId: intake.id, fields: intake.fields.length,
      },
    });

    console.log(JSON.stringify({
      level: 'info', msg: 'ingest.accepted', requestId: req.requestId,
      ingestionId: settled.id, intakeId: intake.id, source,
      // Counts and identifiers only — never the parsed values themselves.
      fields: intake.fields.length,
    }));

    return res.status(201).json({
      ...receipt(settled),
      code: 'accepted',
      // PENDING review. No candidate exists yet.
      intakeStatus: intake.status,
      fieldCount: intake.fields.length,
      // Advisory only: same bytes seen before, under a different message.
      priorHashMatches: priorIngestionsWithHash(contentHash, settled.id)
        .map((r) => r.id),
      message: 'Ingested and staged for review. No candidate was created.',
    });
  } catch (e) {
    // The receipt survives the failure, marked FAILED and therefore retryable.
    // Losing it would let the next scan re-parse this attachment from scratch.
    let settled = null;
    try { settled = markFailed(record.id, e.message); } catch { /* record stands */ }
    console.error(JSON.stringify({
      level: 'error', msg: 'ingest.parse_failed', requestId: req.requestId,
      ingestionId: record.id, source, error: e.message, stack: e.stack,
    }));
    return res.status(502).json({
      ...receipt(settled ?? record),
      status: INGEST_STATUS.FAILED,
      code: 'parse-failed',
      retryable: true,
      // The driver's sentence, not the document's contents.
      error: 'CV parsing failed downstream.',
      message: 'Ingestion recorded and marked failed. Safe to retry.',
    });
  }
});

/**
 * GET /api/ingest/cv/:id — one receipt.
 *
 * Lets the orchestrator reconcile a request whose response it never saw (a
 * timeout that actually succeeded) without re-POSTing the file. Returns the
 * receipt only: still no document text.
 */
router.get('/cv/:id', requirePermission('candidate.add'), (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return reject(res, 400, 'invalid-id', 'Ingestion id must be a positive integer.');
  }
  const record = ingestionById(id);
  if (!record) return reject(res, 404, 'not-found', 'Ingestion record not found.');
  return res.json(receipt(record));
});

/* ------------------------------- scan state -------------------------------- */

//
// The orchestrator's watermark: the instant of the last scan that completed
// with nothing left unprocessed. It lives HERE, in the ATS, rather than in the
// connector, because the connector is stateless between runs and a watermark
// held only in its memory is lost on every restart — which would mean either
// rescanning the whole mailbox or silently skipping a day.
//
// THE WATERMARK IS NOT THE DUPLICATE GUARD. Ingestion is already idempotent on
// (source, messageId, attachmentId), so an over-wide scan window costs redundant
// POSTs and nothing worse. That is the intended safety margin: it is always
// better to rescan than to skip, and this endpoint never has to be exactly right.
//

const SCAN_STATE_KEY = (source) => `ingest.scan_state.${source}`;

// FIRST-RUN FLOOR. There is no earlier watermark to resume from, and the mailbox
// holds ~11k historical messages that were never meant to be ingested. Starting
// at the beginning of the first operating day bounds the first run to that day's
// applications instead of the entire history.
const FIRST_RUN_WATERMARK = '2026-09-01T00:00:00.000Z';

const readScanState = (source) => {
  const stored = SystemSettings.get(SCAN_STATE_KEY(source));
  return {
    source,
    lastSuccessfulScanAt: stored ?? FIRST_RUN_WATERMARK,
    isFirstRun: stored === undefined,
  };
};

router.get('/scan-state', requirePermission('candidate.add'), (req, res) => {
  const source = str(req.query.source) || MICROSOFT_365_DEFAULT;
  if (!isKnownSource(source)) {
    return reject(res, 400, 'source-unknown', 'Unrecognised ingestion source.', { source });
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
  const source = str(req.body?.source) || MICROSOFT_365_DEFAULT;
  if (!isKnownSource(source)) {
    return reject(res, 400, 'source-unknown', 'Unrecognised ingestion source.', { source });
  }

  const raw = str(req.body?.lastSuccessfulScanAt);
  if (raw === '') {
    return reject(res, 400, 'scan-state-missing',
      'lastSuccessfulScanAt is required.');
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

  SystemSettings.upsert(SCAN_STATE_KEY(source), next.toISOString());
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
