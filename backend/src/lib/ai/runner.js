// The AI worker — bounded, cancellable, in-process execution of queued tasks.
//
// WHY IN-PROCESS AND NOT A SEPARATE WORKER. This is a staging MVP for one
// capability. A separate worker process is the right end state and the task
// table is already shaped for it — `claim()` is a conditional UPDATE precisely
// so two processes cannot run the same row. Adding the process is then a
// deployment change, not a redesign. Shipping it now would add an operational
// surface with nothing to run on it.
//
// WHY THE HTTP HANDLER NEVER AWAITS INFERENCE. A request that waits three
// minutes for a GPU holds a connection, a socket and (before the seam existed)
// a transaction. Upload returns immediately with a task id; the browser polls.
//
// TIMEOUT IS ENFORCED TWICE, DELIBERATELY. The gateway client aborts its own
// fetch, and the runner races the whole handler against the same deadline. The
// inner one is the clean path; the outer one is what stops a handler that hangs
// somewhere the AbortSignal does not reach from occupying a slot forever.

import { run } from '../db.js';
import { AiTasks, AI_TASK_STATUS } from './jobs.js';
import { aiConfig } from './config.js';
import { AI_ERROR, AiIntakeError, aiErrorMessage } from './errors.js';
import { recordFailure, recordSuccess } from './breaker.js';

/** capability → async (task, { signal }) => void. Registered at composition. */
const handlers = new Map();

export function registerAiHandler(capability, handler) {
  if (typeof handler !== 'function') throw new Error(`AI handler for ${capability} must be a function.`);
  handlers.set(capability, handler);
}

/** In-flight tasks in THIS process, by task id, with their abort controllers. */
const inFlight = new Map();

let draining = false;

/** Environment failures move the breaker; document failures must not. */
const ENVIRONMENT_CODES = new Set([
  AI_ERROR.UNAVAILABLE, AI_ERROR.TIMEOUT, AI_ERROR.INTERNAL, AI_ERROR.CIRCUIT_OPEN,
]);

/**
 * Run one task to completion. Never throws: every outcome is written to the row.
 */
async function execute(task) {
  const handler = handlers.get(task.capability);
  if (!handler) {
    AiTasks.fail(task.id, {
      code: AI_ERROR.NOT_CONFIGURED, detail: aiErrorMessage(AI_ERROR.NOT_CONFIGURED), permanent: true,
    });
    return;
  }

  const controller = new AbortController();
  inFlight.set(task.id, controller);
  // The outer deadline. Cleared in `finally` so a fast task does not leave a
  // timer holding the event loop open — which would keep the process alive.
  let timer = null;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new AiIntakeError(AI_ERROR.TIMEOUT, { permanent: false }));
    }, Number(task.timeout_ms) || aiConfig().timeoutMs);
  });

  try {
    await Promise.race([handler(task, { signal: controller.signal }), deadline]);
    // A cancellation that landed while the model was still thinking wins: the
    // handler's result is discarded rather than resurrecting a cancelled task.
    if (AiTasks.isCancelled(task.id)) return;
    AiTasks.succeed(task.id);
    recordSuccess();
  } catch (err) {
    if (AiTasks.isCancelled(task.id)) return;
    const e = err instanceof AiIntakeError ? err : new AiIntakeError(AI_ERROR.INTERNAL, { permanent: false });
    // Only the CODE and the fixed sentence are persisted — never err.message
    // from an adapter, which may quote document content.
    AiTasks.fail(task.id, { code: e.code, detail: aiErrorMessage(e.code), permanent: e.permanent });
    if (ENVIRONMENT_CODES.has(e.code)) recordFailure(e.code);
  } finally {
    if (timer) clearTimeout(timer);
    inFlight.delete(task.id);
  }
}

/**
 * Claim and run queued tasks up to the concurrency limit.
 *
 * Safe to call repeatedly and concurrently: `draining` collapses overlapping
 * calls, and `claim()` is conditional, so a task can only be started once.
 */
export async function drainQueue() {
  if (draining) return;
  draining = true;
  try {
    const { maxConcurrency } = aiConfig();
    for (;;) {
      const free = maxConcurrency - inFlight.size;
      if (free <= 0) return;
      const batch = AiTasks.nextQueued(free);
      if (batch.length === 0) return;
      const started = batch.filter((t) => AiTasks.claim(t.id));
      if (started.length === 0) return;
      // Not awaited as a group: each task finishes on its own and calls back in
      // to pick up whatever queued while it ran.
      for (const t of started) {
        execute(AiTasks.byId(t.id)).finally(() => { setImmediate(() => { drainQueue(); }); });
      }
      if (inFlight.size >= maxConcurrency) return;
    }
  } finally {
    draining = false;
  }
}

/** Ask a running task to stop. Best effort — the model may still finish. */
export function abortInFlight(taskId) {
  const c = inFlight.get(taskId);
  if (c) { try { c.abort(); } catch { /* already settled */ } return true; }
  return false;
}

export const inFlightCount = () => inFlight.size;

/**
 * Tasks left RUNNING by a process that died can never complete on their own.
 *
 * Requeued once at boot, so an unlucky restart DELAYS a CV instead of losing
 * it. Attempts are left intact: a task that has already exhausted them fails
 * on the next pass rather than looping forever.
 */
export function recoverOrphanedTasks() {
  const r = run('UPDATE ai_task SET status=?, started_at=NULL, updated_at=? WHERE status=?',
    [AI_TASK_STATUS.QUEUED, new Date().toISOString(), AI_TASK_STATUS.RUNNING]);
  return r.changes || 0;
}
