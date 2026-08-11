// Talent event catalogue. Emitted by constant, never by string literal.

export const TALENT_EVENTS = {
  CANDIDATE_CREATED: 'CandidateCreated',
  CANDIDATE_UPDATED: 'CandidateUpdated',
  CANDIDATE_STATE_CHANGED: 'CandidateStateChanged',
  CANDIDATE_OWNER_ASSIGNED: 'CandidateOwnerAssigned',
  DOCUMENT_ATTACHED: 'CandidateDocumentAttached',
  DOCUMENT_REMOVED: 'CandidateDocumentRemoved',

  /** A human accepted fields from a proposal. Carries taskId + modelId. */
  CANDIDATE_AI_FIELDS_APPROVED: 'CandidateAIFieldsApproved',

  /**
   * Proposal lifecycle. Emitted by the proposal aggregate, which exists whether
   * or not an AI provider does — a proposal can equally come from a bulk import.
   */
  PROPOSAL_RAISED: 'CandidateProposalRaised',
  PROPOSAL_RESOLVED: 'CandidateProposalResolved',

  /** Bulk CV intake — staging, not candidate creation. */
  INTAKE_BATCH_OPENED: 'CvIntakeBatchOpened',
  INTAKE_BATCH_CLOSED: 'CvIntakeBatchClosed',
  INTAKE_ITEM_PARSED: 'CvIntakeItemParsed',
  INTAKE_ITEM_PARSE_FAILED: 'CvIntakeItemParseFailed',
  INTAKE_ITEM_CONVERTED: 'CvIntakeItemConverted',
  INTAKE_ITEM_DISCARDED: 'CvIntakeItemDiscarded',
} as const;

export type TalentEventType = (typeof TALENT_EVENTS)[keyof typeof TALENT_EVENTS];
export const TALENT_EVENT_TYPES: readonly TalentEventType[] = Object.values(TALENT_EVENTS);
