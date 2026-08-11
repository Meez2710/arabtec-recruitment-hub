// Event subscribers — the registry and the contract.
//
// ADR-0008: audit and notifications are SUBSCRIBERS, not service calls. No
// service writes an audit row or sends an email; it records an event, and
// whatever cares reacts. That is what keeps a use case readable and what stops
// "we forgot to audit this one path" from being possible.

import type { EventEnvelope } from '../db/outbox.js';

/**
 * A subscriber's durable name.
 *
 * It is the ledger key in `processed_event.consumer`, so renaming one makes
 * every past event look unprocessed and REPLAYS THE ENTIRE HISTORY at it. Names
 * are permanent; treat a rename as a new subscriber plus a backfill decision.
 */
export type ConsumerName = string;

export interface Subscriber {
  readonly name: ConsumerName;
  /** Event types this subscriber wants. Empty means all of them. */
  readonly eventTypes?: readonly string[];
  /**
   * Handle ONE event.
   *
   * Must be safe to call more than once for the same event: delivery is
   * at-least-once and the ledger closes the gap only for handlers that complete.
   * A handler that dies after its side effect but before the ledger write will
   * be called again.
   */
  handle(envelope: EventEnvelope): Promise<void>;
}

export class SubscriberRegistry {
  private readonly subscribers = new Map<ConsumerName, Subscriber>();

  register(subscriber: Subscriber): this {
    if (this.subscribers.has(subscriber.name)) {
      // Two subscribers under one name would share a ledger key, so the second
      // would silently never run for events the first had already processed.
      throw new Error(`Subscriber "${subscriber.name}" is already registered.`);
    }
    this.subscribers.set(subscriber.name, subscriber);
    return this;
  }

  /** Registration order is delivery order — deterministic, not Map-iteration luck. */
  interestedIn(eventType: string): readonly Subscriber[] {
    return [...this.subscribers.values()].filter(
      (s) => s.eventTypes === undefined || s.eventTypes.includes(eventType),
    );
  }

  get names(): readonly ConsumerName[] {
    return [...this.subscribers.keys()];
  }
}
