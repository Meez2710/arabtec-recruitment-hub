// Shared kernel — the vocabulary every bounded context needs and none of them owns.
//
// Before Phase 2.5 these types were declared three times (once per context) and
// AuthContext lived inside Hiring, which meant Interview and Offer imported from
// `hiring/index.js` to get concepts Hiring does not own. That was a false
// dependency: it made Hiring look like a base module rather than a peer.
//
// Nothing here knows about a database, a framework, or any specific context.

/** Who performed an action. Recorded in history and carried on every event. */
export interface Actor {
  readonly id: number;
  readonly name: string;
}

/**
 * Something that happened, past tense.
 *
 * Aggregates create their own events — they know what changed and what the
 * previous value was. Publishers are abstract (see EventBus); an aggregate never
 * learns whether anyone is listening.
 */
export interface DomainEvent {
  readonly type: string;
  readonly at: Date;
  readonly payload: Record<string, unknown>;
}

/** Injected so services stay deterministic under test. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };
