// AI-assisted candidate intake — the only HTTP surface for the AI feature.
//
// WHAT THE BROWSER CAN ASK FOR: upload a CV, watch a task, retry it, cancel it,
// confirm a reviewed draft. That is the whole vocabulary. There is deliberately
// no endpoint that takes a URL, a model name, a prompt or a gateway path, so
// nothing here can be steered into becoming a proxy to the AI runtime.
//
// EVERY RESPONSE IS SAFE TO LOG. Errors are the stable codes from lib/ai/errors
// with fixed sentences. The draft — which does contain the candidate's details,
// because it is the thing being reviewed — is returned to an authorised user
// and never written to a log line.
//
// AI HAS NO AUTHORITY HERE. Nothing in this file creates a candidate, moves an
// application or changes a requisition. `confirm` is a human act that calls the
// ordinary candidate service under the ordinary permissions.

import { Router } from 'express';
import { requireAuth, requirePermission } from '../middleware/auth.js';
import { writeAudit } from '../lib/audit.js';
import { multipartMemory, saveIntakeBlob } from '../lib/upload.js';
import { aiConfig, aiUnavailableReason, describeAiConfig } from '../lib/ai/config.js';
import { AI_ERROR, AiIntakeError, aiErrorMessage } from '../lib/ai/errors.js';
import { AI_CAPABILITIES } from '../lib/ai/capabilities.js';
import { AiTasks, AiDrafts, taskOut, AI_TASK_STATUS } from '../lib/ai/jobs.js';
import { drainQueue, abortInFlight, inFlightCount } from '../lib/ai/runner.js';
import { breakerHealth, breakerIsOpen } from '../lib/ai/breaker.js';
import { validateIntakeFile, intakeIdempotencyKey } from '../lib/ai/file-validation.js';
import { createCandidate, CandidateServiceError } from '../lib/candidate-service.js';

const router = Router();
router.use(requireAuth);

/** Refuse early and identically everywhere the feature is off or unconfigured. */
function guardAvailable(res) {
  const reason = aiUnavailableReason();
  if (reason) {
    // 503, not 500: the ATS is fine, this capability is not offered right now.
    res.status(503).json({
      error: aiErrorMessage(reason), code: reason, retryable: false,
      manualEntryAvailable: true,
    });
    return false;
  }
  return true;
}

/**
 * A parse task is visible ONLY to the person who submitted it.
 *
 * Deliberately not widened to candidate managers. A pending draft is
 * unreviewed extraction of a real person's CV — name, contact details,
 * employment history — held transiently before anyone has decided it is
 * accurate enough to keep. There is no business need for a second user to read
 * another recruiter's un-confirmed draft, and "a manager might want to" is not
 * a reason to widen access to unverified personal data. Once confirmed, the
 * candidate record exists and the ordinary candidate permissions govern it.
 */
function canSee(req, task) {
  return task.requested_by === req.user.id;
}

/* ------------------------------- health ---------------------------------- */
/**
 * Feature state for the UI. Deliberately does NOT call the gateway: the panel
 * asks this on every page load, and a synchronous probe would make an AI
 * outage feel like an ATS outage.
 */
router.get('/health', (req, res) => {
  res.json({
    ai: describeAiConfig(),
    breaker: breakerHealth(),
    inFlight: inFlightCount(),
    running: AiTasks.runningCount(),
    unavailableReason: aiUnavailableReason(),
    // The UI uses this to decide whether to offer the panel at all.
    manualEntryAlwaysAvailable: true,
  });
});

/* ------------------------------- upload ---------------------------------- */
/**
 * Accept a CV and QUEUE it. Returns immediately with a task; the browser polls.
 *
 * The handler never awaits inference — a request that waits three minutes for a
 * GPU holds a connection and a socket for the whole time, and would turn a slow
 * model into an apparent ATS hang.
 */
