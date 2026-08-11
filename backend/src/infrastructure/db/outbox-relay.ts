// Outbox relay — the read side.
//
// TWO CALLERS, ONE PATH.
//
//   * The Unit of Work calls `relay()` immediately after commit, with the
//     envelopes it just wrote. This is the fast path: in the normal case an
//     event is delivered milliseconds after the transaction commits and the row
//     is marked published before any poll ever sees it.
//
//   * `OutboxDispatcher` polls for whatever the fast path did not manage —
//     because the process died, a subscriber threw, or the event was written by
//     a worker with no relay attached.
//
// Both go through the SAME `EventDispatcher`, so both consult the same
// `processed_event` ledger. That is what stops the two paths from delivering an
// event twice: whichever gets there first claims the (consumer, event) pair and
// the other skips it.

import { markPublished, recordFailure } from './outbox.js';
import type { EventEnvelope } from './outbox.js';
import type { Executor } from './types.js';
import { isFullyDelivered } from '../events/event-dispatcher.js';
import type { EventDispatcher } from '../events/event-dispatcher.js';
import type { PostCommitRelay } from './transactional-outbox.js';

export interface RelayOptions {
  readonly now?: () => Date;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
}

export interface RelayResult {
  readonly delivered: number;
  readonly failed: number;
}

/**
 * Deliver envelopes and settle their rows.
 *
 * A row is marked published only when EVERY interested subscriber either
 * completed or had already completed. One failure leaves the row pending, so it
 * is retried — and the subscribers that did succeed skip it on the retry via the
 * ledger. Partial progress is never lost and never repeated.
 *
 * Marking happens OUTSIDE any transaction the caller may hold: the state change
 * is already committed, and coupling delivery bookkeeping to a live transaction
 * would let a slow subscriber hold row locks.
 */
export const relay = async (
  db: Executor,
  dispatcher: EventDispatcher,
  envelopes: readonly EventEnvelope[],
  opts: RelayOptions = {},
): Promise<RelayResult> => {
  if (envelopes.length === 0) return { delivered: 0, failed: 0 };

  const now = opts.now?.() ?? new Date();
  // Ledger writes go to the caller's handle — inside the claim transaction for
  // the polling dispatcher, on the root handle for the post-commit fast path.
  const outcomes = await dispatcher.deliverAll(envelopes, db);

  const settled: number[] = [];
  let failed = 0;

  for (const outcome of outcomes) {
    if (outcome.envelopeId === null) continue;
    if (isFullyDelivered(outcome)) {
      settled.push(outcome.envelopeId);
    } else {
      failed += 1;
      await recordFailure(db, outcome.envelopeId, outcome.failures[0]?.error, {
        now,
        baseDelayMs: opts.baseDelayMs ?? 1_000,
        maxDelayMs: opts.maxDelayMs ?? 300_000,
      });
    }
  }

  await markPublished(db, settled, now);
  return { delivered: settled.length, failed };
};

/**
 * Bind a relay to a database handle and a dispatcher.
 *
 * Note the handle: the ROOT one, never a transaction. The relay runs after
 * commit, and holding the committed transaction open across subscriber calls
 * would let a slow email provider keep row locks.
 */
export const createPostCommitRelay = (
  db: Executor,
  dispatcher: EventDispatcher,
  opts: RelayOptions = {},
): PostCommitRelay =>
  async (envelopes) => { await relay(db, dispatcher, envelopes, opts); };
