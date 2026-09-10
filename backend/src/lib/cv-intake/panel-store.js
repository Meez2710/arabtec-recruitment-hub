// CV Intake control panel — the data layer.
//
// WHAT THIS IS FOR. The mailbox sync records every attachment it sees in
// `mailbox_ingestion` and, on its own, would parse each one as it arrives.
// This module puts a person in front of that: attachments wait, someone with
// the right permission looks at what is waiting, chooses a category and a
// quantity, and approves a BATCH. Only then is model budget spent, and only
// then does anything reach the review queue.
//
// THE APPROVAL IS THE RECORD. cv_intake_batch.approved_by / approved_at answer
// "who authorised this and when", which is the question an auditor asks. It is
// deliberately separate from controlled_by (who paused or cancelled) and from
// each item's imported_by, because those are three different authorities and
// collapsing them would lose exactly the distinction the permissions draw.
//
// NOTHING HERE CHECKS PERMISSIONS. Enforcement belongs on the routes, once, at
// the edge — see routes/cv-intake.js. A store function that also authorised
// would invite a second, divergent copy of the rules.

import { get, all, run, tx } from '../db.js';
import { SystemSettings } from '../models.js';

/* ------------------------------- limits ---------------------------------- */

export const LIMITS_KEY = 'cv_intake_limits';

/** Ceilings only an administrator may change. Managers choose within them. */
const DEFAULT_LIMITS = Object.freeze({
  maxBatchSize: 25,
  maxConcurrency: 2,
  // A batch nobody has processed within this many minutes is reported as
  // stalled in the panel rather than sitting on "PROCESSING" forever.
  stallMinutes: 60,
});

export function limits() {
  try {
    const raw = SystemSettings.get(LIMITS_KEY);
    if (!raw) return { ...DEFAULT_LIMITS };
    const parsed = JSON.parse(raw);
    return {
      maxBatchSize: clampInt(parsed.maxBatchSize, 1, 500, DEFAULT_LIMITS.maxBatchSize),
      maxConcurrency: clampInt(parsed.maxConcurrency, 1, 16, DEFAULT_LIMITS.maxConcurrency),
      stallMinutes: clampInt(parsed.stallMinutes, 5, 1440, DEFAULT_LIMITS.stallMinutes),
    };
  } catch { return { ...DEFAULT_LIMITS }; }
}

export function saveLimits(draft) {
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) {
    throw new Error('Processing limits must be an object.');
  }
  const current = limits();
  const next = {
    maxBatchSize: clampInt(draft.maxBatchSize, 1, 500, current.maxBatchSize),
    maxConcurrency: clampInt(draft.maxConcurrency, 1, 16, current.maxConcurrency),
    stallMinutes: clampInt(draft.stallMinutes, 5, 1440, current.stallMinutes),
  };
  SystemSettings.set(LIMITS_KEY, JSON.stringify(next));
  return next;
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/* ---------------------------- classification ------------------------------ */

/**
 * The job category for one waiting attachment.
 *
 * On the careers mailbox the category IS the subject line: real applications
 * arrive titled "Senior Cost Control Engineer", "QC Engineer",
 * "procurement officer". So the rule is to match the subject against the
 * designation catalogue the ATS already holds, longest name first — otherwise
 * "Engineer" would swallow "Cost Control Engineer".
 *
 * NO MATCH IS NOT A FAILURE. It becomes `Unclassified`, which the panel shows
 * as its own bucket precisely so nobody has to guess: a human reads those and
 * decides. Inventing a category from a weak signal would put people in the
 * wrong pile silently, which is worse than an honest "don't know".
 */
let designationCache = null;
let designationCachedAt = 0;
const DESIGNATION_TTL_MS = 5 * 60 * 1000;

export function designationNames() {
  const now = Date.now();
  if (designationCache && now - designationCachedAt < DESIGNATION_TTL_MS) return designationCache;
  let rows = [];
  try { rows = all('SELECT title FROM designation') || []; } catch { rows = []; }
  designationCache = rows
    .map((r) => String(r.title || '').trim())
    .filter((t) => t.length >= 3)
    .sort((a, b) => b.length - a.length);      // longest first — see above
  designationCachedAt = now;
  return designationCache;
}

/** Test seam: forget the cached catalogue. */
export function resetDesignationCache() { designationCache = null; designationCachedAt = 0; }

export const UNCLASSIFIED = 'Unclassified';

