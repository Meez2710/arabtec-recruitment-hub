// The AI task record — durable state for asynchronous inference.
//
// WHY A TABLE AND NOT AN IN-MEMORY QUEUE. Parsing takes minutes and the process
// can restart mid-flight. An in-memory job would leave the recruiter watching a
// spinner for work that no longer exists, and the uploaded CV orphaned. A row
// survives; the UI polls it; a restart can see that a RUNNING task belongs to a
// process that is gone.
//
// WHY IT RECORDS SO MANY VERSIONS. `model_digest`, `prompt_version`,
// `schema_version`, `parser_version` and `gateway_version` are recorded on every
// task because a proposal that influenced a hiring record must be explainable
// months later. "The model" is not an answer — a mutable tag can point at
// different weights after an upgrade, so the digest is what identifies what
// actually read the CV.
//
// WHAT IS NOT STORED: no CV text, no model output prose. The draft table holds
// the structured proposal (which IS the reviewable artefact); `error_detail`
// holds only a fixed sentence from lib/ai/errors.js.

import { get, all, run, tx } from '../db.js';

export const AI_TASK_STATUS = {
  QUEUED: 'queued',
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};

/** States from which no further work happens. */
export const AI_TERMINAL = [AI_TASK_STATUS.SUCCEEDED, AI_TASK_STATUS.FAILED, AI_TASK_STATUS.CANCELLED];

const nowISO = () => new Date().toISOString();

export const AiTasks = {
  byId(id) { return get('SELECT * FROM ai_task WHERE id=?', [id]); },
  byIdempotencyKey(key) { return get('SELECT * FROM ai_task WHERE idempotency_key=?', [key]); },

  /**
   * Create, or return the task an identical submission already produced.
   *
   * IDEMPOTENCY IS THE POINT. The browser retries, the user double-clicks, a
   * proxy replays. Each would otherwise spend a GPU minute and create a second
   * draft of the same CV for a recruiter to reconcile. The key is derived from
   * the file bytes and the requester, so the same person uploading the same CV
   * twice gets the same task — while two different people uploading the same
   * CV legitimately get their own.
   */
  createOrGet(d) {
    return tx(() => {
      const existing = this.byIdempotencyKey(d.idempotencyKey);
      if (existing) return { task: existing, deduplicated: true };
      const r = run(
        `INSERT INTO ai_task
          (capability, status, idempotency_key, entity_type, entity_id, requested_by,
           attempts, max_attempts, timeout_ms, file_stored_name, file_original_name,
           file_mime, file_size, created_at, updated_at)
         VALUES (?,?,?,?,?,?,0,?,?,?,?,?,?,?,?)`,
        [d.capability, AI_TASK_STATUS.QUEUED, d.idempotencyKey, d.entityType ?? null,
          d.entityId ?? null, d.requestedBy, d.maxAttempts, d.timeoutMs,
          d.fileStoredName, d.fileOriginalName, d.fileMime, d.fileSize, nowISO(), nowISO()],
      );
      return { task: this.byId(Number(r.lastInsertRowid)), deduplicated: false };
    });
  },

  /**
   * Claim a task for execution. CONDITIONAL on it still being queued, so two
   * processes polling the same row cannot both run the model on it.
   * @returns {boolean} true when this caller won the claim
   */
  claim(id) {
    const r = run(
      `UPDATE ai_task SET status=?, attempts=attempts+1, started_at=?, updated_at=?,
              error_code=NULL, error_detail=NULL
        WHERE id=? AND status=?`,
      [AI_TASK_STATUS.RUNNING, nowISO(), nowISO(), id, AI_TASK_STATUS.QUEUED],
    );
    return r.changes > 0;
  },

  /** Record what produced the answer. Called before the result is known. */
  recordProvenance(id, p) {
    run(
      `UPDATE ai_task SET model_id=?, model_digest=?, prompt_version=?, schema_version=?,
              parser_version=?, gateway_version=?, updated_at=? WHERE id=?`,
      [p.modelId ?? null, p.modelDigest ?? null, p.promptVersion ?? null, p.schemaVersion ?? null,
        p.parserVersion ?? null, p.gatewayVersion ?? null, nowISO(), id],
    );
  },

  succeed(id) {
    run('UPDATE ai_task SET status=?, finished_at=?, updated_at=? WHERE id=? AND status=?',
      [AI_TASK_STATUS.SUCCEEDED, nowISO(), nowISO(), id, AI_TASK_STATUS.RUNNING]);
  },

  /**
   * Fail, and decide whether the work is lost or merely delayed.
   *
   * A retryable failure with attempts left returns to QUEUED so the runner can
   * pick it up again; anything else is terminal. `permanent` comes from the
   * adapter, which is the only layer that knows whether the DOCUMENT or the
   * ENVIRONMENT failed — getting that backwards silently discards a CV because
   * a GPU happened to be offline.
   */
  fail(id, { code, detail, permanent }) {
    return tx(() => {
      const t = this.byId(id);
      if (!t) return null;
      const canRetry = !permanent && t.attempts < t.max_attempts;
      const next = canRetry ? AI_TASK_STATUS.QUEUED : AI_TASK_STATUS.FAILED;
      run(
        `UPDATE ai_task SET status=?, error_code=?, error_detail=?, permanent=?,
                finished_at=?, updated_at=? WHERE id=?`,
        [next, code, detail, permanent ? 1 : 0, canRetry ? null : nowISO(), nowISO(), id],
      );
      return this.byId(id);
    });
  },

  /** Operator/recruiter retry of a task that has stopped. Reuses the SAME row. */
  requeue(id) {
    const r = run(
      `UPDATE ai_task SET status=?, error_code=NULL, error_detail=NULL, permanent=0,
              finished_at=NULL, cancelled_at=NULL, attempts=0, updated_at=?
        WHERE id=? AND status IN (?,?)`,
      [AI_TASK_STATUS.QUEUED, nowISO(), id, AI_TASK_STATUS.FAILED, AI_TASK_STATUS.CANCELLED],
    );
    return r.changes > 0;
  },

  /**
   * Cancel. Allowed from queued or running; a running model call is told to
   * abort but may still finish, so the runner re-checks before writing a
   * result and discards it if the task was cancelled underneath it.
   */
  cancel(id) {
    const r = run(
      `UPDATE ai_task SET status=?, cancelled_at=?, finished_at=?, updated_at=?
        WHERE id=? AND status IN (?,?)`,
      [AI_TASK_STATUS.CANCELLED, nowISO(), nowISO(), nowISO(), id,
        AI_TASK_STATUS.QUEUED, AI_TASK_STATUS.RUNNING],
    );
    return r.changes > 0;
  },

  isCancelled(id) {
    return this.byId(id)?.status === AI_TASK_STATUS.CANCELLED;
  },

  nextQueued(limit = 1) {
    return all('SELECT * FROM ai_task WHERE status=? ORDER BY id LIMIT ?',
      [AI_TASK_STATUS.QUEUED, limit]);
  },

  forUser(userId, limit = 25) {
    return all('SELECT * FROM ai_task WHERE requested_by=? ORDER BY id DESC LIMIT ?', [userId, limit]);
  },

  runningCount() {
    return Number(get('SELECT COUNT(*) c FROM ai_task WHERE status=?', [AI_TASK_STATUS.RUNNING]).c);
  },
};

