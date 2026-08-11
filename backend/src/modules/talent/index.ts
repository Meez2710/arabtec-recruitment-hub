// Public surface of the Talent module.
//
// Repository adapters live inside this module, so aggregate internals
// (CandidateProps, CandidateProposalProps) are deliberately NOT exported.

export { CandidateService, TALENT_PERMISSIONS } from './application/candidate-service.js';
export type {
  CandidateServiceDeps, CandidateSummary, CreateCandidateResult, DuplicateWarning,
} from './application/candidate-service.js';

export { CvIntakeService } from './application/intake-service.js';
export type {
  ConvertResult, CvIntakeServiceDeps, IntakeBatchSummary, IntakeItemSummary, UploadedFile,
} from './application/intake-service.js';

export { ProposalService } from './application/proposal-service.js';
export type {
  ProposalServiceDeps, ProposalSummary, ReviewResult,
} from './application/proposal-service.js';

export type {
  CandidateProposalRepository, CandidateRepository, CvIntakeBatchRepository, DocumentStore,
  TalentTransactionScope, TalentUnitOfWork,
} from './application/ports.js';

export { CANDIDATE_STATES, DOCUMENT_TYPES, PROPOSABLE_FIELDS, isProposableField } from './domain/candidate.js';
export type { CandidatePatch, CandidateState, DocumentType } from './domain/candidate.js';

export { INTAKE_BATCH_STATUSES, INTAKE_ITEM_STATUSES } from './domain/cv-intake.js';
export type {
  IntakeBatchStatus, IntakeField, IntakeItem, IntakeItemStatus,
} from './domain/cv-intake.js';

export { PROPOSAL_STATUSES } from './domain/proposal.js';
export type { ProposalGeneration, ProposalStatus } from './domain/proposal.js';

export { FIELD_SOURCES, sourceOf, aiApprovedFields } from './domain/provenance.js';
export type { FieldProvenance, FieldSource, ProvenanceMap } from './domain/provenance.js';

export { TALENT_EVENTS, TALENT_EVENT_TYPES } from './domain/events.js';
export type { TalentEventType } from './domain/events.js';

export {
  CandidateNotEditableError, ContactRequiredError, DocumentNotFoundError,
  DuplicateDocumentError, IllegalCandidateStateError, InvalidCandidateFieldError,
  IntakeBatchClosedError, IntakeItemNotConvertibleError, IntakeItemNotFoundError,
  InvalidDocumentTypeError, ProposalAlreadyResolvedError, TalentDomainError,
  UnknownProposalFieldError,
} from './domain/errors.js';
export type { TalentErrorCode } from './domain/errors.js';
