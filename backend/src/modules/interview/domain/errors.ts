// Domain errors for the Interview context. Same shape and contract as Hiring:
// a stable machine `code` the HTTP layer maps once.

export type InterviewErrorCode =
  | 'ILLEGAL_INTERVIEW_TRANSITION'
  | 'PANEL_REQUIRED'
  | 'NOT_A_PANELLIST'
  | 'ASSESSMENT_NOT_ALLOWED'
  | 'DUPLICATE_ASSESSMENT'
  | 'INVALID_SCORE'
  | 'SLOT_IN_PAST'
  | 'REASON_REQUIRED';

export abstract class InterviewDomainError extends Error {
  abstract readonly code: InterviewErrorCode;
  readonly details: Record<string, unknown>;
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = new.target.name;
    this.details = details;
  }
}

export class IllegalInterviewTransitionError extends InterviewDomainError {
  readonly code = 'ILLEGAL_INTERVIEW_TRANSITION' as const;
  constructor(from: string, to: string) {
    super(`Cannot move an interview from '${from}' to '${to}'.`, { from, to });
  }
}

/** An interview with no interviewer cannot happen. */
export class PanelRequiredError extends InterviewDomainError {
  readonly code = 'PANEL_REQUIRED' as const;
  constructor() {
    super('At least one interviewer must be on the panel.');
  }
}

export class NotAPanellistError extends InterviewDomainError {
  readonly code = 'NOT_A_PANELLIST' as const;
  constructor(userId: number) {
    super('Only assigned panel members may submit feedback for this interview.', { userId });
  }
}

/**
 * Feedback is blocked on cancelled and no-show interviews.
 * The legacy form accepted feedback for an interview that never happened, and
 * then folded it into the aggregate outcome shown on the candidate profile (BL-17).
 */
export class AssessmentNotAllowedError extends InterviewDomainError {
  readonly code = 'ASSESSMENT_NOT_ALLOWED' as const;
  constructor(status: string) {
    super(`Feedback cannot be recorded for a ${status.toLowerCase()} interview.`, { status });
  }
}

export class DuplicateAssessmentError extends InterviewDomainError {
  readonly code = 'DUPLICATE_ASSESSMENT' as const;
  constructor(userId: number) {
    super('You have already submitted feedback for this interview. Update it instead.', { userId });
  }
}

export class InvalidScoreError extends InterviewDomainError {
  readonly code = 'INVALID_SCORE' as const;
  constructor(criterionKey: string, value: unknown) {
    super(`'${String(value)}' is not a valid score for '${criterionKey}'.`, { criterionKey, value });
  }
}

export class SlotInPastError extends InterviewDomainError {
  readonly code = 'SLOT_IN_PAST' as const;
  constructor(startsAt: Date) {
    super('An interview cannot be scheduled in the past.', { startsAt: startsAt.toISOString() });
  }
}

export class InterviewReasonRequiredError extends InterviewDomainError {
  readonly code = 'REASON_REQUIRED' as const;
  constructor(action: string) {
    super(`A reason is required to ${action} an interview.`, { action });
  }
}
