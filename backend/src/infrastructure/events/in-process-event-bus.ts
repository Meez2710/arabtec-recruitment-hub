// The kernel `EventBus` port, implemented over the dispatcher.
//
// Services receive this. In production they will rarely exercise it: the
// repositories drain events into the outbox during `save()`, so a service's
// post-commit `publish(events)` is normally called with an empty array and the
// Unit of Work does the real publishing in its place.
//
// It is NOT dead code. It carries the one case the outbox cannot: an aggregate
// that recorded events and was never saved. Those events have no outbox row, so
// no durable identity, so no deduplication and no retry — best effort, stated
// plainly here rather than discovered later.

import type { EventBus } from '../../modules/shared/kernel/ports.js';
import type { DomainEvent } from '../../modules/shared/kernel/domain.js';
import type { EventEnvelope } from '../db/outbox.js';
import type { EventDispatcher } from './event-dispatcher.js';

export class InProcessEventBus implements EventBus {
  constructor(
    private readonly dispatcher: EventDispatcher,
    private readonly opts: { tenantId?: number } = {},
  ) {}

  async publish(events: readonly DomainEvent[]): Promise<void> {
    if (events.length === 0) return;
    await this.dispatcher.deliverAll(events.map((event) => this.envelope(event)));
  }

  private envelope(event: DomainEvent): EventEnvelope {
    return {
      id: null,
      tenantId: this.opts.tenantId ?? 1,
      // The aggregate is unknown on this path — nothing wrote a row that could
      // record it. Subscribers that need routing facts must read the payload.
      aggregateType: 'Unknown',
      aggregateId: 0,
      event,
      correlationId: null,
    };
  }
}

/** Discards everything. For composition roots that have no subscribers yet. */
export class NoOpEventBus implements EventBus {
  readonly published: DomainEvent[] = [];
  async publish(events: readonly DomainEvent[]): Promise<void> {
    this.published.push(...events);
  }
}
