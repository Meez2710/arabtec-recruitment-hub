// Outbox dispatcher — the polling worker.
//
// Deliberately a plain object with a `drainOnce()` method rather than a class
// that owns a timer. Scheduling belongs to whoever runs it (a job queue, a cron,
// a `setInterval` in the composition root); a component that starts its own
// timer cannot be tested without waiting and cannot be run twice on purpose.
//
// SAFE TO RUN IN PARALLEL. Claiming uses `FOR UPDATE SKIP LOCKED`, so N workers
// share one backlog: each takes rows nobody else holds and skips the rest
// instead of queueing behind them.

import { claimPending } from './outbox.js';
import { relay } from './outbox-relay.js';
import type { RelayResult } from './outbox-relay.js';
import { runInTransaction } from './transaction.js';
import type { Executor } from './types.js';
import type { EventDispatcher } from '../events/event-dispatcher.js';

export interface OutboxDispatcherOptions {
  /**
   * Rows per pass. Small on purpose: a claim holds row locks for the whole
   * delivery, and a slow subscriber inside a large batch would keep them.
   */
  readonly batchSize?: number;
  readonly now?: () => Date;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly onError?: (error: unknown) => void;
}

export class OutboxDispatcher {
  constructor(
    private readonly db: Executor,
    private readonly dispatcher: EventDispatcher,
    private readonly opts: OutboxDispatcherOptions = {},
  ) {}

  /**
   * One pass: claim a batch, deliver it, settle it.
   *
   * The claim and the delivery share a transaction so the lock is held for the
   * whole attempt — otherwise a second worker could claim a row this one is
   * midway through delivering, and both would race the ledger. The ledger would
   * still make processing exactly-once, but the wasted work and the interleaved
   * `last_error` writes would make the backlog impossible to reason about.
   */
  async drainOnce(): Promise<RelayResult> {
    const now = this.opts.now?.() ?? new Date();
    try {
      return await runInTransaction(this.db, async (tx) => {
        const claimed = await claimPending(tx, {
          limit: this.opts.batchSize ?? 50,
          now,
        });
        if (claimed.length === 0) return { delivered: 0, failed: 0 };

        return relay(tx, this.dispatcher, claimed, {
          now: () => now,
          baseDelayMs: this.opts.baseDelayMs,
          maxDelayMs: this.opts.maxDelayMs,
        });
      });
    } catch (error) {
      // A failed pass must not kill the worker loop. The rows were not marked,
      // so the next pass picks them up unchanged.
      this.opts.onError?.(error);
      return { delivered: 0, failed: 0 };
    }
  }

  /**
   * Drain until a pass delivers nothing.
   *
   * `maxPasses` is a stop, not a target: without it, a subscriber that fails
   * fast would spin here forever re-claiming rows whose backoff has not elapsed.
   */
  async drainUntilEmpty(maxPasses = 100): Promise<RelayResult> {
    let delivered = 0;
    let failed = 0;
    for (let pass = 0; pass < maxPasses; pass += 1) {
      const result = await this.drainOnce();
      delivered += result.delivered;
      failed += result.failed;
      if (result.delivered === 0) break;
    }
    return { delivered, failed };
  }
}
