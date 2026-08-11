// Cross-cutting ports — interfaces only, no implementations.
//
// Shared because every context publishes events, queues work, and (eventually)
// notifies people. Nothing here imports a domain, so the direction is always
// context -> kernel, never the reverse.

import type { AuthContext } from './auth-context.js';
import type { DomainEvent } from './domain.js';

/* ------------------------------- Event Bus -------------------------------- */

/**
 * Domain events are collected on the aggregate and published AFTER the
 * transaction commits (ADR-0006), so a subscriber can never observe a state
 * that was rolled back.
 *
 * The production implementation will be a transactional outbox: events are
 * written inside the same transaction and relayed by a worker. `publish` is the
 * seam that makes that swap invisible to services.
 */
export interface EventBus {
  publish(events: readonly DomainEvent[]): Promise<void>;
}

/* -------------------------------- Job Queue -------------------------------- */

/** The four priority classes agreed in Document 2 Part VII item 14. */
export type JobPriority = 'INTERACTIVE' | 'STANDARD' | 'BATCH' | 'IDLE';

export interface JobQueue {
  enqueue(
    name: string,
    payload: Record<string, unknown>,
    opts?: { priority?: JobPriority; delayMs?: number; dedupeKey?: string },
  ): Promise<void>;
}

/* ----------------------------- Notification Hub ---------------------------- */

export type NotificationChannel = 'IN_APP' | 'EMAIL' | 'TEAMS' | 'SLACK' | 'SMS' | 'WHATSAPP';

export interface NotificationRequest {
  readonly type: string;
  readonly recipientUserIds: readonly number[];
  readonly title: string;
  readonly body?: string;
  readonly link?: { entityType: string; entityId: number };
  readonly channels?: readonly NotificationChannel[];
}

/**
 * Delivery is a queued job with retry and a dead-letter queue. The legacy
 * notify.js swallowed every failure with `.catch(() => {})`, so email could be
 * broken for every user indefinitely with zero signal.
 *
 * Wired as an EventBus SUBSCRIBER (ADR-0008). No service calls it directly.
 */
export interface NotificationHub {
  dispatch(request: NotificationRequest, ctx: AuthContext): Promise<void>;
}

/* ------------------------------ Audit Timeline ----------------------------- */

export interface TimelineEntry {
  readonly tenantId: number;
  readonly entityType: string;
  readonly entityId: number;
  readonly eventType: string;
  readonly actorId: number | null;
  readonly actorName: string | null;
  readonly occurredAt: Date;
  readonly previousValue: unknown;
  readonly newValue: unknown;
  readonly correlationId?: string;
}

/**
 * Append-only. No update, no delete — enforced by database grants, not by
 * application discipline. Also an EventBus subscriber (ADR-0008).
 */
export interface AuditTimeline {
  record(entries: readonly TimelineEntry[]): Promise<void>;
}

/* --------------------------------- AIService -------------------------------- */

export interface AICompletionRequest {
  readonly capability: string;
  readonly variables: Record<string, unknown>;
  readonly entityRef?: { entityType: string; entityId: number };
}

export interface AIProposal<T = unknown> {
  readonly content: T;
  readonly confidence: number;
  readonly reasoningSummary: string;
  readonly sourcesUsed: readonly string[];
  readonly promptVersionId: string;
  readonly modelId: string;
}

/**
 * AI is advisory. This port returns a proposal; it can never mutate state.
 * There is deliberately no `apply` method — applying a proposal goes through the
 * ordinary domain service, under the ordinary rules, by a named human act.
 */
export interface AIService {
  propose<T = unknown>(
    request: AICompletionRequest,
    ctx: AuthContext,
  ): Promise<AIProposal<T> | null>;
}
