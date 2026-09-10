// CV Intake control panel — HTTP surface.
//
// ENFORCEMENT LIVES HERE, ON EVERY ROUTE, ONE PERMISSION EACH. The panel hides
// what a user cannot do, but hiding is a courtesy — the check that matters is
// this one, because a direct `curl` never renders the panel. Each route names
// exactly the capability it needs, so a user granted only `cv_intake.view` can
// read the queue and is refused at `POST /batches` with a 403, not a blank page.
//
// WHY FIVE PERMISSIONS AND NOT ONE. Reading a queue, opening a stranger's CV,
// spending model budget, halting someone else's work, and putting a person into
// the candidate database are five different authorities. An organisation
// nervous about this feature grants them one at a time, to named people.
//
// REVOCATION IS IMMEDIATE AND NEEDS NOTHING HERE. requireAuth calls
// loadUserContext() on every request, so req.user.permissions is read from the
// database each time — never from the JWT. An administrator who removes a
// permission has removed it by the user's next call, mid-session, with no
// logout and no token rotation. The test suite proves exactly that.

import { Router } from 'express';
import fs from 'node:fs';

import { requireAuth, requirePermission } from '../middleware/auth.js';
import { writeAudit } from '../lib/audit.js';
import { streamFile } from '../lib/upload.js';
import { get } from '../lib/db.js';
import {
  intakeSummary, waitingItems, limits, saveLimits,
  createBatch, batchById, listBatches, controlBatch, markItemImported,
  classifySubject,
} from '../lib/cv-intake/panel-store.js';

const router = Router();

router.use(requireAuth);

