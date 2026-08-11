// Notification subscriber.
//
// ADR-0008 again: no service sends an email. It records an event, and this
// decides whether anyone should hear about it.
//
// ⚠️ NOT IDEMPOTENT ON ITS OWN, AND THAT IS THE INTERESTING PART.
//
// The audit subscriber deduplicates for free — same event id, same row, ON
// CONFLICT DO NOTHING. Sending has no such key: a redelivery sends a second
// email. The `processed_event` ledger closes the window for handlers that
// COMPLETE, but a handler that dispatches and then dies before its ledger row
// commits will dispatch again.
//
// So the `NotificationHub` implementation behind this MUST deduplicate on
// `dedupeKey`, which this subscriber derives from the outbox event id. That
// requirement is stated here because it is invisible from the hub's side, and
// the hub is where it has to be honoured.
//
// Routing is currently a table of event type -> recipients-from-payload. It is
// deliberately dumb: "who should be told" is a policy that will move into
// configuration, and building a rules engine before anyone has asked for one
// would be the wrong kind of abstraction.

import type { NotificationHub, NotificationRequest } from '../../../modules/shared/kernel/ports.js';
import { AuthContext } from '../../../modules/shared/kernel/auth-context.js';
import type { EventEnvelope } from '../../../infrastructure/db/outbox.js';
import type { Subscriber } from '../../../infrastructure/events/subscriber.js';

export const NOTIFICATION_CONSUMER = 'notifications';

interface Rule {
  readonly title: (payload: Record<string, unknown>) => string;
  /** Payload keys holding user ids to notify. */
  readonly recipientKeys: readonly string[];
}

const num = (payload: Record<string, unknown>, key: string): number | null => {
  const value = payload[key];
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
};

const str = (payload: Record<string, unknown>, key: string): string =>
  typeof payload[key] === 'string' ? (payload[key] as string) : '';

const RULES: Readonly<Record<string, Rule>> = {
  RequisitionStateChanged: {
    title: (p) => `Requisition ${str(p, 'ticketNo')} is now ${str(p, 'to')}`,
    recipientKeys: ['requesterId', 'recruiterId'],
  },
  RecruiterAssigned: {
    title: () => 'You have been assigned a requisition',
    recipientKeys: ['recruiterId'],
  },
  SeatFilled: {
    title: (p) => `A seat was filled on ${str(p, 'ticketNo')}`,
    recipientKeys: ['requesterId', 'recruiterId'],
  },
  ApplicationStageChanged: {
    title: (p) => `Candidate moved to ${str(p, 'toStage')}`,
    recipientKeys: ['recruiterId'],
  },
  InterviewScheduled: {
    title: () => 'You have been added to an interview panel',
    recipientKeys: ['organiserUserId'],
  },
  OfferSubmittedForApproval: {
    title: (p) => `Offer ${str(p, 'offerNo')} needs your approval`,
    recipientKeys: ['approverId', 'preparedBy'],
  },
  OfferSent: {
    title: (p) => `Offer ${str(p, 'offerNo')} was sent`,
    recipientKeys: ['preparedBy'],
  },
};

export class NotificationSubscriber implements Subscriber {
  readonly name = NOTIFICATION_CONSUMER;
  /** Only the events with a rule. Everything else never reaches the hub. */
  readonly eventTypes = Object.keys(RULES);

  constructor(private readonly hub: NotificationHub) {}

  async handle(envelope: EventEnvelope): Promise<void> {
    const rule = RULES[envelope.event.type];
    if (rule === undefined) return;

    const payload = envelope.event.payload;
    const recipients = [...new Set(
      rule.recipientKeys.map((k) => num(payload, k)).filter((v): v is number => v !== null),
    )];
    // No recipient is a normal outcome, not a failure — an unassigned
    // requisition has no recruiter to tell.
    if (recipients.length === 0) return;

    const request: NotificationRequest = {
      type: envelope.event.type,
      recipientUserIds: recipients,
      title: rule.title(payload),
      link: { entityType: envelope.aggregateType, entityId: envelope.aggregateId },
    };

    // System context: this is not acting on any user's behalf and must not
    // inherit anyone's permissions.
    await this.hub.dispatch(request, AuthContext.system(envelope.tenantId));
  }
}

/**
 * Records dispatches instead of sending. The default until a real hub exists.
 *
 * Not a stub that silently drops — it keeps what it was asked to send, so the
 * health endpoint and the tests can see the subscriber is wired and firing.
 */
export class RecordingNotificationHub implements NotificationHub {
  readonly dispatched: { request: NotificationRequest; tenantId: number }[] = [];

  async dispatch(request: NotificationRequest, ctx: AuthContext): Promise<void> {
    this.dispatched.push({ request, tenantId: ctx.tenantId });
  }
}
