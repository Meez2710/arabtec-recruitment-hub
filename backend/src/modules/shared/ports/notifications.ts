// Notification and calendar contracts — interfaces only, no implementations.
//
// Shared across bounded contexts, so they live in `modules/shared/` rather than
// inside one of them. Nothing here imports a domain.
//
// Delivery is always a queued job with retry and a dead-letter queue. The legacy
// notify.js called `sendMail(...).catch(() => {})` — email could be broken for
// every user indefinitely with zero signal. A provider that swallows its own
// failures does not satisfy these contracts.

export interface Recipient {
  readonly userId?: number;
  readonly email?: string;
  readonly phone?: string;
  readonly displayName?: string;
}

export interface Attachment {
  readonly filename: string;
  readonly mimeType: string;
  /** Storage key. Bytes are resolved by the provider, never carried in the payload. */
  readonly storageKey: string;
}

export type DeliveryStatus = 'QUEUED' | 'SENT' | 'FAILED' | 'SUPPRESSED';

export interface DeliveryReceipt {
  readonly channel: string;
  readonly status: DeliveryStatus;
  readonly providerMessageId?: string;
  readonly failureReason?: string;
}

/* ---------------------------------- Email ---------------------------------- */

export interface EmailMessage {
  readonly to: readonly Recipient[];
  readonly cc?: readonly Recipient[];
  readonly subject: string;
  readonly html: string;
  readonly text?: string;
  readonly attachments?: readonly Attachment[];
  /** Threads related messages (offer sent -> reminder -> outcome) in the client. */
  readonly threadKey?: string;
}

export interface EmailProvider {
  readonly id: string;
  send(message: EmailMessage): Promise<DeliveryReceipt>;
}

/* ----------------------------------- SMS ----------------------------------- */

export interface SmsMessage {
  readonly to: Recipient;
  readonly body: string;
}

export interface SmsProvider {
  readonly id: string;
  send(message: SmsMessage): Promise<DeliveryReceipt>;
}

/* --------------------------------- Calendar -------------------------------- */

export interface TimeSlot {
  readonly startsAt: Date;
  readonly endsAt: Date;
}

export interface BusySlot extends TimeSlot {
  readonly userId: number;
}

export interface CalendarEventRequest {
  readonly title: string;
  readonly description?: string;
  readonly slot: TimeSlot;
  readonly organiserUserId: number;
  readonly attendees: readonly Recipient[];
  readonly location?: string;
  /** Provider-generated when omitted (Meet / Teams link). */
  readonly conferenceLink?: string;
}

export interface CalendarEventHandle {
  /** Provider event id, stored from V1 so internal events can be bound later. */
  readonly externalEventId: string;
  readonly joinUrl?: string;
  /** RFC 5545 payload, so an internal-only provider still produces real invites. */
  readonly icsContent?: string;
}

/**
 * One interface, three implementations planned: internal (.ics only, V1),
 * Google, Microsoft 365. Swapping is an adapter change, not a redesign.
 */
export interface CalendarProvider {
  readonly id: string;
  getFreeBusy(userIds: readonly number[], window: TimeSlot): Promise<readonly BusySlot[]>;
  createEvent(request: CalendarEventRequest): Promise<CalendarEventHandle>;
  updateEvent(externalEventId: string, request: CalendarEventRequest): Promise<CalendarEventHandle>;
  cancelEvent(externalEventId: string, reason?: string): Promise<void>;
}

/* ---------------------------- Internal (in-app) ---------------------------- */

export interface InternalNotification {
  readonly userId: number;
  readonly type: string;
  readonly title: string;
  readonly body?: string;
  readonly link?: { entityType: string; entityId: number };
}

export interface InternalNotificationProvider {
  readonly id: string;
  push(notification: InternalNotification): Promise<DeliveryReceipt>;
}

/* --------------------------------- Dispatch -------------------------------- */

export type NotificationChannelId = 'IN_APP' | 'EMAIL' | 'SMS' | 'TEAMS' | 'SLACK' | 'WHATSAPP';

/**
 * The hub resolves per-user channel preferences and fans out to registered
 * providers. Callers name an event, not a channel — which channels fire is a
 * preference, not a decision the calling service makes.
 */
export interface NotificationDispatch {
  readonly eventType: string;
  readonly recipients: readonly Recipient[];
  readonly title: string;
  readonly body?: string;
  readonly link?: { entityType: string; entityId: number };
  /** Overrides user preference. Reserve for operationally mandatory messages. */
  readonly forceChannels?: readonly NotificationChannelId[];
}
