// Background workers.
//
// Two of them, both the same shape: a loop that calls one method and never
// throws out of its own tick. A worker that dies on a transient error is worse
// than no worker, because the backlog it was draining grows silently.
//
// Scheduling lives here rather than inside `OutboxDispatcher` so the dispatcher
// stays testable without waiting on a timer, and so the composition root
// decides whether this process runs workers at all — a web dyno and a worker
// dyno run the same code with different flags.

import { OutboxDispatcher } from '../../infrastructure/db/outbox-dispatcher.js';
import { outboxBacklog } from '../../infrastructure/db/outbox.js';
import type { Executor } from '../../infrastructure/db/types.js';
import type { AITaskWorker } from '../../infrastructure/ai/task-worker.js';
import type { EventDispatcher } from '../../infrastructure/events/event-dispatcher.js';
import type { OfferService } from '../../modules/offer/application/offer-service.js';
import { AuthContext } from '../../modules/shared/kernel/auth-context.js';
import { OFFER_PERMISSIONS } from '../../modules/offer/application/offer-service.js';
import { withContext } from '../http/request-context.js';

export interface WorkerHandle {
  stop(): void;
  /** Run one tick immediately. Tests use this instead of waiting. */
  tick(): Promise<void>;
}

interface LoopOptions {
  readonly intervalMs: number;
  readonly onError?: (error: unknown) => void;
}

const loop = (name: string, tick: () => Promise<void>, opts: LoopOptions): WorkerHandle => {
  let stopped = false;
  let running = false;

  const safeTick = async (): Promise<void> => {
    // Never overlap: a slow tick must not have a second one started on top of
    // it, or two workers in one process race the same rows.
    if (running || stopped) return;
    running = true;
    try {
      await withContext({ method: 'WORKER', path: name }, tick);
    } catch (error) {
      opts.onError?.(error);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => { void safeTick(); }, opts.intervalMs);
  // Do not hold the process open. A worker is not a reason not to exit.
  timer.unref();

  return {
    stop(): void { stopped = true; clearInterval(timer); },
    tick: safeTick,
  };
};

export interface OutboxWorkerOptions {
  readonly intervalMs?: number;
  readonly batchSize?: number;
  readonly onError?: (error: unknown) => void;
}

/**
 * Drains whatever the post-commit fast path did not deliver.
 *
 * In the normal case this finds nothing: the Unit of Work delivers and marks
 * rows before any poll sees them. It earns its keep when a process dies between
 * commit and delivery, or a subscriber was briefly failing.
 */
export const startOutboxWorker = (
  db: Executor,
  dispatcher: EventDispatcher,
  opts: OutboxWorkerOptions = {},
): WorkerHandle => {
  const worker = new OutboxDispatcher(db, dispatcher, {
    batchSize: opts.batchSize ?? 50,
    ...(opts.onError ? { onError: opts.onError } : {}),
  });
  return loop('outbox', async () => { await worker.drainUntilEmpty(10); }, {
    intervalMs: opts.intervalMs ?? 2_000,
    ...(opts.onError ? { onError: opts.onError } : {}),
  });
};

export interface ExpiryWorkerOptions {
  readonly intervalMs?: number;
  readonly tenantId?: number;
  readonly onError?: (error: unknown) => void;
}

/**
 * Expires offers whose validity has elapsed ("valid for 5 days" on the letter).
 *
 * Calls the SAME `OfferService.expireDue` a user would; there is no worker-only
 * path into the domain. The system context carries exactly one permission —
 * enough to expire, nothing else — because a background job with broad rights
 * is a privilege-escalation waiting to be found.
 */
export const startOfferExpiryWorker = (
  offers: OfferService,
  opts: ExpiryWorkerOptions = {},
): WorkerHandle => {
  const ctx = AuthContext.system(opts.tenantId ?? 1, {
    permissions: [OFFER_PERMISSIONS.RESULT_UPDATE],
  });
  return loop('offer-expiry', async () => { await offers.expireDue(ctx); }, {
    intervalMs: opts.intervalMs ?? 60_000,
    ...(opts.onError ? { onError: opts.onError } : {}),
  });
};

export interface AIWorkerOptions {
  readonly intervalMs?: number;
  readonly onError?: (error: unknown) => void;
}

export const startAITaskWorker = (
  worker: AITaskWorker,
  opts: AIWorkerOptions = {},
): WorkerHandle => {
  return loop('ai-task', async () => { await worker.drainOnce(); }, {
    intervalMs: opts.intervalMs ?? 5_000,
    ...(opts.onError ? { onError: opts.onError } : {}),
  });
};

/** Backlog counters for the health endpoint. */
export const outboxHealth = async (
  db: Executor,
): Promise<{ pending: number; due: number; failing: number }> =>
  outboxBacklog(db, new Date());
