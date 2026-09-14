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
// The mailbox pipeline's own tables — what the CV Inbox reports on.
import { inboxRows, inboxCounts, connectionStatus, waitingByCategory } from '../lib/microsoft/connection-store.js';
import { runMailboxSync, parseWaiting } from '../lib/microsoft/mailbox-sync.js';
import { configuredMailbox } from '../lib/microsoft/config.js';

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

/**
 * Discover what is sitting in the mailbox, without parsing any of it.
 *
 * Costs a Graph listing and nothing else — no attachment bytes, no model call.
 * Rows land WAITING, grouped by the job title classified from the subject, so
 * a recruiter can then choose what is worth reading. This is the control the
 * batch panel always implied and could never deliver, because the sync parsed
 * everything the moment it saw it.
 */
const DATE_PRESETS = Object.freeze({ 1: 'Last 24 hours', 7: 'Last 7 days', 30: 'Last 30 days' });

router.post('/discover', requirePermission('cv_intake.approve_batch'), async (req, res) => {
  // A preset in days, or an explicit from/to. `from` wins when both are given,
  // so a custom range is never silently overridden by a stale preset.
  const days = Math.max(1, Math.min(Number.parseInt(req.body?.days, 10) || 7, 400));
  const fromRaw = req.body?.from ? String(req.body.from) : null;
  const from = fromRaw && !Number.isNaN(Date.parse(fromRaw)) ? new Date(fromRaw).toISOString() : null;
  try {
    const since = from || new Date(Date.now() - days * 86400000).toISOString();
    const summary = await runMailboxSync({ actor: req.user, req, discoverOnly: true, since });
    writeAudit(req, {
      action: 'cv_intake.discovered', entityType: 'mailbox', entityId: 'microsoft',
      newValue: { days, found: summary.waiting || 0, messages: summary.messages },
    });
    res.json({ ...summary, days });
  } catch (e) {
    res.status(502).json({ error: e.message || 'Could not read the mailbox.' });
    console.error(JSON.stringify({ level: 'error', msg: 'cv_intake.discover_failed', error: e.message }));
  }
});

/**
 * Parse a CHOSEN slice of what is waiting.
 *
 * Discovery leaves rows WAITING, and `claimAttachment` reports a WAITING row as
 * already-processed — so a normal scan will never pick them up again. That is
 * deliberate (a backlog must not drain itself), but it means this route is the
 * only way those CVs are ever read. Without it, discovery would strand them.
 *
 * `category` and `limit` are the whole point: parse 50 of "Civil Engineer" and
 * leave the other nine thousand alone.
 */
router.post('/parse-waiting', requirePermission('cv_intake.approve_batch'), async (req, res) => {
  // Groups, not one group: a recruiter ticks several job titles and presses
  // Parse Selected once. A bare `category` is still accepted so nothing that
  // called this with a single group breaks.
  const many = Array.isArray(req.body?.categories) ? req.body.categories.map(String) : null;
  const categories = many && many.length ? many
    : (req.body?.category ? [String(req.body.category)] : null);
  const limit = Math.max(1, Math.min(Number.parseInt(req.body?.limit, 10) || 25, 200));
  try {
    const summary = await parseWaiting({ categories, limit, actor: req.user, req });
    writeAudit(req, {
      action: 'cv_intake.parsed_selection', entityType: 'mailbox', entityId: 'microsoft',
      newValue: { categories, limit, parsed: summary.parsed, failed: summary.failed },
    });
    res.json(summary);
  } catch (e) {
    res.status(502).json({ error: e.message || 'Could not parse the selection.' });
    console.error(JSON.stringify({ level: 'error', msg: 'cv_intake.parse_waiting_failed', error: e.message }));
  }
});

/**
 * What is waiting, grouped by job title, so the count beside each title is the
 * number a recruiter is deciding whether to spend.
 */
router.get('/waiting', requirePermission('cv_intake.view'), (req, res) => {
  try {
    const rows = waitingByCategory();
    res.json({ groups: rows, total: rows.reduce((n, r) => n + Number(r.count || 0), 0) });
  } catch (e) {
    res.status(500).json({ error: 'Could not read what is waiting.' });
    console.error(JSON.stringify({ level: 'error', msg: 'cv_intake.waiting_failed', error: e.message }));
  }
});

/**
 * The recruiter's CV Inbox.
 *
 * Reads the mailbox pipeline's own tables rather than the batch queue. The two
 * describe different products: the batch panel was built around a recruiter
 * approving CVs for parsing in tens, while the mailbox pipeline already
 * validates, de-duplicates and parses on arrival. This endpoint reports what
 * that pipeline actually did, which is what the page needs to show.
 *
 * Nothing here creates or converts anything — it is a read.
 */
router.get('/inbox', requirePermission('cv_intake.view'), (req, res) => {
  try {
    const state = String(req.query.state || 'inbox');
    res.json({
      state,
      counts: inboxCounts(),
      rows: inboxRows({
        state,
        limit: Number.parseInt(req.query.limit, 10) || 100,
        offset: Number.parseInt(req.query.offset, 10) || 0,
      }),
      mailbox: configuredMailbox(),
      connection: connectionStatus(),
    });
  } catch (e) {
    res.status(500).json({ error: 'Could not read the CV inbox.' });
    console.error(JSON.stringify({ level: 'error', msg: 'cv_intake.inbox_failed', error: e.message }));
  }
});

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
