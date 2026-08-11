// Domain errors for the Offer context.

export type OfferErrorCode =
  | 'LIVE_OFFER_EXISTS'
  | 'ILLEGAL_OFFER_TRANSITION'
  | 'COMPENSATION_LOCKED'
  | 'UNKNOWN_COMPONENT'
  | 'OFFER_SELF_APPROVAL_FORBIDDEN'
  | 'OFFER_REASON_REQUIRED';

export abstract class OfferDomainError extends Error {
  abstract readonly code: OfferErrorCode;
  readonly details: Record<string, unknown>;
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = new.target.name;
    this.details = details;
  }
}

export class IllegalOfferTransitionError extends OfferDomainError {
  readonly code = 'ILLEGAL_OFFER_TRANSITION' as const;
  constructor(from: string, to: string) {
    super(`Cannot move an offer from '${from}' to '${to}'.`, { from, to });
  }
}

/** BL-10 — compensation is frozen once the candidate holds the letter. */
export class CompensationLockedError extends OfferDomainError {
  readonly code = 'COMPENSATION_LOCKED' as const;
  constructor(status: string) {
    super(
      `Compensation cannot be changed on a ${status.toLowerCase()} offer. Withdraw and re-issue instead.`,
      { status },
    );
  }
}

/** Components are configurable data; an unknown code is a configuration error. */
export class UnknownComponentError extends OfferDomainError {
  readonly code = 'UNKNOWN_COMPONENT' as const;
  constructor(componentCode: string) {
    super(`'${componentCode}' is not a configured compensation component.`, { componentCode });
  }
}

/** BL-12 — the preparer may not approve their own offer. */
export class OfferSelfApprovalError extends OfferDomainError {
  readonly code = 'OFFER_SELF_APPROVAL_FORBIDDEN' as const;
  constructor(message = 'You cannot approve an offer you prepared.') {
    super(message);
  }
}

/**
 * One live offer per application. Previously this reused StaleAggregateError,
 * which told the caller the wrong thing entirely.
 */
export class LiveOfferExistsError extends OfferDomainError {
  readonly code = 'LIVE_OFFER_EXISTS' as const;
  constructor(applicationId: number, existingOfferId: number) {
    super(
      'This application already has a live offer. Withdraw it before drafting another.',
      { applicationId, existingOfferId },
    );
  }
}

export class OfferReasonRequiredError extends OfferDomainError {
  readonly code = 'OFFER_REASON_REQUIRED' as const;
  constructor(action: string) {
    super(`A reason is required to ${action} an offer.`, { action });
  }
}
