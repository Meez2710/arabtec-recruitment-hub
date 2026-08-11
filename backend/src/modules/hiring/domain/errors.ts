// Domain error taxonomy for the Hiring context.
//
// Every failure a domain rule can produce is a typed error carrying a stable
// machine `code`. The HTTP layer maps code -> status once; nothing in the domain
// knows about HTTP. Closes Audit #1 F-18 (no error taxonomy) for this context.

export type DomainErrorCode =
  | 'ILLEGAL_TRANSITION'
  | 'REASON_REQUIRED'
  | 'NO_OPEN_SEAT'
  | 'CANDIDATE_ALREADY_HIRED'
  | 'REQUISITION_NOT_OPEN'
  | 'SELF_APPROVAL_FORBIDDEN'
  | 'HEADCOUNT_BELOW_FILLED'
  | 'OUTSTANDING_OFFER'
  | 'INVALID_ENTRY_STAGE'
  | 'SEAT_NOT_FILLED'
  | 'INVARIANT_VIOLATION';

export abstract class DomainError extends Error {
  abstract readonly code: DomainErrorCode;
  readonly details: Record<string, unknown>;

  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = new.target.name;
    this.details = details;
  }
}

/** A state change the transition map does not permit. */
export class IllegalTransitionError extends DomainError {
  readonly code = 'ILLEGAL_TRANSITION' as const;
  constructor(from: string, to: string, subject: string) {
    super(`Cannot move ${subject} from '${from}' to '${to}'.`, { from, to, subject });
  }
}

/** A transition whose target stage requires a reason that was not supplied. */
export class MissingReasonError extends DomainError {
  readonly code = 'REASON_REQUIRED' as const;
  constructor(to: string, field: string) {
    super(`A reason is required to set '${to}'.`, { to, field });
  }
}

/** Every seat on the requisition is filled or cancelled. Overfill protection. */
export class NoOpenSeatError extends DomainError {
  readonly code = 'NO_OPEN_SEAT' as const;
  constructor(requisitionId: number) {
    super('All vacancies for this request are already filled.', { requisitionId });
  }
}

/** Invariant H5 — one candidate may hold at most one filled seat. */
export class CandidateAlreadyHiredError extends DomainError {
  readonly code = 'CANDIDATE_ALREADY_HIRED' as const;
  constructor(candidateId: number) {
    super('This candidate has already been hired against an active requisition.', { candidateId });
  }
}

/** Pipeline work attempted against a requisition that is not OPEN. */
export class RequisitionNotOpenError extends DomainError {
  readonly code = 'REQUISITION_NOT_OPEN' as const;
  constructor(status: string, action: string) {
    super(`Cannot ${action} while the requisition is '${status}'.`, { status, action });
  }
}

/** Segregation of duties — the approver may not be the requester or creator. */
export class SelfApprovalError extends DomainError {
  readonly code = 'SELF_APPROVAL_FORBIDDEN' as const;
  constructor() {
    super('You cannot approve or reject a requisition you raised.');
  }
}

/**
 * Invariant H2 — headcount may never drop below the seats already committed.
 * Committed = filled (people) + cancelled (the record of a closed cycle).
 */
export class HeadcountBelowFilledError extends DomainError {
  readonly code = 'HEADCOUNT_BELOW_FILLED' as const;
  constructor(requested: number, committed: number) {
    super(
      `Headcount cannot be set to ${requested}; ${committed} seat(s) are already committed.`,
      { requested, committed },
    );
  }
}

/** A requisition cannot be closed while a candidate holds a live offer. */
export class OutstandingOfferError extends DomainError {
  readonly code = 'OUTSTANDING_OFFER' as const;
  constructor(applicationIds: number[]) {
    super(
      'This requisition has candidates holding sent offers. Resolve those offers before closing.',
      { applicationIds },
    );
  }
}

/** Applications may only be created at an entry stage. Closes BL-03. */
export class InvalidEntryStageError extends DomainError {
  readonly code = 'INVALID_ENTRY_STAGE' as const;
  constructor(stage: string, allowed: readonly string[]) {
    super(`An application cannot be created at '${stage}'.`, { stage, allowed });
  }
}

/** Attempted to release a seat that is not currently filled. */
export class SeatNotFilledError extends DomainError {
  readonly code = 'SEAT_NOT_FILLED' as const;
  constructor(applicationId: number) {
    super('This application does not currently occupy a filled seat.', { applicationId });
  }
}

/**
 * A guard that should be unreachable. Thrown when the aggregate detects its own
 * state is inconsistent — surfaces corruption loudly instead of propagating it.
 */
export class InvariantViolationError extends DomainError {
  readonly code = 'INVARIANT_VIOLATION' as const;
  constructor(invariant: string, detail: string) {
    super(`Invariant ${invariant} violated: ${detail}`, { invariant });
  }
}