router.post('/upload', requirePermission('candidate.add'), multipartMemory, (req, res) => {
  if (!guardAvailable(res)) return;
  if (!req.uploadedFile) return res.status(400).json({ error: 'A CV file is required.', code: 'FILE_MISSING' });

  const cfg = aiConfig();
  const { bytes, originalName } = req.uploadedFile;

  let type;
  try {
    type = validateIntakeFile({ bytes, originalName, maxBytes: cfg.maxUploadBytes });
  } catch (e) {
    if (e instanceof AiIntakeError) return res.status(e.status).json(e.toBody());
    throw e;
  }

  // Content-addressed: the same person re-submitting the same CV gets the same
  // task rather than a second GPU minute and a duplicate draft to reconcile.
  const idempotencyKey = intakeIdempotencyKey({
    bytes, userId: req.user.id, capability: AI_CAPABILITIES.RESUME_PARSE,
  });

  const existing = AiTasks.byIdempotencyKey(idempotencyKey);
  if (existing) {
    return res.status(200).json({
      task: taskOut(existing, AiDrafts.byTask(existing.id)), deduplicated: true,
    });
  }

  // The original CV is retained under the EXISTING storage policy (file_blob,
  // same as every other upload) — the AI path introduces no second store and
  // no new retention rule.
  const storedName = saveIntakeBlob({ bytes, originalName, mime: type.mime });

  const { task } = AiTasks.createOrGet({
    capability: AI_CAPABILITIES.RESUME_PARSE,
    idempotencyKey,
    requestedBy: req.user.id,
    maxAttempts: cfg.maxAttempts,
    timeoutMs: cfg.timeoutMs,
    fileStoredName: storedName,
    fileOriginalName: originalName,
    fileMime: type.mime,
    fileSize: bytes.length,
    entityType: req.body?.requestId ? 'recruitment_request' : null,
    entityId: req.body?.requestId ? Number(req.body.requestId) : null,
  });

  // Filename only — never the file's content, and never the parsed result.
  writeAudit(req, {
    action: 'ai.intake_submitted', entityType: 'ai_task', entityId: task.id,
    newValue: { capability: task.capability, fileName: originalName, size: bytes.length },
  });

  setImmediate(() => { drainQueue(); });
  res.status(202).json({ task: taskOut(task, null), deduplicated: false });
});

/* ------------------------------- polling --------------------------------- */
router.get('/jobs', requirePermission('candidate.add'), (req, res) => {
  const rows = AiTasks.forUser(req.user.id, 25);
  res.json({ tasks: rows.map((t) => taskOut(t, AiDrafts.byTask(t.id))) });
});

router.get('/jobs/:id', requirePermission('candidate.add'), (req, res) => {
  const task = AiTasks.byId(Number(req.params.id));
  if (!task) return res.status(404).json({ error: 'Parse job not found.' });
  if (!canSee(req, task)) return res.status(403).json({ error: 'This parse job belongs to another user.' });
  res.json({ task: taskOut(task, AiDrafts.byTask(task.id)) });
});

/* ------------------------------- retry ----------------------------------- */
/**
 * Re-run the SAME task. Never creates a second one, so a retry can never
 * produce a duplicate draft or a duplicate candidate.
 */
router.post('/jobs/:id/retry', requirePermission('candidate.add'), (req, res) => {
  if (!guardAvailable(res)) return;
  const task = AiTasks.byId(Number(req.params.id));
  if (!task) return res.status(404).json({ error: 'Parse job not found.' });
  if (!canSee(req, task)) return res.status(403).json({ error: 'This parse job belongs to another user.' });

  const draft = AiDrafts.byTask(task.id);
  if (draft && draft.status === 'confirmed') {
    return res.status(409).json({
      error: 'This parse has already been confirmed and cannot be re-run.',
      code: 'DRAFT_ALREADY_CONFIRMED',
    });
  }
  if (breakerIsOpen()) {
    return res.status(503).json({
      error: aiErrorMessage(AI_ERROR.CIRCUIT_OPEN), code: AI_ERROR.CIRCUIT_OPEN, retryable: true,
    });
  }
  if (!AiTasks.requeue(task.id)) {
    return res.status(409).json({
      error: 'Only a failed or cancelled parse can be retried.',
      code: 'TASK_NOT_RETRYABLE', status: task.status,
    });
  }

  writeAudit(req, { action: 'ai.intake_retried', entityType: 'ai_task', entityId: task.id });
  setImmediate(() => { drainQueue(); });
  res.json({ task: taskOut(AiTasks.byId(task.id), AiDrafts.byTask(task.id)) });
});

