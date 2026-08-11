// Event dispatcher — idempotent fan-out to subscribers (Step 9).
//
// THE EXACTLY-ONCE CLAIM, STATED PRECISELY
//
// Exactly-once DELIVERY is not achievable across a process boundary and this
// code does not pretend otherwise. What is achievable, and what this implements,
// is at-least-once delivery plus exactly-once PROCESSING per subscriber:
//
//   1. The event is durable before anyone tries to deliver it (the outbox).
//   2. Each (subscriber, event) pair runs at most once to COMPLETION, because
//      completion is recorded in `processed_event` and a claim is refused if a
//      row already exists.
//   3. Every event is attempted until some subscriber records completion or an
//      operator intervenes, because a failed row stays unpublished.
//
// The residual window is real and worth naming: a handler that performs its side
// effect and then dies before the ledger INSERT commits will be called again.
// Handlers must therefore be idempotent in their own right — for audit that is
// free (append the same row keyed by event id), for email it means the send must
// be keyed too. Both are subscriber concerns, and both are documented at the
// subscriber.

import { and, eq } from 'drizzle-orm';
import { processedEvent } from '../db/schema/index.js';
import type { EventEnvelope } from '../db/outbox.js';
import type { Executor } from '../db/types.js';
import { PG_ERROR, sqlState } from '../db/errors.js';
import type { ConsumerName, Subscriber, SubscriberRegistry } from './subscriber.js';

export interface DeliveryOutcome {
  readonly envelopeId: number | null;
  /** Subscribers that completed on this attempt. */
  readonly handled: readonly ConsumerName[];
  /** Subscribers that had already processed this event; skipped. */
  readonly skipped: readonly ConsumerName[];
  readonly failures: readonly { consumer: ConsumerName; error: unknown }[];
}

export const isFullyDelivered = (outcome: DeliveryOutcome): boolean =>
  outcome.failures.length === 0;

export interface DispatcherOptions {
  /** Surfaces handler failures without coupling this file to a logger. */
  readonly onHandlerError?: (
    consumer: ConsumerName, envelope: EventEnvelope, error: unknown,
  ) => void;
  readonly now?: () => Date;
}

export class EventDispatcher {
  constructor(
    private readonly db: Executor,
    private readonly registry: SubscriberRegistry,
    private readonly opts: DispatcherOptions = {},
  ) {}

  /**
   * Deliver one event to every interested subscriber.
   *
   * Subscribers are INDEPENDENT. One failing does not stop the others and does
   * not roll back the ones that succeeded — each records its own ledger row. A
   * shared transaction would mean a broken email provider blocked the audit
   * trail, which is precisely backwards: the audit trail is the thing that must
   * never be lost.
   */
  async deliver(envelope: EventEnvelope, on?: Executor): Promise<DeliveryOutcome> {
    const db = on ?? this.db;
    const handled: ConsumerName[] = [];
    const skipped: ConsumerName[] = [];
    const failures: { consumer: ConsumerName; error: unknown }[] = [];

    for (const subscriber of this.registry.interestedIn(envelope.event.type)) {
      try {
        const ran = await this.runOnce(db, subscriber, envelope);
        if (ran) handled.push(subscriber.name);
        else skipped.push(subscriber.name);
      } catch (error) {
        failures.push({ consumer: subscriber.name, error });
        this.opts.onHandlerError?.(subscriber.name, envelope, error);
      }
    }

    return { envelopeId: envelope.id, handled, skipped, failures };
  }

  /**
   * Deliver a batch, preserving order. Order across events is the outbox id order.
   *
   * `on` is the executor the LEDGER writes go to, and it must be the caller's:
   * the polling dispatcher delivers from inside its claim transaction, and
   * writing the ledger on a different handle would put it outside that
   * transaction — so a rolled-back claim would leave events marked processed
   * that were never delivered. It is also the difference between working and
   * deadlocking on a single-connection driver.
   */
  async deliverAll(
    envelopes: readonly EventEnvelope[],
    on?: Executor,
  ): Promise<readonly DeliveryOutcome[]> {
    const outcomes: DeliveryOutcome[] = [];
    for (const envelope of envelopes) outcomes.push(await this.deliver(envelope, on));
    return outcomes;
  }

  /**
   * Run a subscriber unless the ledger says it already did. Returns whether it ran.
   *
   * The claim is an INSERT, not a SELECT-then-INSERT: a read-then-write would
   * leave a window in which two dispatchers both see "not processed" and both
   * run the handler. `ON CONFLICT DO NOTHING` makes the claim atomic — the
   * database decides the winner, and a zero-row result IS the answer.
   *
   * Claim BEFORE the handler, not after. Claiming afterwards would allow a
   * concurrent worker to run the same handler in parallel; the cost of claiming
   * first is that a handler which dies mid-flight is not retried by this path,
   * which is why the residual window above is stated plainly rather than hidden.
   */
  private async runOnce(
    db: Executor, subscriber: Subscriber, envelope: EventEnvelope,
  ): Promise<boolean> {
    // An event with no outbox row (an aggregate that recorded events but was
    // never saved) has no stable identity to key a ledger on. Best-effort
    // delivery, no deduplication — and it cannot be retried either, because
    // nothing durable exists to retry from.
    if (envelope.id === null) {
      await subscriber.handle(envelope);
      return true;
    }

    const claimed = await this.claim(db, subscriber.name, envelope.id);
    if (!claimed) return false;

    try {
      await subscriber.handle(envelope);
      return true;
    } catch (error) {
      // Release the claim so a later attempt can retry. If the release itself
      // fails the ledger row remains and this subscriber will skip the event —
      // visible as a claimed-but-unpublished row, not as silent success.
      await this.release(db, subscriber.name, envelope.id).catch(() => undefined);
      throw error;
    }
  }

  private async claim(
    db: Executor, consumer: ConsumerName, eventId: number,
  ): Promise<boolean> {
    try {
      const inserted = await db
        .insert(processedEvent)
        .values({
          consumer,
          eventId,
          processedAt: this.opts.now?.() ?? new Date(),
        })
        .onConflictDoNothing({ target: [processedEvent.consumer, processedEvent.eventId] })
        .returning({ eventId: processedEvent.eventId });
      return inserted.length > 0;
    } catch (error) {
      // Belt and braces: some drivers surface the conflict rather than
      // swallowing it even with ON CONFLICT. Either way, a duplicate means
      // "already processed", not "failed".
      if (sqlState(error) === PG_ERROR.UNIQUE_VIOLATION) return false;
      throw error;
    }
  }

  private async release(
    db: Executor, consumer: ConsumerName, eventId: number,
  ): Promise<void> {
    await db
      .delete(processedEvent)
      .where(and(eq(processedEvent.consumer, consumer), eq(processedEvent.eventId, eventId)));
  }
}