export const AiDrafts = {
  byTask(taskId) { return get('SELECT * FROM ai_parse_draft WHERE task_id=?', [taskId]); },
  byId(id) { return get('SELECT * FROM ai_parse_draft WHERE id=?', [id]); },

  /** One draft per task. Re-running a task replaces its draft, never adds one. */
  upsert(taskId, d) {
    return tx(() => {
      const existing = this.byTask(taskId);
      if (existing) {
        run(`UPDATE ai_parse_draft SET proposal=?, confidence=?, uncertain_fields=?,
                    status='pending', updated_at=? WHERE task_id=?`,
        [JSON.stringify(d.proposal), d.confidence ?? null,
          JSON.stringify(d.uncertainFields ?? []), nowISO(), taskId]);
        return this.byTask(taskId);
      }
      run(
        `INSERT INTO ai_parse_draft (task_id, proposal, confidence, uncertain_fields, status, created_at, updated_at)
         VALUES (?,?,?,?, 'pending', ?, ?)`,
        [taskId, JSON.stringify(d.proposal), d.confidence ?? null,
          JSON.stringify(d.uncertainFields ?? []), nowISO(), nowISO()],
      );
      return this.byTask(taskId);
    });
  },

  /**
   * Mark a draft as acted on. CONDITIONAL on it still being pending, so a
   * double-submitted confirmation cannot create a second candidate from one
   * draft — the second caller sees changes === 0 and is refused.
   */
  confirmIfPending(taskId, { candidateId, userId }) {
    const r = run(
      `UPDATE ai_parse_draft SET status='confirmed', confirmed_candidate_id=?, confirmed_by=?,
              confirmed_at=?, updated_at=? WHERE task_id=? AND status='pending'`,
      [candidateId, userId, nowISO(), nowISO(), taskId],
    );
    return r.changes > 0;
  },

  discard(taskId, userId) {
    const r = run(
      `UPDATE ai_parse_draft SET status='discarded', confirmed_by=?, updated_at=?
        WHERE task_id=? AND status='pending'`, [userId, nowISO(), taskId],
    );
    return r.changes > 0;
  },
};

/** Route/UI shape. Never includes the stored file name or any internal path. */
export function taskOut(task, draft = null) {
  if (!task) return null;
  return {
    id: task.id,
    capability: task.capability,
    status: task.status,
    attempts: Number(task.attempts),
    maxAttempts: Number(task.max_attempts),
    timeoutMs: Number(task.timeout_ms),
    permanent: !!task.permanent,
    errorCode: task.error_code || null,
    error: task.error_detail || null,
    retryable: !!task.error_code && !task.permanent,
    file: { originalName: task.file_original_name, size: Number(task.file_size), mime: task.file_mime },
    provenance: {
      modelId: task.model_id || null,
      modelDigest: task.model_digest || null,
      promptVersion: task.prompt_version || null,
      schemaVersion: task.schema_version || null,
      parserVersion: task.parser_version || null,
      gatewayVersion: task.gateway_version || null,
    },
    createdAt: task.created_at,
    startedAt: task.started_at || null,
    finishedAt: task.finished_at || null,
    cancelledAt: task.cancelled_at || null,
    draft: draft ? {
      id: draft.id,
      status: draft.status,
      confidence: draft.confidence,
      uncertainFields: safeJson(draft.uncertain_fields, []),
      proposal: safeJson(draft.proposal, null),
      confirmedCandidateId: draft.confirmed_candidate_id || null,
      confirmedAt: draft.confirmed_at || null,
    } : null,
  };
}

const safeJson = (s, fallback) => {
  try { return s ? JSON.parse(s) : fallback; } catch { return fallback; }
};
