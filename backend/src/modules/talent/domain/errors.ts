// Talent domain errors. Same shape as the other contexts (code + details), and
// a separate base class for the same reason they have one.

export type TalentErrorCode =
  | 'CANDIDATE_NOT_EDITABLE'
  | 'DOCUMENT_NOT_FOUND'
  | 'DUPLICATE_DOCUMENT'
  | 'INVALID_CANDIDATE_FIELD'
  | 'INVALID_DOCUMENT_TYPE'
  | 'PROPOSAL_ALREADY_RESOLVED'
  | 'PROPOSAL_FIELD_UNKNOWN'
  | 'CANDIDATE_STATE_TRANSITION'
  | 'CONTACT_REQUIRED'
  | 'INTAKE_BATCH_CLOSED'
  | 'INTAKE_ITEM_NOT_FOUND'
  | 'INTAKE_ITEM_NOT_CONVERTIBLE';

export abstract class TalentDomainError extends Error {
  abstract readonly code: TalentErrorCode;
  readonly details: Record<string, unknown>;
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = new.target.name;
    this.details = details;
  }
}

/** Editing is blocked once a candidate is erased or merged away. */
export class CandidateNotEditableError extends TalentDomainError {
  readonly code = 'CANDIDATE_NOT_EDITABLE' as const;
  constructor(state: string) {
    super(`A candidate in state '${state}' cannot be edited.`, { state });
  }
}

export class InvalidCandidateFieldError extends TalentDomainError {
  readonly code = 'INVALID_CANDIDATE_FIELD' as const;
  constructor(field: string, why: string) {
    super(`${field} is invalid: ${why}`, { field, why });
  }
}

/**
 * A candidate needs at least one way to be contacted.
 *
 * Not an arbitrary rule: a talent pool record nobody can reach is a GDPR
 * liability with no business value — you hold personal data you cannot act on.
 */
export class ContactRequiredError extends TalentDomainError {
  readonly code = 'CONTACT_REQUIRED' as const;
  constructor() {
    super('A candidate needs at least an email or a phone number.');
  }
}

export class InvalidDocumentTypeError extends TalentDomainError {
  readonly code = 'INVALID_DOCUMENT_TYPE' as const;
  constructor(docType: string) {
    super(`'${docType}' is not a recognised document type.`, { docType });
  }
}

export class DocumentNotFoundError extends TalentDomainError {
  readonly code = 'DOCUMENT_NOT_FOUND' as const;
  constructor(documentId: string) {
    super('That document is not attached to this candidate.', { documentId });
  }
}

/** Same bytes already attached — dedup by content hash, not by filename. */
export class DuplicateDocumentError extends TalentDomainError {
  readonly code = 'DUPLICATE_DOCUMENT' as const;
  constructor(fileHash: string) {
    super('That exact file is already attached to this candidate.', { fileHash });
  }
}

export class IllegalCandidateStateError extends TalentDomainError {
  readonly code = 'CANDIDATE_STATE_TRANSITION' as const;
  constructor(from: string, to: string) {
    super(`Cannot move a candidate from '${from}' to '${to}'.`, { from, to });
  }
}

export class ProposalAlreadyResolvedError extends TalentDomainError {
  readonly code = 'PROPOSAL_ALREADY_RESOLVED' as const;
  constructor(status: string) {
    super(`This proposal has already been ${status.toLowerCase()}.`, { status });
  }
}

export class UnknownProposalFieldError extends TalentDomainError {
  readonly code = 'PROPOSAL_FIELD_UNKNOWN' as const;
  constructor(field: string) {
    super(`'${field}' is not a field this proposal offers.`, { field });
  }
}

/* ------------------------------- CV intake -------------------------------- */

export class IntakeBatchClosedError extends TalentDomainError {
  readonly code = 'INTAKE_BATCH_CLOSED' as const;
  constructor(status: string) {
    super(`This intake batch is ${status.toLowerCase()} and can no longer be changed.`, { status });
  }
}

export class IntakeItemNotFoundError extends TalentDomainError {
  readonly code = 'INTAKE_ITEM_NOT_FOUND' as const;
  constructor(itemId: string) {
    super('That file is not part of this intake batch.', { itemId });
  }
}

export class IntakeItemNotConvertibleError extends TalentDomainError {
  readonly code = 'INTAKE_ITEM_NOT_CONVERTIBLE' as const;
  constructor(itemId: string, status: string) {
    super(`A file in state '${status}' cannot be converted.`, { itemId, status });
  }
}
