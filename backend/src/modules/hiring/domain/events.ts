// Formal event catalogue for the Hiring context.
//
// Aggregates emit these by constant, never by string literal, so a typo cannot
// produce an event no subscriber is listening for. `hiring-events.test.ts`
// asserts that every type an aggregate actually emits appears here — the catalogue
// and the emitters cannot drift.
//
// Payload contract: an event carries everything a subscriber needs to act
// WITHOUT a follow-up query. `SeatFilled` therefore includes filled/headcount/
// fillState, because notification, timeline and read-model invalidation all
// need them and none should have to re-read the aggregate.

export const HIRING_EVENTS = {
  /* ------------------------------ requisition ------------------------------ */
  REQUISITION_CREATED: 'RequisitionCreated',
  REQUISITION_STATE_CHANGED: 'RequisitionStateChanged',
  REQUISITION_UPDATED: 'RequisitionUpdated',
  REQUISITION_REOPENED: 'RequisitionReopened',
  RECRUITER_ASSIGNED: 'RecruiterAssigned',
  HEADCOUNT_ADJUSTED: 'HeadcountAdjusted',
  SEAT_FILLED: 'SeatFilled',
  SEAT_RELEASED: 'SeatReleased',

  /* ------------------------------ application ------------------------------ */
  APPLICATION_CREATED: 'ApplicationCreated',
  APPLICATION_STAGE_CHANGED: 'ApplicationStageChanged',
  APPLICATION_RESUMED: 'ApplicationResumed',
  APPLICATION_RECRUITER_ASSIGNED: 'ApplicationRecruiterAssigned',
  HIRE_REVERSED: 'HireReversed',
  NEXT_ACTION_SET: 'NextActionSet',
} as const;

export type HiringEventType = (typeof HIRING_EVENTS)[keyof typeof HIRING_EVENTS];

/** Every type in the catalogue, for validation and subscriber registration. */
export const HIRING_EVENT_TYPES: readonly HiringEventType[] = Object.values(HIRING_EVENTS);

export function isHiringEventType(type: string): type is HiringEventType {
  return (HIRING_EVENT_TYPES as readonly string[]).includes(type);
}

/**
 * Which events a subscriber should treat as user-visible activity.
 *
 * The timeline records everything; notifications and the activity feed use this
 * subset so a headcount tweak does not read as loudly as a hire.
 */
export const SIGNIFICANT_HIRING_EVENTS: readonly HiringEventType[] = [
  HIRING_EVENTS.REQUISITION_CREATED,
  HIRING_EVENTS.REQUISITION_STATE_CHANGED,
  HIRING_EVENTS.REQUISITION_UPDATED,
  HIRING_EVENTS.REQUISITION_REOPENED,
  HIRING_EVENTS.RECRUITER_ASSIGNED,
  HIRING_EVENTS.SEAT_FILLED,
  HIRING_EVENTS.SEAT_RELEASED,
  HIRING_EVENTS.APPLICATION_CREATED,
  HIRING_EVENTS.APPLICATION_STAGE_CHANGED,
  HIRING_EVENTS.HIRE_REVERSED,
];