export function classifySubject(subject) {
  const text = String(subject || '').toLowerCase();
  if (!text.trim()) return UNCLASSIFIED;
  for (const title of designationNames()) {
    if (text.includes(title.toLowerCase())) return title;
  }
  return UNCLASSIFIED;
}

/* -------------------------------- summary --------------------------------- */

/**
 * What is waiting, grouped the way the panel presents it.
 *
 * "Waiting" means an ingestion row that no batch has claimed. A row already in
 * a batch is that batch's business and is reported under batch state instead —
 * showing it in both places would double-count the same CV and make the totals
 * disagree with themselves.
 */
export function intakeSummary({ from = null, to = null } = {}) {
  const where = ["mi.status IN ('IMPORTED','PROCESSING')"];
  const params = [];
  if (from) { where.push('mi.received_at >= ?'); params.push(from); }
  if (to) { where.push('mi.received_at <= ?'); params.push(to); }

  const rows = all(
    `SELECT mi.id, mi.subject, mi.category, mi.content_hash, mi.attachment_name, mi.received_at
       FROM mailbox_ingestion mi
       LEFT JOIN cv_intake_batch_item bi ON bi.ingestion_id = mi.id
      WHERE ${where.join(' AND ')} AND bi.id IS NULL
      ORDER BY mi.received_at DESC`, params) || [];

  const byCategory = new Map();
  const seenHash = new Map();
  let duplicates = 0;

  for (const row of rows) {
    const category = row.category || classifySubject(row.subject);
    const bucket = byCategory.get(category) || { category, count: 0, duplicates: 0, oldest: null, newest: null };
    bucket.count += 1;
    if (!bucket.newest || (row.received_at && row.received_at > bucket.newest)) bucket.newest = row.received_at;
    if (!bucket.oldest || (row.received_at && row.received_at < bucket.oldest)) bucket.oldest = row.received_at;

    // A duplicate is the SAME BYTES arriving twice — candidates routinely apply
    // to several adverts with one file. Counted, never auto-discarded: which
    // copy to keep is a decision, and the ingestion ledger already stops the
    // same attachment being parsed twice.
    if (row.content_hash) {
      if (seenHash.has(row.content_hash)) { duplicates += 1; bucket.duplicates += 1; }
      else seenHash.set(row.content_hash, row.id);
    }
    byCategory.set(category, bucket);
  }

  const categories = [...byCategory.values()].sort((a, b) => {
    // Unclassified sits last however large it is: it is a to-do list, not a
    // job category, and sorting it to the top would bury the real ones.
    if (a.category === UNCLASSIFIED) return 1;
    if (b.category === UNCLASSIFIED) return -1;
    return b.count - a.count || a.category.localeCompare(b.category);
  });

  return {
    waiting: rows.length,
    duplicates,
    categories,
    unclassified: byCategory.get(UNCLASSIFIED)?.count ?? 0,
    batches: batchStateCounts(),
    limits: limits(),
    range: { from, to },
  };
}

export function batchStateCounts() {
  const rows = all('SELECT status, COUNT(*) AS n FROM cv_intake_batch GROUP BY status') || [];
  const counts = {
    PENDING: 0, PROCESSING: 0, PAUSED: 0, AWAITING_REVIEW: 0,
    COMPLETED: 0, FAILED: 0, CANCELLED: 0,
  };
  for (const r of rows) if (r.status in counts) counts[r.status] = Number(r.n) || 0;
  return counts;
}

/* --------------------------------- queue ---------------------------------- */

/** Waiting attachments, optionally narrowed to one category. */
export function waitingItems({ category = null, from = null, to = null, limit = 100, offset = 0 } = {}) {
  const where = ["mi.status IN ('IMPORTED','PROCESSING')"];
  const params = [];
  if (from) { where.push('mi.received_at >= ?'); params.push(from); }
  if (to) { where.push('mi.received_at <= ?'); params.push(to); }

  const rows = all(
    `SELECT mi.id, mi.subject, mi.sender, mi.category, mi.attachment_name,
            mi.content_hash, mi.received_at, mi.intake_id
       FROM mailbox_ingestion mi
       LEFT JOIN cv_intake_batch_item bi ON bi.ingestion_id = mi.id
      WHERE ${where.join(' AND ')} AND bi.id IS NULL
      ORDER BY mi.received_at DESC`, params) || [];

  const withCategory = rows.map((r) => ({ ...r, category: r.category || classifySubject(r.subject) }));
  const filtered = category ? withCategory.filter((r) => r.category === category) : withCategory;
  const page = filtered.slice(Math.max(0, offset), Math.max(0, offset) + Math.max(1, Math.min(limit, 500)));

  const seen = new Set();
  return {
    total: filtered.length,
    items: page.map((r) => {
      const duplicate = !!r.content_hash && seen.has(r.content_hash);
      if (r.content_hash) seen.add(r.content_hash);
      return {
        id: r.id,
        subject: r.subject || null,
        // The sender address is a candidate identifier. It is returned here
        // because cv_intake.view already implies seeing who applied; the CV
        // itself stays behind cv_intake.preview.
        sender: r.sender || null,
        attachmentName: r.attachment_name || null,
        category: r.category,
        receivedAt: r.received_at || null,
        duplicate,
      };
    }),
  };
}

/* -------------------------------- batches --------------------------------- */

export const BATCH_STATUS = Object.freeze({
  PENDING: 'PENDING', PROCESSING: 'PROCESSING', PAUSED: 'PAUSED',
  AWAITING_REVIEW: 'AWAITING_REVIEW', COMPLETED: 'COMPLETED',
  FAILED: 'FAILED', CANCELLED: 'CANCELLED',
});

/** Which transitions are legal. A control action outside this table is refused. */
const TRANSITIONS = Object.freeze({
  PENDING: ['PROCESSING', 'PAUSED', 'CANCELLED'],
  PROCESSING: ['AWAITING_REVIEW', 'PAUSED', 'FAILED', 'CANCELLED', 'COMPLETED'],
  PAUSED: ['PENDING', 'PROCESSING', 'CANCELLED'],
  AWAITING_REVIEW: ['COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  FAILED: ['PENDING', 'CANCELLED'],
  CANCELLED: [],
});

export function canTransition(from, to) {
  return (TRANSITIONS[from] || []).includes(to);
}

const nowISO = () => new Date().toISOString();

/**
 * Approve a batch.
 *
 * `ingestionIds` is the explicit selection. A category plus a quantity is
 * resolved to ids by the caller, so this function never has to guess what the
 * approver meant — an approval records exactly the attachments it covered.
 */
export function createBatch({ ingestionIds, category = null, actorId, requestedCount = null }) {
  const ids = [...new Set((ingestionIds || []).map((n) => Number(n)).filter(Number.isInteger))];
  if (!ids.length) throw new Error('Select at least one CV to approve.');

  const max = limits().maxBatchSize;
  if (ids.length > max) {
    throw new Error(`This batch has ${ids.length} CVs but the administrator's limit is ${max}.`);
  }

  return tx(() => {
    // Re-check inside the transaction. Two managers approving overlapping
    // selections at the same moment is an ordinary race, and the UNIQUE index
    // on ingestion_id is what actually settles it — this check exists to turn
    // that into a readable error rather than a constraint violation.
    const claimed = all(
      `SELECT ingestion_id FROM cv_intake_batch_item
        WHERE ingestion_id IN (${ids.map(() => '?').join(',')})`, ids) || [];
    if (claimed.length) {
      throw new Error(`${claimed.length} of the selected CVs are already in another batch.`);
    }

    const rows = all(
      `SELECT id, subject, category, attachment_name, content_hash
         FROM mailbox_ingestion WHERE id IN (${ids.map(() => '?').join(',')})`, ids) || [];
    if (rows.length !== ids.length) throw new Error('Some selected CVs no longer exist.');

    const at = nowISO();
    run(`INSERT INTO cv_intake_batch
           (status, category, requested_count, total_items, approved_by, approved_at, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?)`,
    [BATCH_STATUS.PENDING, category, Number(requestedCount ?? ids.length), rows.length,
      actorId ?? null, at, at, at]);

    const batchId = get('SELECT id FROM cv_intake_batch ORDER BY id DESC LIMIT 1')?.id;
    for (const r of rows) {
      run(`INSERT INTO cv_intake_batch_item
             (batch_id, ingestion_id, status, attachment_name, content_hash, category, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?)`,
      [batchId, r.id, 'PENDING', r.attachment_name ?? null, r.content_hash ?? null,
        r.category || classifySubject(r.subject), at, at]);
    }
    return batchById(batchId);
  });
}

export function batchById(id) {
  const row = get('SELECT * FROM cv_intake_batch WHERE id=?', [Number(id)]);
  if (!row) return null;
  const items = all('SELECT * FROM cv_intake_batch_item WHERE batch_id=? ORDER BY id', [row.id]) || [];
  return shapeBatch(row, items);
}

export function listBatches({ status = null, limit = 50 } = {}) {
  const rows = status
    ? all('SELECT * FROM cv_intake_batch WHERE status=? ORDER BY id DESC LIMIT ?', [status, limit])
    : all('SELECT * FROM cv_intake_batch ORDER BY id DESC LIMIT ?', [limit]);
  return (rows || []).map((r) => shapeBatch(r, []));
}

function shapeBatch(row, items) {
  return {
    id: row.id,
    status: row.status,
    category: row.category,
    requestedCount: row.requested_count,
    totals: {
      items: row.total_items,
      processed: row.processed_items,
      failed: row.failed_items,
      imported: row.imported_items,
    },
    approvedBy: row.approved_by ?? null,
    approvedAt: row.approved_at ?? null,
    controlledBy: row.controlled_by ?? null,
    controlledAt: row.controlled_at ?? null,
    controlReason: row.control_reason ?? null,
    lastError: row.last_error ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    items: items.map((i) => ({
      id: i.id,
      ingestionId: i.ingestion_id,
      intakeId: i.intake_id ?? null,
      status: i.status,
      attachmentName: i.attachment_name,
      category: i.category,
      reason: i.reason ?? null,
      attempts: i.attempts,
      importedBy: i.imported_by ?? null,
      importedAt: i.imported_at ?? null,
    })),
  };
}

/**
 * Pause, resume or cancel.
 *
 * REVOKING THE APPROVER'S PERMISSION DOES NOT REACH HERE. A batch already
 * approved keeps running; halting it is a separate authority (cv_intake.control)
 * held by someone who still has it. That is deliberate — an administrator
 * tidying up permissions should not silently stop work in flight.
 */
export function controlBatch({ id, action, actorId, reason = null }) {
  const row = get('SELECT * FROM cv_intake_batch WHERE id=?', [Number(id)]);
  if (!row) throw new Error('Batch not found.');

  const target = action === 'pause' ? BATCH_STATUS.PAUSED
    : action === 'resume' ? BATCH_STATUS.PENDING
      : action === 'cancel' ? BATCH_STATUS.CANCELLED
        : null;
  if (!target) throw new Error(`Unknown action: ${action}`);

  if (!canTransition(row.status, target)) {
    throw new Error(`A ${row.status.toLowerCase().replace(/_/g, ' ')} batch cannot be ${action}d.`);
  }

  const at = nowISO();
  return tx(() => {
    run(`UPDATE cv_intake_batch
            SET status=?, controlled_by=?, controlled_at=?, control_reason=?, updated_at=?
          WHERE id=?`, [target, actorId ?? null, at, reason, at, row.id]);
    if (target === BATCH_STATUS.CANCELLED) {
      // Only work that has not started. An item already parsed keeps its
      // result — cancelling a batch must not throw away model spend that
      // already happened, nor a CV already waiting for a reviewer.
      run(`UPDATE cv_intake_batch_item SET status='CANCELLED', updated_at=?
            WHERE batch_id=? AND status='PENDING'`, [at, row.id]);
    }
    return batchById(row.id);
  });
}

/** Record that a reviewer approved one parsed CV into the ATS. */
export function markItemImported({ itemId, intakeId, actorId }) {
  const at = nowISO();
  return tx(() => {
    const item = get('SELECT * FROM cv_intake_batch_item WHERE id=?', [Number(itemId)]);
    if (!item) throw new Error('Batch item not found.');
    if (item.status === 'IMPORTED') return batchById(item.batch_id);
    run(`UPDATE cv_intake_batch_item
            SET status='IMPORTED', intake_id=COALESCE(?, intake_id), imported_by=?, imported_at=?, updated_at=?
          WHERE id=?`, [intakeId ?? null, actorId ?? null, at, at, item.id]);
    run(`UPDATE cv_intake_batch SET imported_items=imported_items+1, updated_at=? WHERE id=?`,
      [at, item.batch_id]);

    // A batch whose every item has reached a terminal state is complete.
    const remaining = get(
      `SELECT COUNT(*) AS n FROM cv_intake_batch_item
        WHERE batch_id=? AND status NOT IN ('IMPORTED','FAILED','CANCELLED')`, [item.batch_id])?.n;
    if (Number(remaining) === 0) {
      const b = get('SELECT status FROM cv_intake_batch WHERE id=?', [item.batch_id]);
      if (b && canTransition(b.status, BATCH_STATUS.COMPLETED)) {
        run('UPDATE cv_intake_batch SET status=?, updated_at=? WHERE id=?',
          [BATCH_STATUS.COMPLETED, at, item.batch_id]);
      }
    }
    return batchById(item.batch_id);
  });
}
