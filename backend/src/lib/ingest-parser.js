// Parsing half of CV ingestion — everything that happens AFTER the response.
//
// WHY THIS IS NOT IN THE ROUTE. The scanner must not wait on a model call. A
// CV parse is two Anthropic round-trips and can take tens of seconds; a mailbox
// connector that blocks on it will time out, retry, and pile up. So the route
// claims the attachment, answers 201, and hands the work here.
//
// WHY THERE IS NO JOB TABLE AND NO IN-MEMORY QUEUE. The `cv_ingestion` row IS
// the work item: a receipt sitting in RECEIVED is, by definition, a parse that
// has not finished. That makes the queue durable for free — unlike the
// in-process `Map` behind `/parse-cv-async`, which is documented as ephemeral
// and loses every in-flight job on restart. `recoverStranded()` below turns
// that durability into actual recovery on the next boot.
//
// NOTHING HERE CREATES A CANDIDATE. It stages a PENDING `candidate_intake`
// through the same `createIntake()` the manual upload path uses. Approval is
// still the only thing in this system that creates a candidate.

import { Audit } from './models.js';
import { uploadPath } from './upload.js';
import { parseDocument } from './parsing/pipeline-provider.js';
import { createIntake } from './intake-store.js';
import {
  beginParse, ingestionById, markFailed, markNoFields, markParsed,
  strandedIngestions,
} from './ingest-store.js';

/** Audit without an HTTP request behind it (recovery runs at boot, not in a route). */
function audit(action, record, newValue) {
  try {
    Audit.write({
      actorId: record.createdBy ?? null,
      actorName: null,
      actorRole: null,
      action,
      entityType: 'cv_ingestion',
      entityId: String(record.id),
      oldValue: null,
      newValue,
      comments: null,
      ip: null,
      userAgent: null,
    });
  } catch (e) {
    console.error('Audit write failed:', e.message);
  }
}

/**
 * Parse one claimed receipt and settle it.
 *
 * Always resolves — never rejects. It runs detached from the request that
 * created it, so an unhandled rejection here would be an unhandled rejection on
 * the process, and on some Node configurations that is fatal. Every failure path
 * settles the receipt as FAILED instead, which is both the durable record of
 * what happened and the thing that makes the attachment retryable.
 *
 * @returns {Promise<{status: string, intakeId: number|null}>}
 */
export async function parseAndSettle(claimed) {
  const record = beginParse(claimed.id) ?? claimed;

  try {
    const parsed = await parseDocument(uploadPath(record.storedName));

    if (!parsed.ok || !parsed.fields || parsed.fields.length === 0) {
      const reason = parsed.reason
        || 'No candidate field could be supported by the document.';
      const settled = markNoFields(record.id, reason);
      audit('cv.ingested_no_fields', record, {
        source: record.source, filename: record.filename, reason,
      });
      return { status: settled.status, intakeId: null };
    }

    const intake = createIntake({
      storedName: record.storedName,
      fileName: record.filename,
      mimeType: record.mimeType,
      fileHash: record.contentHash,
      // Distinguishes a mailbox ingestion from a recruiter's own upload
      // everywhere downstream, without a second intake model.
      origin: 'mailbox.ingest',
      modelId: parsed.generation?.modelId ?? '',
      documentId: parsed.documentId,
      generation: parsed.generation,
      fields: parsed.fields,
      createdBy: record.createdBy ?? null,
    });

    if (!intake) {
      const settled = markNoFields(record.id, 'Parse produced no reviewable fields.');
      return { status: settled.status, intakeId: null };
    }

    const settled = markParsed(record.id, intake.id);
    audit('cv.ingested', record, {
      source: record.source, messageId: record.messageId,
      attachmentId: record.attachmentId, filename: record.filename,
      intakeId: intake.id, fields: intake.fields.length,
    });
    console.log(JSON.stringify({
      level: 'info', msg: 'ingest.parsed', ingestionId: record.id,
      intakeId: intake.id, source: record.source,
      // Counts and identifiers only — never the parsed values themselves.
      fields: intake.fields.length,
    }));
    return { status: settled.status, intakeId: intake.id };
  } catch (e) {
    // The receipt survives the failure, marked FAILED and therefore retryable.
    // Losing it would let the next scan re-parse this attachment from scratch.
    try { markFailed(record.id, e.message); } catch { /* record stands */ }
    console.error(JSON.stringify({
      level: 'error', msg: 'ingest.parse_failed', ingestionId: record.id,
      source: record.source, error: e.message,
    }));
    return { status: 'FAILED', intakeId: null };
  }
}

/**
 * Kick off a parse without making the caller wait.
 *
 * `setImmediate` rather than a bare call so the HTTP response is flushed first —
 * on the SQLite driver a synchronous parse step would otherwise block the event
 * loop before the socket drains. The promise is deliberately not awaited, and
 * `parseAndSettle` never rejects, so there is nothing to leak.
 */
export function scheduleParse(record) {
  setImmediate(() => { void parseAndSettle(record); });
}

/**
 * Re-drive receipts stranded mid-parse by a restart.
 *
 * Called once at boot. Deliberately conservative: only rows that have been
 * sitting in RECEIVED longer than the grace window are touched, so a parse that
 * is genuinely in flight on another worker is left alone, and `maxAttempts`
 * stops a document that reliably crashes the parser from being retried forever.
 */
export async function recoverStranded(opts = {}) {
  let stranded = [];
  try {
    stranded = strandedIngestions(opts);
  } catch (e) {
    // The table may not exist yet on a very first boot.
    console.error(JSON.stringify({
      level: 'warn', msg: 'ingest.recovery_skipped', error: e.message,
    }));
    return { recovered: 0 };
  }
  if (stranded.length === 0) return { recovered: 0 };

  console.log(JSON.stringify({
    level: 'info', msg: 'ingest.recovering_stranded', count: stranded.length,
    ids: stranded.map((r) => r.id),
  }));

  for (const record of stranded) {
    // Sequential on purpose: recovery competes with live traffic for the same
    // parser, and a boot-time burst of model calls is how a restart turns into
    // an outage.
    // eslint-disable-next-line no-await-in-loop
    await parseAndSettle(record);
  }
  return { recovered: stranded.length };
}

/** Re-read a receipt. Exported so the route can answer a status poll. */
export { ingestionById };