/* ------------------------------- cancel ---------------------------------- */
router.post('/jobs/:id/cancel', requirePermission('candidate.add'), (req, res) => {
  const task = AiTasks.byId(Number(req.params.id));
  if (!task) return res.status(404).json({ error: 'Parse job not found.' });
  if (!canSee(req, task)) return res.status(403).json({ error: 'This parse job belongs to another user.' });

  if (!AiTasks.cancel(task.id)) {
    return res.status(409).json({
      error: 'This parse has already finished.', code: 'TASK_NOT_CANCELLABLE', status: task.status,
    });
  }
  // Best effort: a model already generating may still finish, which is why the
  // runner re-checks cancellation before writing any result.
  abortInFlight(task.id);
  writeAudit(req, { action: 'ai.intake_cancelled', entityType: 'ai_task', entityId: task.id });
  res.json({ task: taskOut(AiTasks.byId(task.id), AiDrafts.byTask(task.id)) });
});

/* ------------------------------ confirm ---------------------------------- */
/**
 * The human act. Turns a reviewed proposal into a candidate.
 *
 * The submitted body — not the stored draft — is what gets created: the
 * recruiter may have corrected every field, and the edited values are the
 * authority. The draft is marked confirmed CONDITIONALLY first, so a
 * double-submitted confirmation cannot create two candidates from one review.
 */
router.post('/jobs/:id/confirm', requirePermission('candidate.add'), (req, res) => {
  const task = AiTasks.byId(Number(req.params.id));
  if (!task) return res.status(404).json({ error: 'Parse job not found.' });
  if (!canSee(req, task)) return res.status(403).json({ error: 'This parse job belongs to another user.' });
  if (task.status !== AI_TASK_STATUS.SUCCEEDED) {
    return res.status(409).json({
      error: 'This parse has no reviewable result.', code: 'TASK_NOT_SUCCEEDED', status: task.status,
    });
  }
  const draft = AiDrafts.byTask(task.id);
  if (!draft) return res.status(404).json({ error: 'Parse draft not found.' });
  if (draft.status !== 'pending') {
    return res.status(409).json({
      error: 'This draft has already been actioned.', code: 'DRAFT_ALREADY_ACTIONED', status: draft.status,
    });
  }

  let created;
  try {
    // Claim the draft FIRST. If two confirmations race, the loser sees the
    // draft is no longer pending and never reaches candidate creation.
    if (!AiDrafts.confirmIfPending(task.id, { candidateId: null, userId: req.user.id })) {
      return res.status(409).json({
        error: 'This draft has already been actioned.', code: 'DRAFT_ALREADY_ACTIONED',
      });
    }
    created = createCandidate(req, { ...(req.body || {}), source: (req.body || {}).source || 'cv_ai_parse' },
      { source: 'AI-assisted intake, confirmed by reviewer' });
  } catch (e) {
    // Release the claim so a corrected resubmission can proceed.
    AiDrafts.upsert(task.id, {
      proposal: JSON.parse(draft.proposal), confidence: draft.confidence,
      uncertainFields: JSON.parse(draft.uncertain_fields || '[]'),
    });
    if (e instanceof CandidateServiceError) return res.status(e.status).json(e.body);
    throw e;
  }

  // The claim above already moved the draft out of pending; record which
  // candidate it produced so the review screen can link to the real record.
  AiDrafts.linkCandidate(task.id, created.candidate.id);

  writeAudit(req, {
    action: 'ai.intake_confirmed', entityType: 'ai_task', entityId: task.id,
    newValue: { candidateId: created.candidate.id, modelId: task.model_id, promptVersion: task.prompt_version },
  });

  res.status(201).json({
    candidateId: created.candidate.id,
    applicationId: created.application ? created.application.id : null,
    task: taskOut(AiTasks.byId(task.id), AiDrafts.byTask(task.id)),
  });
});

/** Discard a draft without creating anything. */
router.post('/jobs/:id/discard', requirePermission('candidate.add'), (req, res) => {
  const task = AiTasks.byId(Number(req.params.id));
  if (!task) return res.status(404).json({ error: 'Parse job not found.' });
  if (!canSee(req, task)) return res.status(403).json({ error: 'This parse job belongs to another user.' });
  if (!AiDrafts.discard(task.id, req.user.id)) {
    return res.status(409).json({ error: 'There is no pending draft to discard.', code: 'NO_PENDING_DRAFT' });
  }
  writeAudit(req, { action: 'ai.intake_discarded', entityType: 'ai_task', entityId: task.id });
  res.json({ ok: true });
});

export default router;