/** Parse a YYYY-MM-DD (or ISO) filter without letting junk reach SQL. */
function isoOrNull(value) {
  if (!value) return null;
  const s = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}([T ].*)?$/.test(s)) return null;
  const d = new Date(s.length === 10 ? `${s}T00:00:00.000Z` : s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/* -------------------------------- reading --------------------------------- */

router.get('/summary', requirePermission('cv_intake.view'), (req, res) => {
  try {
    res.json(intakeSummary({ from: isoOrNull(req.query.from), to: isoOrNull(req.query.to) }));
  } catch (e) {
    res.status(500).json({ error: 'Could not read the intake summary.' });
    console.error(JSON.stringify({ level: 'error', msg: 'cv_intake.summary_failed', error: e.message }));
  }
});

router.get('/queue', requirePermission('cv_intake.view'), (req, res) => {
  try {
    res.json(waitingItems({
      category: req.query.category ? String(req.query.category) : null,
      from: isoOrNull(req.query.from),
      to: isoOrNull(req.query.to),
      limit: Number.parseInt(req.query.limit, 10) || 100,
      offset: Number.parseInt(req.query.offset, 10) || 0,
    }));
  } catch (e) {
    res.status(500).json({ error: 'Could not read the intake queue.' });
    console.error(JSON.stringify({ level: 'error', msg: 'cv_intake.queue_failed', error: e.message }));
  }
});

/**
 * The email behind one waiting attachment.
 *
 * SEPARATE FROM cv_intake.view ON PURPOSE. The queue shows what is waiting and
 * roughly what it is; this shows a named individual's application. Those are
 * different levels of exposure to a candidate's personal data and the
 * permissions draw the line between them.
 */
router.get('/items/:id/preview', requirePermission('cv_intake.preview'), (req, res) => {
  const row = get(`SELECT id, subject, sender, category, attachment_name, content_hash,
                          received_at, status, stored_name, intake_id
                     FROM mailbox_ingestion WHERE id=?`, [Number(req.params.id)]);
  if (!row) return res.status(404).json({ error: 'Item not found.' });
  res.json({
    id: row.id,
    subject: row.subject || null,
    sender: row.sender || null,
    category: row.category || classifySubject(row.subject),
    attachmentName: row.attachment_name || null,
    receivedAt: row.received_at || null,
    status: row.status,
    hasDocument: !!row.stored_name,
    intakeId: row.intake_id ?? null,
  });
});

router.get('/items/:id/document', requirePermission('cv_intake.preview'), (req, res) => {
  const row = get('SELECT stored_name, attachment_name FROM mailbox_ingestion WHERE id=?',
    [Number(req.params.id)]);
  if (!row) return res.status(404).json({ error: 'Item not found.' });
  if (!row.stored_name) return res.status(404).json({ error: 'No document on file.' });
  // Opening a CV is a disclosure of personal data, so it is audited by name of
  // the file only — never its contents.
  try {
    writeAudit(req, {
      action: 'cv_intake.document_viewed', entityType: 'mailbox_ingestion',
      entityId: String(req.params.id),
      newValue: { attachment: row.attachment_name || null },
    });
  } catch { /* an audit failure must not deny a legitimate view */ }
  streamFile(row.stored_name, res, row.attachment_name || 'cv');
});

router.get('/batches', requirePermission('cv_intake.view'), (req, res) => {
  res.json({
    batches: listBatches({
      status: req.query.status ? String(req.query.status) : null,
      limit: Math.min(Number.parseInt(req.query.limit, 10) || 50, 200),
    }),
  });
});

router.get('/batches/:id', requirePermission('cv_intake.view'), (req, res) => {
  const batch = batchById(Number(req.params.id));
  if (!batch) return res.status(404).json({ error: 'Batch not found.' });
  res.json(batch);
});

/* ------------------------------- approving -------------------------------- */

router.post('/batches', requirePermission('cv_intake.approve_batch'), (req, res) => {
  const body = req.body || {};
  const ids = Array.isArray(body.ingestionIds) ? body.ingestionIds : [];
  try {
    const batch = createBatch({
      ingestionIds: ids,
      category: body.category ? String(body.category) : null,
      requestedCount: body.requestedCount ?? ids.length,
      actorId: req.user.id,
    });
    writeAudit(req, {
      action: 'cv_intake.batch_approved', entityType: 'cv_intake_batch', entityId: String(batch.id),
      newValue: {
        items: batch.totals.items, category: batch.category,
        requested: batch.requestedCount, limit: limits().maxBatchSize,
      },
    });
    console.log(JSON.stringify({ level: 'info', msg: 'cv_intake.batch_approved',
      batchId: batch.id, items: batch.totals.items, by: req.user.id }));
    res.status(201).json(batch);
  } catch (e) {
    // These are operator-facing decisions (over the limit, already claimed), so
    // the message is returned verbatim — it is written for a person to read.
    res.status(400).json({ error: e.message });
  }
});

/* -------------------------------- control --------------------------------- */

// The audit action for each control verb, spelled out rather than derived.
// `${action}d` reads fine for pause/resume and silently produces
// "cv_intake.batch_canceld" for cancel — a misspelt action name is invisible
// until someone greps the audit log for the event that never fired.
const CONTROL_ACTIONS = new Map([
  ['pause', 'cv_intake.batch_paused'],
  ['resume', 'cv_intake.batch_resumed'],
  ['cancel', 'cv_intake.batch_cancelled'],
]);

router.post('/batches/:id/:action', requirePermission('cv_intake.control'), (req, res) => {
  const action = String(req.params.action);
  if (!CONTROL_ACTIONS.has(action)) return res.status(404).json({ error: 'Unknown action.' });
  try {
    const batch = controlBatch({
      id: Number(req.params.id),
      action,
      actorId: req.user.id,
      reason: req.body?.reason ? String(req.body.reason).slice(0, 500) : null,
    });
    writeAudit(req, {
      action: CONTROL_ACTIONS.get(action), entityType: 'cv_intake_batch',
      entityId: String(batch.id),
      newValue: { status: batch.status, reason: batch.controlReason },
    });
    res.json(batch);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/* -------------------------------- importing ------------------------------- */

/**
 * Approve one parsed CV into the ATS.
 *
 * This route records the decision against the batch. Creating the candidate
 * itself stays where it already lives — POST /api/candidates/intakes/:id/review,
 * behind `candidate.add` — so there is exactly one code path that can produce a
 * candidate, with one set of duplicate rules. A second one here would be the
 * "two implementations, one candidate table" mistake this codebase avoids.
 */
router.post('/batches/:id/items/:itemId/import', requirePermission('cv_intake.import'), (req, res) => {
  try {
    const batch = markItemImported({
      itemId: Number(req.params.itemId),
      intakeId: req.body?.intakeId ? Number(req.body.intakeId) : null,
      actorId: req.user.id,
    });
    writeAudit(req, {
      action: 'cv_intake.import_approved', entityType: 'cv_intake_batch_item',
      entityId: String(req.params.itemId),
      newValue: { batchId: batch.id, intakeId: req.body?.intakeId ?? null },
    });
    res.json(batch);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/* -------------------------------- settings -------------------------------- */

// Readable by anyone who can see the panel: a manager choosing a quantity needs
// to know the ceiling they are choosing within.
router.get('/settings', requirePermission('cv_intake.view'), (req, res) => {
  res.json({ limits: limits() });
});

// WRITABLE ONLY BY THE ADMINISTRATOR. `system.manage`, deliberately not any
// cv_intake.* permission — otherwise a manager granted the panel could raise
// their own ceiling, and the limit would not be a limit.
router.put('/settings', requirePermission('system.manage'), (req, res) => {
  try {
    const before = limits();
    const after = saveLimits(req.body?.limits ?? req.body ?? {});
    writeAudit(req, {
      action: 'cv_intake.limits_changed', entityType: 'system_setting', entityId: 'cv_intake_limits',
      oldValue: before, newValue: after,
    });
    res.json({ limits: after });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

export default router;
