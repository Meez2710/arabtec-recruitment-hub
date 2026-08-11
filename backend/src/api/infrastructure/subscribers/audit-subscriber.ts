// Audit subscriber — finally fills `timeline_entry`.
//
// ADR-0008: audit is a SUBSCRIBER, not a service call. No service writes an
// audit row. That is what makes "we forgot to audit this one path" impossible
// rather than merely unlikely — if an operation records an event, it is
// audited, and every operation records events.
//
// The legacy `writeAudit()` swallowed its own failures, so the trail had holes
// nobody could see. This one throws. A throw leaves the outbox row unpublished
// with `last_error` set, which is a visible backlog: the trail either has the
// entry or an operator can see exactly why it does not.
//
// IDEMPOTENT BY CONSTRUCTION. The insert is keyed on the outbox event id, so a
// redelivery after a crash writes nothing new. This matters more here than
// anywhere else: the dispatcher claims before it runs the handler, so a handler
// that dies mid-flight WILL be called again.

import { and, eq, sql } from 'drizzle-orm';
import { timelineEntry } from '../../../infrastructure/db/schema/index.js';
import type { Executor } from '../../../infrastructure/db/types.js';
import type { EventEnvelope } from '../../../infrastructure/db/outbox.js';
import type { Subscriber } from '../../../infrastructure/events/subscriber.js';

export const AUDIT_CONSUMER = 'audit-timeline';

/**
 * Payload keys the timeline treats as the actor.
 *
 * Events carry the acting user under a few different names because they were
 * written for their own readers, not for this. Reading several is honest;
 * renaming them in the domain to suit a subscriber would be the tail wagging
 * the dog.
 */
const ACTOR_KEYS = ['by', 'actorId', 'movedBy', 'assignedBy'] as const;

const readActorId = (payload: Record<string, unknown>): number | null => {
  for (const key of ACTOR_KEYS) {
    const value = payload[key];
    if (typeof value === 'number' && Number.isInteger(value)) return value;
  }
  return null;
};

const readActorName = (payload: Record<string, unknown>): string | null => {
  const value = payload['actorName'];
  return typeof value === 'string' && value.length > 0 ? value : null;
};

/**
 * Split the payload into before/after where the event carries both.
 *
 * `previous_value` and `new_value` are NOT NULL by design, so an event with
 * nothing to say records `{}` rather than a missing column.
 */
const splitValues = (
  payload: Record<string, unknown>,
): { previous: Record<string, unknown>; next: Record<string, unknown> } => {
  const previous: Record<string, unknown> = {};
  const next: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(payload)) {
    if (key === 'before' && typeof value === 'object' && value !== null) {
      Object.assign(previous, value);
    } else if (key === 'after' && typeof value === 'object' && value !== null) {
      Object.assign(next, value);
    } else if (key.startsWith('from') && key.length > 4) {
      previous[key.slice(4, 5).toLowerCase() + key.slice(5)] = value;
    } else if (key.startsWith('to') && key.length > 2) {
      next[key.slice(2, 3).toLowerCase() + key.slice(3)] = value;
    } else {
      next[key] = value;
    }
  }
  return { previous, next };
};

export class AuditSubscriber implements Subscriber {
  readonly name = AUDIT_CONSUMER;

  constructor(private readonly db: Executor) {}

  async handle(envelope: EventEnvelope): Promise<void> {
    const payload = envelope.event.payload;
    const { previous, next } = splitValues(payload);

    await this.db
      .insert(timelineEntry)
      .values({
        tenantId: envelope.tenantId,
        entityType: envelope.aggregateType,
        entityId: envelope.aggregateId,
        eventType: envelope.event.type,
        actorId: readActorId(payload),
        actorName: readActorName(payload),
        occurredAt: envelope.event.at,
        previousValue: previous,
        newValue: next,
        correlationId: envelope.correlationId,
        // Reuse the outbox id as the request key: it is unique per event and it
        // is what makes redelivery a no-op instead of a duplicate row.
        requestId: envelope.id === null ? null : `outbox:${envelope.id}`,
      })
      .onConflictDoNothing();
  }

  /** Read an entity's history. Used by the timeline endpoint. */
  async timelineFor(
    tenantId: number,
    entityType: string,
    entityId: number,
    limit = 100,
  ): Promise<readonly (typeof timelineEntry.$inferSelect)[]> {
    return this.db
      .select()
      .from(timelineEntry)
      .where(and(
        eq(timelineEntry.tenantId, tenantId),
        eq(timelineEntry.entityType, entityType),
        eq(timelineEntry.entityId, entityId),
      ))
      .orderBy(sql`${timelineEntry.occurredAt} desc, ${timelineEntry.id} desc`)
      .limit(limit);
  }
}
